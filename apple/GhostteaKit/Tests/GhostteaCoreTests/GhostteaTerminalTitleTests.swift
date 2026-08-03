import GhostteaCore
import Testing

@Test func terminalTitlesKeepTextSymbolsOutOfEmojiPresentation() {
  #expect(
    GhostteaTerminalTitle.textPresentation("\u{2733}\u{FE0F} Claude Code")
      == "\u{2733}\u{FE0E} Claude Code")
  #expect(
    GhostteaTerminalTitle.textPresentation("\u{2733} Claude Code")
      == "\u{2733}\u{FE0E} Claude Code")
}

@Test func terminalTitlePresentationPreservesTextAndIntentionalEmoji() {
  #expect(GhostteaTerminalTitle.textPresentation("shell 1") == "shell 1")
  #expect(GhostteaTerminalTitle.textPresentation("Terminal \u{1F600}") == "Terminal \u{1F600}")
  #expect(
    GhostteaTerminalTitle.textPresentation("Family \u{1F469}\u{200D}\u{1F4BB}")
      == "Family \u{1F469}\u{200D}\u{1F4BB}")
}
