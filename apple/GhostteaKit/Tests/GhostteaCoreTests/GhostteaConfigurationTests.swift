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

@Test func configurationBuildsRuntimeMetricsAndAppliesTerminalColors() async throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ghosttea-runtime-config-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let configURL = directory.appendingPathComponent("config.ghostty")
  try """
    font-size = 26
    foreground = 112233
    background = 445566
    cursor-color = 778899
    scrollback-limit = 654321
    """.write(to: configURL, atomically: true, encoding: .utf8)

  let snapshot = try GhostteaConfiguration.load(
    overlayURL: configURL,
    loadGhosttyFiles: false
  )
  let metrics = GhostteaTextMetrics(config: snapshot)
  #expect(metrics.fontSizePixels == 26)
  #expect(abs(metrics.cellWidthPixels - 15.66) < 0.001)
  #expect(metrics.lineHeightPixels == 38)
  #expect(metrics.baselinePixels == 28)
  #expect(metrics.rasterScale == 2)

  let terminalConfiguration = GhostteaTerminalConfiguration(
    sessionHandle: 43,
    config: snapshot
  )
  #expect(terminalConfiguration.scrollbackBytes == 654_321)
  let terminal = try GhostteaTerminal(
    runtime: GhostteaRuntime(config: snapshot),
    configuration: terminalConfiguration
  )
  _ = try await terminal.apply(config: snapshot, render: .none)
  let update = try await terminal.feed(
    Data("\u{1b}]10;?\u{1b}\\\u{1b}]11;?\u{1b}\\\u{1b}]12;?\u{1b}\\".utf8),
    render: .none
  )
  let response = update.effects
    .filter { $0.kind == .writeToTransport }
    .reduce(into: Data()) { $0.append($1.payload) }
  let responseText = String(decoding: response, as: UTF8.self)
  #expect(responseText.contains("]10;rgb:1111/2222/3333"))
  #expect(responseText.contains("]11;rgb:4444/5555/6666"))
  #expect(responseText.contains("]12;rgb:7777/8888/9999"))
}
