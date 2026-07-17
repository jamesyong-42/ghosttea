import Foundation
import GhostteaSSH
import SwiftUI

struct ContentView: View {
  @EnvironmentObject private var model: HarnessModel
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      Form {
        Section("Device") {
          Text(model.deviceSummary)
            .font(.footnote)
          LabeledContent("Network", value: model.networkPathSummary)
          LabeledContent("SSH lifecycle", value: model.reconnectStateSummary)
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

        Section("Bundled font parity") {
          Text(model.fontParityResult)
            .font(.footnote)
          Button(model.isRunningFontParity ? "Running…" : "Run font parity fixture") {
            model.runFontParityProof()
          }
          .disabled(model.isRunningFontParity)
          Text(
            "Runs the Rust shaping and rasterization engine against the five locked fonts, then compares its normalized output with the desktop golden."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }

        Section("Ghosttea production core") {
          Text(model.coreResult)
            .font(.footnote)
          Button(model.isRunningCore ? "Running…" : "Run production core fixture") {
            model.runCoreProof()
          }
          .disabled(model.isRunningCore)
          Text("Exercises the versioned C ABI, ordered effects, TRF1 arena ownership, and accessibility rows.")
            .font(.caption)
            .foregroundStyle(.secondary)
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

        Section("Whole-app memory gate") {
          Text(model.wholeAppMemoryStatus)
            .font(.footnote)
          if let result = model.wholeAppMemoryResult {
            LabeledContent(
              "Policy",
              value:
                "\(result.budget.tier.rawValue) · \(result.budget.maximumResidentSessions) sessions"
            )
            LabeledContent(
              "Process baseline",
              value: formatBytes(result.processBaselineFootprintBytes)
            )
            LabeledContent(
              "Loaded peak / hard",
              value:
                "\(formatBytes(result.peakProcessFootprintBytes)) / \(formatBytes(result.budget.hardApplicationFootprintBytes))"
            )
            LabeledContent(
              "1 active + background / soft",
              value:
                "\(formatBytes(result.foregroundAndBackgroundFootprintBytes)) / \(formatBytes(result.budget.softApplicationFootprintBytes))"
            )
            LabeledContent(
              "All compressed",
              value: formatBytes(result.allCompressedFootprintBytes)
            )
            Text(
              "terminal handles \(formatBytes(result.emptyTerminalDeltaBytes)) · loaded scrollback \(formatBytes(result.loadedScrollbackDeltaBytes))"
            )
            Text(
              "transport buffers \(formatBytes(result.transportBufferBytes)) (idle) · decoded images n/a · GPU atlas n/a"
            )
            Text("rows \(result.retainedScrollbackRows.map(String.init).joined(separator: ", "))")
            if !result.failures.isEmpty {
              Text(result.failures.joined(separator: " · "))
                .foregroundStyle(.red)
            }
          }
          Button(
            model.isRunningWholeAppMemory ? "Running…" : "Run whole-app memory gate"
          ) {
            model.runWholeAppMemoryGate()
          }
          .disabled(model.isRunningWholeAppMemory || model.isRunningMemory)
          Text(
            "Phase 0 has no TRF1 renderer, decoded images, or Metal atlas; those categories remain explicit future gates."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }

        Section("Active SSH memory gate") {
          Text(model.activeSSHMemoryStatus)
            .font(.footnote)
          if let result = model.activeSSHMemoryResult {
            LabeledContent(
              "Stalled process / soft",
              value:
                "\(formatBytes(result.stalledFootprintBytes)) / \(formatBytes(result.budget.softApplicationFootprintBytes))"
            )
            LabeledContent(
              "Baseline → connected",
              value:
                "\(formatBytes(result.processBaselineFootprintBytes)) → \(formatBytes(result.connectedFootprintBytes))"
            )
            LabeledContent(
              "After lossless drain",
              value: formatBytes(result.drainedFootprintBytes)
            )
            LabeledContent(
              "Output drained",
              value:
                "\(formatBytes(result.drainedOutputBytes)) / \(formatBytes(result.expectedOutputBytes))"
            )
            Text(
              "paused delivered \(result.deliveredBytesBeforeStall) → \(result.deliveredBytesAfterStall) bytes · socket \(result.socketBytesBeforeStall) → \(result.socketBytesAfterStall) bytes"
            )
            Text(
              "receive window \(formatBytes(result.receiveWindowBytes)) / \(formatBytes(result.initialReceiveWindowBytes)) · socket waits \(result.socketWaitCalls)"
            )
            if !result.failures.isEmpty {
              Text(result.failures.joined(separator: " · "))
                .foregroundStyle(.red)
            }
          }
          Button(
            model.isRunningActiveSSHMemory
              ? "Running…" : "Run active SSH memory gate"
          ) {
            model.runActiveSSHMemoryGate()
          }
          .disabled(
            model.isRunningActiveSSHMemory || model.isRunningWholeAppMemory
              || model.isRunningSSH
          )
          Text(
            "The disposable fixture sends 32 MiB while app demand is paused. The gate requires unchanged delivery and socket counters, bounded whole-process memory, and an exact drain."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }

        Section("Automated lifecycle probes") {
          Text(model.lifecycleProbeResult)
            .font(.footnote)
          Button("Start route-change probe") {
            model.runAutomaticRouteChangeProbe()
          }
          .disabled(model.isRunningSSH)
          Button("Run explicit fresh reconnect") {
            model.runAutomaticFreshReconnectProbe()
          }
          .disabled(model.isRunningSSH)
          Button("Start background probe") {
            model.runAutomaticBackgroundProbe()
          }
          .disabled(model.isRunningSSH)
          Text("Only switching Wi-Fi and backgrounding the app remain manual iOS gestures.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Section("SSH command probe") {
          Button("Load disposable fixture defaults") {
            model.loadDisposableFixtureDefaults()
          }
          TextField("Host", text: $model.host)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Port", text: $model.port)
            .keyboardType(.numberPad)
          TextField("Username", text: $model.username)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Picker("Authentication", selection: $model.sshAuthentication) {
            ForEach(HarnessModel.SSHProbeAuthentication.allCases) { authentication in
              Text(authentication.rawValue).tag(authentication)
            }
          }
          .pickerStyle(.segmented)
          Picker("Session", selection: $model.sshSession) {
            ForEach(HarnessModel.SSHProbeSession.allCases) { session in
              Text(session.rawValue).tag(session)
            }
          }
          .pickerStyle(.segmented)
          if model.sshAuthentication == .password {
            SecureField("Password", text: $model.password)
          } else if model.sshAuthentication == .privateKey {
            TextField(
              "Paste disposable OpenSSH private key", text: $model.privateKey, axis: .vertical
            )
            .lineLimit(4...10)
            .font(.system(.caption, design: .monospaced))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            SecureField("Private-key passphrase (optional)", text: $model.privateKeyPassphrase)
          }
          if model.sshSession == .command {
            TextField("Command", text: $model.command, axis: .vertical)
              .lineLimit(2...5)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
            Menu("Load command probe") {
              Button("Default output") {
                model.loadSSHCommandPreset(.defaultOutput)
              }
              Button("stdout + stderr + exit 37") {
                model.loadSSHCommandPreset(.exitStreams)
              }
              Button("Remote SIGTERM") {
                model.loadSSHCommandPreset(.signalTermination)
              }
            }
          }
          Text(model.sshStatus)
            .font(.footnote)
          if !model.sshOutput.isEmpty {
            ScrollView(.horizontal) {
              Text(model.sshOutput)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
            }
          }
          if !model.sshStandardError.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
              Text("stderr")
                .font(.caption)
                .foregroundStyle(.secondary)
              ScrollView(.horizontal) {
                Text(model.sshStandardError)
                  .font(.system(.caption, design: .monospaced))
                  .textSelection(.enabled)
              }
            }
          }
          HStack {
            Button(model.isRunningSSH ? "Running…" : "Run SSH probe") {
              model.runSSHCommand()
            }
            .disabled(model.isRunningSSH)
            if model.isRunningSSH {
              Spacer()
              Button("Cancel", role: .destructive) {
                model.cancelSSHCommand()
              }
            }
          }
        }
      }
      .navigationTitle("Ghosttea Phase 0")
      .sheet(isPresented: sshInteractionPresented) {
        SSHInteractionView()
          .environmentObject(model)
          .interactiveDismissDisabled()
      }
      .onChange(of: scenePhase) { _, phase in
        switch phase {
        case .active:
          model.sceneDidBecomeActive()
        case .background:
          model.sceneDidEnterBackground()
        case .inactive:
          break
        @unknown default:
          break
        }
      }
    }
  }

  private func formatBytes(_ bytes: UInt64) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .memory)
  }

