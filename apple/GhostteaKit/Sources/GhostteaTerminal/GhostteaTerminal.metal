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
