import Foundation
import Testing

@testable import GhostteaCore

@Test func ghosttyConfigurationLoadsThroughTheSharedNativeSchema() throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-config-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let configURL = directory.appendingPathComponent("config.ghostty")
  try """
    background = 102030
    foreground = fefefe
    scrollback-limit = 123456
    custom-shader = ghosttea:better-crt
    keybind = super+shift+x=new_tab
    """.write(to: configURL, atomically: true, encoding: .utf8)

  let snapshot = try GhostteaConfiguration.load(
    overlayURL: configURL,
    loadGhosttyFiles: false
  )

  #expect(snapshot.schemaVersion == 1)
  #expect(snapshot.compatibility.ghosttyVersion == "1.3.1")
  #expect(snapshot.terminal.background == [0x10, 0x20, 0x30])
  #expect(snapshot.terminal.scrollbackBytes == 123_456)
  #expect(snapshot.renderer.postProcess == .betterCRT)
  #expect(snapshot.workspace.keybindings == [
    GhostteaConfigKeybinding(trigger: "super+shift+x", action: "new_tab")
  ])
  #expect(!snapshot.hasErrors)
}

@Test func terminalConfigurationUsesGhosttyScrollbackDefault() {
  let config = GhostteaTerminalConfiguration(sessionHandle: 42)
  #expect(config.scrollbackBytes == 10_000_000)
}
