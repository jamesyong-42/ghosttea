import Foundation
import GhostteaSSH
import SwiftUI

struct ContentView: View {
  @EnvironmentObject private var model: HarnessModel

  var body: some View {
    NavigationStack {
      Form {
        Section("Device") {
          Text(model.deviceSummary)
            .font(.footnote)
          LabeledContent("Keychain", value: model.keychainResult)
          Button(model.isRunningKeychain ? "Running…" : "Run Keychain smoke test") {
            model.runKeychainProof()
          }
          .disabled(model.isRunningKeychain)
        }

        Section("Ghostty VT") {
          LabeledContent("Result", value: model.vtResult)
          Button("Run VT smoke test") {
            model.runVTProof()
          }
        }

        Section("Memory matrix") {
          Text(model.memoryStatus)
            .font(.footnote)
          ForEach(model.memoryResults) { result in
            VStack(alignment: .leading, spacing: 4) {
              Text("\(result.sessions) session\(result.sessions == 1 ? "" : "s")")
                .font(.headline)
              Text(
                "empty \(formatBytes(result.emptyFootprintBytes)) · loaded \(formatBytes(result.loadedFootprintBytes))"
              )
              Text(
                "compressed \(formatBytes(result.compressedFootprintBytes)) · rows \(result.scrollbackRows.map(String.init).joined(separator: ", "))"
              )
              Text(
                result.compressionSupported ? "compression supported" : "compression unavailable")
            }
            .font(.caption)
          }
          Button(model.isRunningMemory ? "Running…" : "Run 1/4/8-session matrix") {
            model.runMemoryMatrix()
          }
          .disabled(model.isRunningMemory)
        }

        Section("SSH command probe") {
          TextField("Host", text: $model.host)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Port", text: $model.port)
            .keyboardType(.numberPad)
          TextField("Username", text: $model.username)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          SecureField("Password", text: $model.password)
          TextField("Command", text: $model.command, axis: .vertical)
            .lineLimit(2...5)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Text(model.sshStatus)
            .font(.footnote)
          if !model.sshOutput.isEmpty {
            ScrollView(.horizontal) {
              Text(model.sshOutput)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
            }
          }
          Button(model.isRunningSSH ? "Running…" : "Run SSH command") {
            model.runSSHCommand()
          }
          .disabled(model.isRunningSSH)
        }
      }
      .navigationTitle("Ghosttea Phase 0")
      .sheet(item: $model.pendingHostKey) { pending in
        HostKeyDecisionView(challenge: pending.challenge) { decision in
          model.resolveHostKey(decision)
        }
        .interactiveDismissDisabled()
      }
    }
  }

  private func formatBytes(_ bytes: UInt64) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .memory)
  }
}

private struct HostKeyDecisionView: View {
  let challenge: SSHCandidateHostKeyChallenge
  let resolve: (SSHCandidateHostKeyDecision) -> Void

  var body: some View {
    NavigationStack {
      Form {
        Section(challenge.status == .unknown ? "Unknown host" : "Host key changed") {
          LabeledContent("Host", value: "\(challenge.host):\(challenge.port)")
          LabeledContent("Algorithm", value: challenge.algorithm)
          Text(challenge.fingerprint)
            .font(.system(.footnote, design: .monospaced))
            .textSelection(.enabled)
        }
        if challenge.status == .changed {
          Section {
            Text("Only continue if you independently verified this new fingerprint.")
              .foregroundStyle(.red)
          }
        }
        Section {
          Button("Accept & Store") { resolve(.acceptAndStore) }
          Button("Accept Once") { resolve(.acceptOnce) }
          Button("Reject", role: .destructive) { resolve(.reject) }
        }
      }
      .navigationTitle("Verify Host Key")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}
