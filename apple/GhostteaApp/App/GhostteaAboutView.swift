import SwiftUI

struct GhostteaAboutView: View {
  @Environment(\.dismiss) private var dismiss

  private let notices = Self.loadNotices()

  var body: some View {
    NavigationStack {
      ScrollView {
        Text(notices)
          .font(.caption.monospaced())
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding()
      }
      .navigationTitle("Third-Party Notices")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }

  private static func loadNotices() -> String {
    guard
      let url = Bundle.main.url(
        forResource: "THIRD-PARTY-NOTICES",
        withExtension: "txt"),
      let value = try? String(contentsOf: url, encoding: .utf8)
    else {
      return "Third-party notices are unavailable. This build is not eligible for release."
    }
    return value
  }
}
