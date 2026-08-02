// One pipeline serves the ordered effect registry. Each pass gets its own
// uniform buffer and samples the previous pass, allowing an arbitrary stack
// without recompiling pipelines or reading and writing the same texture.
export const SHADER_EFFECT_WGSL: string = /* wgsl */ `
@group(0) @binding(0) var terminal_image: texture_2d<f32>;
@group(0) @binding(1) var terminal_sampler: sampler;

struct EffectConfig {
  mode: u32,
  frame: u32,
  effect_index: u32,
  effect_count: u32,
  resolution: vec2f,
  time: f32,
  time_delta: f32,
  cursor: vec4f,
}
@group(0) @binding(2) var<uniform> effect: EffectConfig;

@vertex fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

fn sample_image(uv: vec2f) -> vec4f {
  return textureSample(terminal_image, terminal_sampler, clamp(uv, vec2f(0.0), vec2f(1.0)));
}

fn straight_rgb(sampled: vec4f) -> vec3f {
  if (sampled.a <= 0.00001) { return vec3f(0.0); }
  return sampled.rgb / sampled.a;
}

fn premultiplied(rgb: vec3f, alpha: f32) -> vec4f {
  return vec4f(max(rgb, vec3f(0.0)) * alpha, alpha);
}

fn hash21(p0: vec2f) -> f32 {
  var p = fract(p0 * vec2f(443.8975, 397.2973));
  p += dot(p, p.yx + vec2f(19.19));
  return fract(p.x * p.y);
}

// Existing Better CRT compatibility port. Its source carries the upstream
// Shadertoy default CC BY-NC-SA terms; this mode preserves the already-bundled
// behavior while keeping alpha intact.
fn better_crt(position: vec2f, uv0: vec2f) -> vec4f {
  var uv = uv0;
  var dc = abs(vec2f(0.5) - uv);
  dc *= dc;
  uv.x = (uv.x - 0.5) * (1.0 + dc.y * 0.075) + 0.5;
  uv.y = (uv.y - 0.5) * (1.0 + dc.x * 0.10) + 0.5;
  let scanline = abs(sin(position.y) * 0.125);
  let sampled = sample_image(uv);
  return vec4f(sampled.rgb * (1.0 - scanline), sampled.a);
}

fn from_srgb1(value: f32) -> f32 {
  return select(pow(value / 1.055 + 0.055 / 1.055, 2.4), value / 12.92, value <= 0.04045);
}

fn to_srgb1(value: f32) -> f32 {
  return select(1.055 * pow(max(value, 0.0), 0.41666) - 0.055, value * 12.92, value < 0.0031308);
}

fn from_srgb(value: vec3f) -> vec3f {
  return vec3f(from_srgb1(value.r), from_srgb1(value.g), from_srgb1(value.b));
}

fn to_srgb(value: vec3f) -> vec3f {
  return vec3f(to_srgb1(value.r), to_srgb1(value.g), to_srgb1(value.b));
}

// WebGPU adaptation of Timothy Lottes' public-domain CRT scalar. The source
// port is Unlicensed/public domain. This retains its warp, scan blur, shadow
// mask, linear-light processing, and corner vignette in a compact GPU form.
fn public_domain_crt(position: vec2f, uv0: vec2f) -> vec4f {
  let aspect = effect.resolution.x / max(1.0, effect.resolution.y);
  var centered = uv0 * 2.0 - 1.0;
  centered *= vec2f(
    1.0 + centered.y * centered.y / (50.0 * aspect),
    1.0 + centered.x * centered.x / 50.0,
  );
  let uv = centered * 0.5 + 0.5;
  let pixel = 1.0 / effect.resolution;
  let center_sample = sample_image(uv);
  let left = from_srgb(straight_rgb(sample_image(uv - vec2f(pixel.x, 0.0))));
  let center = from_srgb(straight_rgb(center_sample));
  let right = from_srgb(straight_rgb(sample_image(uv + vec2f(pixel.x, 0.0))));
  var color = left * 0.18 + center * 0.64 + right * 0.18;
  let scan = 0.58 + 0.42 * pow(max(0.0, cos(position.y * 2.0943951)), 2.0);
  let mask_index = u32(position.x + position.y * 3.0) % 6u;
  var mask = vec3f(0.65);
  if (mask_index < 2u) { mask.r = 1.0; }
  else if (mask_index < 4u) { mask.g = 1.0; }
  else { mask.b = 1.0; }
  color *= scan * mask;
  let vignette_axis = clamp(1.0 - centered * centered, vec2f(0.0), vec2f(1.0));
  color *= mix(0.5, 1.0, vignette_axis.x * vignette_axis.y);
  let peak = max(0.00001, max(color.r, max(color.g, color.b)));
  let tone = peak / (peak * 0.72 + 0.28);
  color *= tone / peak;
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  let alpha = select(0.0, center_sample.a, inside);
  return premultiplied(to_srgb(color), alpha);
}

// MIT-licensed VHS effect by Alex Brinsmead, adapted from the upstream GLSL
// to premultiplied WebGPU output.
fn vhs(position: vec2f, uv0: vec2f) -> vec4f {
  let distortion = 1.0;
  let tape_wear = 1.75;
  let color_bleed = 2.0;
  var cc = uv0 - 0.5;
  var warped = clamp(uv0 + cc * (dot(cc, cc) * 0.02), vec2f(0.0), vec2f(1.0));
  warped.x += (
    sin(warped.y * 40.0 + effect.time * 0.5) * 0.000375 +
    sin(warped.y * 80.0 + effect.time * 0.2) * 0.0001875 +
    (hash21(vec2f(floor(position.y), floor(effect.time * 20.0))) - 0.5) * 0.0006
  ) * distortion;
  let tracking_y = fract(effect.time * 0.04);
  let band_distance = min(abs(warped.y - tracking_y), 1.0 - abs(warped.y - tracking_y));
  let band = smoothstep(0.05, 0.0, band_distance);
  let horizontal_offset = band * (hash21(vec2f(floor(position.y * 0.5), effect.time * 3.0)) - 0.5) * 0.006;
  let burst_cycle = floor(effect.time / 30.0);
  let burst_start = hash21(vec2f(burst_cycle, 88.0)) * 25.0;
  let burst_time = effect.time - floor(effect.time / 30.0) * 30.0;
  let burst = burst_time > burst_start && burst_time < burst_start + 5.0;
  let jump = select(0.0, (hash21(vec2f(floor(effect.time * 2.0), 11.3)) - 0.5) * 0.08, burst);
  let sample_uv = fract(warped + vec2f(horizontal_offset, jump));
  let aberration = (0.0003 + band * 0.0015) * color_bleed;
  let center_sample = sample_image(sample_uv);
  let red_sample = straight_rgb(sample_image(sample_uv + vec2f(aberration, 0.0)));
  let blue_sample = straight_rgb(sample_image(sample_uv - vec2f(aberration, 0.0)));
  var color = vec3f(red_sample.r, straight_rgb(center_sample).g, blue_sample.b);
  let pixel = 1.0 / effect.resolution.x;
  let neighbor = straight_rgb(sample_image(sample_uv + vec2f(pixel, 0.0))) * 0.4 +
    straight_rgb(sample_image(sample_uv + vec2f(pixel * 3.0, 0.0))) * 0.6;
  let luma_weights = vec3f(0.299, 0.587, 0.114);
  let luma = dot(color, luma_weights);
  color = vec3f(luma) + mix(color - vec3f(luma), neighbor - vec3f(dot(neighbor, luma_weights)), 0.5 * color_bleed);
  color *= 1.8;
  let grain_time = fract(effect.time);
  let noise1 = hash21(position + vec2f(grain_time * 100.0)) - 0.5;
  let noise2 = hash21(position + vec2f(grain_time * 200.0)) - 0.5;
  let gray = dot(color, luma_weights);
  color += (color - vec3f(gray)) * vec3f(noise1, noise2, -noise1) * 0.15 * tape_wear;
  color += vec3f(noise1 * 0.05 * tape_wear);
  color *= mix(vec3f(1.0), vec3f(1.03, 1.01, 0.96), tape_wear);
  let vignette = uv0 * (1.0 - uv0);
  color *= mix(1.0, clamp(vignette.x * vignette.y * 15.0, 0.0, 1.0), 0.35);
  let static_time = fract(effect.time * 20.0);
  let static_hash = hash21(vec2f(floor(position.x / 10.0), floor(position.y / 2.0) + static_time * 500.0) + vec2f(static_time * 77.0));
  color = mix(color, vec3f(1.0), step(0.9991, static_hash) * 0.135);
  return premultiplied(color, center_sample.a);
}

// Ember overlay inspired by Jan Mróz's CC BY 3.0 shader, adapted for the
// Ghostty pipeline. Attribution is retained in THIRD_PARTY_NOTICES.md.
fn sparks(position: vec2f, uv: vec2f) -> vec4f {
  let terminal = sample_image(uv);
  var spark = vec3f(0.0);
  var spark_alpha = 0.0;
  for (var layer = 0u; layer < 8u; layer += 1u) {
    let layer_value = f32(layer);
    let scale = 18.0 + layer_value * 7.0;
    let drift = vec2f(effect.time * (0.35 + layer_value * 0.025), -effect.time * (0.7 + layer_value * 0.05));
    let grid = uv * vec2f(scale, scale * 1.6) + drift;
    let cell = floor(grid);
    let random = hash21(cell + vec2f(layer_value * 13.7, layer_value * 5.1));
    let local = fract(grid) - vec2f(random, fract(random * 17.17));
    let radius = 0.018 + 0.045 * hash21(cell + vec2f(31.0));
    let intensity = smoothstep(radius, 0.0, length(local)) * step(0.79, random);
    let flicker = 0.55 + 0.45 * sin(effect.time * (5.0 + random * 4.0) + random * 31.0);
    let value = intensity * flicker;
    spark += vec3f(1.5, 0.42, 0.05) * value;
    spark_alpha = max(spark_alpha, value * 0.78);
  }
  let terminal_rgb = straight_rgb(terminal);
  let background_weight = 1.0 - smoothstep(0.12, 0.55, dot(terminal_rgb, vec3f(0.2126, 0.7152, 0.0722)));
  let overlay_alpha = spark_alpha * background_weight;
  let alpha = overlay_alpha + terminal.a * (1.0 - overlay_alpha);
  let rgb = select(
    vec3f(0.0),
    (spark * overlay_alpha + terminal_rgb * terminal.a * (1.0 - overlay_alpha)) / max(alpha, 0.00001),
    alpha > 0.00001,
  );
  return premultiplied(rgb, alpha);
}

@fragment fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / effect.resolution;
  switch effect.mode {
    case 1u: { return better_crt(position.xy, uv); }
    case 2u: { return public_domain_crt(position.xy, uv); }
    case 3u: { return vhs(position.xy, uv); }
    case 4u: { return sparks(position.xy, uv); }
    default: { return sample_image(uv); }
  }
}
`;
