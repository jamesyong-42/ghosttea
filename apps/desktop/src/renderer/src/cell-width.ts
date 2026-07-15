const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function splitGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

export function graphemeCellWidth(grapheme: string): 1 | 2 {
  const codepoint = grapheme.codePointAt(0) ?? 0;
  return /\p{Extended_Pictographic}/u.test(grapheme) ||
    (codepoint >= 0x1100 && codepoint <= 0x115f) ||
    (codepoint >= 0x2e80 && codepoint <= 0xa4cf) ||
    (codepoint >= 0xac00 && codepoint <= 0xd7a3) ||
    (codepoint >= 0xf900 && codepoint <= 0xfaff) ||
    (codepoint >= 0xfe10 && codepoint <= 0xfe6f) ||
    (codepoint >= 0xff00 && codepoint <= 0xff60) ||
    (codepoint >= 0x1f300 && codepoint <= 0x1faff) ||
    (codepoint >= 0x20000 && codepoint <= 0x3fffd)
    ? 2
    : 1;
}
