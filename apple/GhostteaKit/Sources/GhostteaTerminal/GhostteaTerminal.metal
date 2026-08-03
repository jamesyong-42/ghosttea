#include <metal_stdlib>
using namespace metal;

struct RectangleInput {
  float2 position [[attribute(0)]];
  float4 color [[attribute(1)]];
};

struct RectangleOutput {
  float4 position [[position]];
  float4 color;
};

struct RectangleInstance {
  float4 bounds;
  float4 color;
};

constant float2 ghosttea_quad_corners[6] = {
  float2(0.0, 0.0), float2(1.0, 0.0), float2(0.0, 1.0),
  float2(0.0, 1.0), float2(1.0, 0.0), float2(1.0, 1.0),
};

vertex RectangleOutput ghosttea_rectangle_vertex(RectangleInput input [[stage_in]]) {
  return {float4(input.position, 0.0, 1.0), input.color};
}

vertex RectangleOutput ghosttea_rectangle_instanced_vertex(
  uint vertex_id [[vertex_id]],
  uint instance_id [[instance_id]],
  device const RectangleInstance* instances [[buffer(0)]]) {
  const RectangleInstance instance = instances[instance_id];
  const float2 corner = ghosttea_quad_corners[vertex_id];
  const float2 position = mix(instance.bounds.xy, instance.bounds.zw, corner);
  return {float4(position, 0.0, 1.0), instance.color};
}

fragment float4 ghosttea_rectangle_fragment(RectangleOutput input [[stage_in]]) {
  return float4(input.color.rgb * input.color.a, input.color.a);
}

struct GlyphInput {
  float2 position [[attribute(0)]];
  float2 uv [[attribute(1)]];
  float4 color [[attribute(2)]];
};

struct GlyphOutput {
  float4 position [[position]];
  float2 uv;
  float4 color;
};

struct GlyphInstance {
  float4 bounds;
  float4 uv_bounds;
  float4 color;
};

vertex GlyphOutput ghosttea_glyph_vertex(GlyphInput input [[stage_in]]) {
  return {float4(input.position, 0.0, 1.0), input.uv, input.color};
}

vertex GlyphOutput ghosttea_glyph_instanced_vertex(
  uint vertex_id [[vertex_id]],
  uint instance_id [[instance_id]],
  device const GlyphInstance* instances [[buffer(0)]]) {
  const GlyphInstance instance = instances[instance_id];
  const float2 corner = ghosttea_quad_corners[vertex_id];
  const float2 position = mix(instance.bounds.xy, instance.bounds.zw, corner);
  const float2 uv = mix(instance.uv_bounds.xy, instance.uv_bounds.zw, corner);
  return {float4(position, 0.0, 1.0), uv, instance.color};
}

fragment float4 ghosttea_alpha_glyph_fragment(
  GlyphOutput input [[stage_in]],
  texture2d<float> atlas [[texture(0)]],
  sampler atlas_sampler [[sampler(0)]]) {
  const float coverage = atlas.sample(atlas_sampler, input.uv).r;
  const float alpha = input.color.a * coverage;
  return float4(input.color.rgb * alpha, alpha);
}

fragment float4 ghosttea_color_glyph_fragment(
  GlyphOutput input [[stage_in]],
  texture2d<float> atlas [[texture(0)]],
  sampler atlas_sampler [[sampler(0)]]) {
  return atlas.sample(atlas_sampler, input.uv);
}

struct EffectOutput {
  float4 position [[position]];
};

struct EffectConfig {
  uint mode;
  uint frame;
  uint effect_index;
  uint effect_count;
  float2 resolution;
  float time;
  float time_delta;
  float4 cursor;
};

vertex EffectOutput ghosttea_effect_vertex(uint vertex_id [[vertex_id]]) {
  const float2 positions[3] = {
    float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0),
  };
  return {float4(positions[vertex_id], 0.0, 1.0)};
}

static float4 effect_sample(
  texture2d<float> image,
  sampler image_sampler,
  float2 uv
) {
  return image.sample(image_sampler, clamp(uv, float2(0.0), float2(1.0)));
}

static float3 effect_straight_rgb(float4 sampled) {
  return sampled.a <= 0.00001 ? float3(0.0) : sampled.rgb / sampled.a;
}

static float4 effect_premultiplied(float3 rgb, float alpha) {
  return float4(max(rgb, float3(0.0)) * alpha, alpha);
}

static float effect_hash21(float2 p) {
  p = fract(p * float2(443.8975, 397.2973));
  p += dot(p, p.yx + float2(19.19));
  return fract(p.x * p.y);
}

static float4 effect_better_crt(
  texture2d<float> image,
  sampler image_sampler,
  float2 position,
  float2 uv
) {
  float2 dc = abs(float2(0.5) - uv);
  dc *= dc;
  uv.x = (uv.x - 0.5) * (1.0 + dc.y * 0.075) + 0.5;
  uv.y = (uv.y - 0.5) * (1.0 + dc.x * 0.10) + 0.5;
  const float scanline = abs(sin(position.y) * 0.125);
  const float4 sampled = effect_sample(image, image_sampler, uv);
  return float4(sampled.rgb * (1.0 - scanline), sampled.a);
}