  private var sshInteractionPresented: Binding<Bool> {
    Binding(
      get: { model.isPresentingSSHInteraction },
      set: { _ in }
    )
  }
}

private struct SSHInteractionView: View {
  @EnvironmentObject private var model: HarnessModel

  var body: some View {
    if let pending = model.pendingHostKey {
      HostKeyDecisionView(challenge: pending.challenge) { decision in
        model.resolveHostKey(decision)
      }
    } else if let pending = model.pendingKeyboardChallenge {
      KeyboardChallengeView(challenge: pending.challenge) { result in
        switch result {
        case .success(let responses):
          model.resolveKeyboardChallenge(responses)
        case .failure:
          model.cancelSSHCommand()
        }
      }
    } else {
      ProgressView("Continuing authentication…")
    }
  }
}

private struct KeyboardChallengeView: View {
  let challenge: SSHKeyboardInteractiveChallenge
  let resolve: (Result<[String], Error>) -> Void

  @State private var responses: [String]

  init(
    challenge: SSHKeyboardInteractiveChallenge,
    resolve: @escaping (Result<[String], Error>) -> Void
  ) {
    self.challenge = challenge
    self.resolve = resolve
    _responses = State(initialValue: Array(repeating: "", count: challenge.prompts.count))
  }

  var body: some View {
    NavigationStack {
      Form {
        if !challenge.name.isEmpty || !challenge.instruction.isEmpty {
          Section {
            if !challenge.name.isEmpty {
              Text(challenge.name)
                .font(.headline)
            }
            if !challenge.instruction.isEmpty {
              Text(challenge.instruction)
            }
          }
        }
        Section(challenge.prompts.isEmpty ? "Server message" : "Responses") {
          if challenge.prompts.isEmpty {
            Text("The server did not request a response.")
              .foregroundStyle(.secondary)
          }
          ForEach(Array(challenge.prompts.enumerated()), id: \.offset) { index, prompt in
            if prompt.echoesResponse {
              TextField(prompt.text, text: $responses[index])
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            } else {
              SecureField(prompt.text, text: $responses[index])
            }
          }
        }
        Section {
          Button(challenge.prompts.isEmpty ? "Continue" : "Submit") {
            resolve(.success(responses))
          }
          Button("Cancel", role: .destructive) {
            resolve(.failure(CancellationError()))
          }
        }
      }
      .navigationTitle("Authentication Challenge")
      .navigationBarTitleDisplayMode(.inline)
    }
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
