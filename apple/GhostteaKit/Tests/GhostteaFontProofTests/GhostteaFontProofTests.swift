import GhostteaFontProof
import Testing

@Test func bundledFontsMatchDesktopFixture() throws {
  let result = try GhostteaFontProof.run()
  #expect(result.passed)
}