static float effect_from_srgb1(float value) {
  return value <= 0.04045
    ? value / 12.92
    : pow(value / 1.055 + 0.055 / 1.055, 2.4);
}

static float effect_to_srgb1(float value) {
  return value < 0.0031308
    ? value * 12.92
    : 1.055 * pow(max(value, 0.0), 0.41666) - 0.055;
}

static float3 effect_from_srgb(float3 value) {
  return float3(
    effect_from_srgb1(value.r),
    effect_from_srgb1(value.g),
    effect_from_srgb1(value.b)
  );
}

static float3 effect_to_srgb(float3 value) {
  return float3(
    effect_to_srgb1(value.r),
    effect_to_srgb1(value.g),
    effect_to_srgb1(value.b)
  );
}

static float4 effect_crt(
  texture2d<float> image,
  sampler image_sampler,
  constant EffectConfig& effect,
  float2 position,
  float2 uv0
) {
  const float aspect = effect.resolution.x / max(1.0, effect.resolution.y);
  float2 centered = uv0 * 2.0 - 1.0;
  centered *= float2(
    1.0 + centered.y * centered.y / (50.0 * aspect),
    1.0 + centered.x * centered.x / 50.0
  );
  const float2 uv = centered * 0.5 + 0.5;
  const float2 pixel = 1.0 / effect.resolution;
  const float4 center_sample = effect_sample(image, image_sampler, uv);
  const float3 left = effect_from_srgb(
    effect_straight_rgb(effect_sample(image, image_sampler, uv - float2(pixel.x, 0.0))));
  const float3 center = effect_from_srgb(effect_straight_rgb(center_sample));
  const float3 right = effect_from_srgb(
    effect_straight_rgb(effect_sample(image, image_sampler, uv + float2(pixel.x, 0.0))));
  float3 color = left * 0.18 + center * 0.64 + right * 0.18;
  const float scan = 0.58 + 0.42 * pow(max(0.0, cos(position.y * 2.0943951)), 2.0);
  const uint mask_index = uint(position.x + position.y * 3.0) % 6u;
  float3 mask = float3(0.65);
  if (mask_index < 2u) mask.r = 1.0;
  else if (mask_index < 4u) mask.g = 1.0;
  else mask.b = 1.0;
  color *= scan * mask;
  const float2 vignette_axis = clamp(1.0 - centered * centered, float2(0.0), float2(1.0));
  color *= mix(0.5, 1.0, vignette_axis.x * vignette_axis.y);
  const float peak = max(0.00001, max(color.r, max(color.g, color.b)));
  const float tone = peak / (peak * 0.72 + 0.28);
  color *= tone / peak;
  const bool inside = all(uv >= float2(0.0)) && all(uv <= float2(1.0));
  return effect_premultiplied(effect_to_srgb(color), inside ? center_sample.a : 0.0);
}

