import Testing

@testable import GhostteaSSHProbe

@Test func candidateInitializesAndLinksKeyboardInteractive() throws {
  let capabilities = try GhostteaSSHProbe.inspect()

  // The upstream 1.11.1 tag reports this exact runtime string.
  #expect(capabilities.runtimeVersion == "1.11.1_DEV")
  #expect(capabilities.hasKeyboardInteractiveSymbol)
}
