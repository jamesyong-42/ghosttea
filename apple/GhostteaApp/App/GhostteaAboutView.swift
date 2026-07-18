import GhostteaDiagnostics
import SwiftUI
import UIKit

struct GhostteaAboutView: View {
  @Environment(\.dismiss) private var dismiss

  private let notices = Self.loadNotices()
  let diagnostics: GhostteaDiagnosticRecorder
  @State private var diagnosticStatus: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        Text(notices)
          .font(.caption.monospaced())
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding()
      }
      .navigationTitle("About Ghosttea")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Copy Diagnostics") { copyDiagnostics() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
      .safeAreaInset(edge: .bottom) {
        if let diagnosticStatus {
          Text(diagnosticStatus)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.vertical, 8)
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

  private func copyDiagnostics() {
    Task {
      do {
        let data = try await diagnostics.exportData()
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
        diagnosticStatus = "Copied redacted diagnostics"
      } catch {
        diagnosticStatus = "Redacted diagnostics unavailable"
      }
    }
  }
}
