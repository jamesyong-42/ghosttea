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

vertex RectangleOutput ghosttea_rectangle_vertex(RectangleInput input [[stage_in]]) {
  return {float4(input.position, 0.0, 1.0), input.color};
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

vertex GlyphOutput ghosttea_glyph_vertex(GlyphInput input [[stage_in]]) {
  return {float4(input.position, 0.0, 1.0), input.uv, input.color};
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