static float4 effect_vhs(
  texture2d<float> image,
  sampler image_sampler,
  constant EffectConfig& effect,
  float2 position,
  float2 uv0
) {
  constexpr float distortion = 1.0;
  constexpr float tape_wear = 1.75;
  constexpr float color_bleed = 2.0;
  float2 cc = uv0 - 0.5;
  float2 warped = clamp(uv0 + cc * (dot(cc, cc) * 0.02), float2(0.0), float2(1.0));
  warped.x += (
    sin(warped.y * 40.0 + effect.time * 0.5) * 0.000375
    + sin(warped.y * 80.0 + effect.time * 0.2) * 0.0001875
    + (effect_hash21(float2(floor(position.y), floor(effect.time * 20.0))) - 0.5) * 0.0006
  ) * distortion;
  const float tracking_y = fract(effect.time * 0.04);
  const float band_distance = min(abs(warped.y - tracking_y), 1.0 - abs(warped.y - tracking_y));
  const float band = smoothstep(0.05, 0.0, band_distance);
  const float horizontal_offset = band
    * (effect_hash21(float2(floor(position.y * 0.5), effect.time * 3.0)) - 0.5) * 0.006;
  const float burst_cycle = floor(effect.time / 30.0);
  const float burst_start = effect_hash21(float2(burst_cycle, 88.0)) * 25.0;
  const float burst_time = effect.time - floor(effect.time / 30.0) * 30.0;
  const bool burst = burst_time > burst_start && burst_time < burst_start + 5.0;
  const float jump = burst
    ? (effect_hash21(float2(floor(effect.time * 2.0), 11.3)) - 0.5) * 0.08
    : 0.0;
  const float2 sample_uv = fract(warped + float2(horizontal_offset, jump));
  const float aberration = (0.0003 + band * 0.0015) * color_bleed;
  const float4 center_sample = effect_sample(image, image_sampler, sample_uv);
  const float3 red_sample = effect_straight_rgb(
    effect_sample(image, image_sampler, sample_uv + float2(aberration, 0.0)));
  const float3 blue_sample = effect_straight_rgb(
    effect_sample(image, image_sampler, sample_uv - float2(aberration, 0.0)));
  float3 color = float3(red_sample.r, effect_straight_rgb(center_sample).g, blue_sample.b);
  const float pixel = 1.0 / effect.resolution.x;
  const float3 neighbor = effect_straight_rgb(
    effect_sample(image, image_sampler, sample_uv + float2(pixel, 0.0))) * 0.4
    + effect_straight_rgb(
      effect_sample(image, image_sampler, sample_uv + float2(pixel * 3.0, 0.0))) * 0.6;
  constexpr float3 luma_weights = float3(0.299, 0.587, 0.114);
  const float luma = dot(color, luma_weights);
  color = float3(luma)
    + mix(color - float3(luma), neighbor - float3(dot(neighbor, luma_weights)), 0.5 * color_bleed);
  color *= 1.8;
  const float grain_time = fract(effect.time);
  const float noise1 = effect_hash21(position + float2(grain_time * 100.0)) - 0.5;
  const float noise2 = effect_hash21(position + float2(grain_time * 200.0)) - 0.5;
  const float gray = dot(color, luma_weights);
  color += (color - float3(gray)) * float3(noise1, noise2, -noise1) * 0.15 * tape_wear;
  color += float3(noise1 * 0.05 * tape_wear);
  color *= mix(float3(1.0), float3(1.03, 1.01, 0.96), tape_wear);
  const float2 vignette = uv0 * (1.0 - uv0);
  color *= mix(1.0, clamp(vignette.x * vignette.y * 15.0, 0.0, 1.0), 0.35);
  const float static_time = fract(effect.time * 20.0);
  const float static_hash = effect_hash21(
    float2(floor(position.x / 10.0), floor(position.y / 2.0) + static_time * 500.0)
      + float2(static_time * 77.0));
  color = mix(color, float3(1.0), step(0.9991, static_hash) * 0.135);
  return effect_premultiplied(color, center_sample.a);
}

static float4 effect_sparks(
  texture2d<float> image,
  sampler image_sampler,
  constant EffectConfig& effect,
  float2 position,
  float2 uv
) {
  const float4 terminal = effect_sample(image, image_sampler, uv);
  float3 spark = float3(0.0);
  float spark_alpha = 0.0;
  for (uint layer = 0u; layer < 8u; layer += 1u) {
    const float layer_value = float(layer);
    const float scale = 18.0 + layer_value * 7.0;
    const float2 drift = float2(
      effect.time * (0.35 + layer_value * 0.025),
      -effect.time * (0.7 + layer_value * 0.05));
    const float2 grid = uv * float2(scale, scale * 1.6) + drift;
    const float2 cell = floor(grid);
    const float random = effect_hash21(
      cell + float2(layer_value * 13.7, layer_value * 5.1));
    const float2 local = fract(grid) - float2(random, fract(random * 17.17));
    const float radius = 0.018 + 0.045 * effect_hash21(cell + float2(31.0));
    const float intensity = smoothstep(radius, 0.0, length(local)) * step(0.79, random);
    const float flicker = 0.55
      + 0.45 * sin(effect.time * (5.0 + random * 4.0) + random * 31.0);
    const float value = intensity * flicker;
    spark += float3(1.5, 0.42, 0.05) * value;
    spark_alpha = max(spark_alpha, value * 0.78);
  }
  const float3 terminal_rgb = effect_straight_rgb(terminal);
  const float background_weight = 1.0
    - smoothstep(0.12, 0.55, dot(terminal_rgb, float3(0.2126, 0.7152, 0.0722)));
  const float overlay_alpha = spark_alpha * background_weight;
  const float alpha = overlay_alpha + terminal.a * (1.0 - overlay_alpha);
  const float3 rgb = alpha > 0.00001
    ? (spark * overlay_alpha + terminal_rgb * terminal.a * (1.0 - overlay_alpha)) / alpha
    : float3(0.0);
  return effect_premultiplied(rgb, alpha);
}

fragment float4 ghosttea_effect_fragment(
  EffectOutput input [[stage_in]],
  texture2d<float> image [[texture(0)]],
  sampler image_sampler [[sampler(0)]],
  constant EffectConfig& effect [[buffer(0)]]) {
  const float2 uv = input.position.xy / effect.resolution;
  switch (effect.mode) {
    case 1u:
      return effect_better_crt(image, image_sampler, input.position.xy, uv);
    case 2u:
      return effect_crt(image, image_sampler, effect, input.position.xy, uv);
    case 3u:
      return effect_vhs(image, image_sampler, effect, input.position.xy, uv);
    case 4u:
      return effect_sparks(image, image_sampler, effect, input.position.xy, uv);
    default:
      return effect_sample(image, image_sampler, uv);
  }
}
