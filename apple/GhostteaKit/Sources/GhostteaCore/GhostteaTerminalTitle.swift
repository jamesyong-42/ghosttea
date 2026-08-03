/// Presentation policy for terminal-supplied titles shown by native UI.
///
/// Terminal applications commonly use Unicode symbols as monochrome status
/// marks. UIKit otherwise honors an emoji variation selector in those titles,
/// which can turn a compact glyph such as `\u{2733}` into a colored emoji even
/// though the terminal itself renders the symbol as text. This changes only
/// native title presentation; the authoritative terminal metadata is retained
/// byte-for-byte.
public enum GhostteaTerminalTitle {
  public static func textPresentation(_ title: String) -> String {
    var output = ""
    output.reserveCapacity(title.utf8.count)
    var suppliedTextSelector = false

    for scalar in title.unicodeScalars {
      if suppliedTextSelector,
        scalar.value == 0xFE0E || scalar.value == 0xFE0F
      {
        suppliedTextSelector = false
        continue
      }

      output.unicodeScalars.append(scalar)
      suppliedTextSelector = false

      // ASCII digits also carry Unicode's Emoji property for keycap
      // sequences. Restricting this policy to symbol code points keeps plain
      // titles and intentional default-emoji characters unchanged.
      if scalar.value >= 0x2000,
        scalar.properties.isEmoji,
        !scalar.properties.isEmojiPresentation,
        let textSelector = Unicode.Scalar(0xFE0E)
      {
        output.unicodeScalars.append(textSelector)
        suppliedTextSelector = true
      }
    }

    return output
  }
}
