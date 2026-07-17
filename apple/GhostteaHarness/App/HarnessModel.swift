import Darwin
import Foundation
import GhostteaCredentials
import GhostteaCore
import GhostteaFontProof
import GhostteaSSH
import GhostteaTerminal
import GhostteaTransport
import UIKit

@MainActor
final class HarnessModel: ObservableObject {
  private enum SSHCancellationReason {
    case user
    case networkChange
    case background
  }

  private enum LifecycleProbe {
    case none
    case routeAwaitingConnection
    case routeAwaitingTransition
    case freshReconnect
    case backgroundAwaitingConnection
    case backgroundAwaitingReturn
  }

  enum SSHCommandPreset {
    case defaultOutput
    case exitStreams
    case signalTermination
  }

  enum SSHProbeAuthentication: String, CaseIterable, Identifiable {
    case password = "Password"
    case privateKey = "Private key"
    case keyboardInteractive = "Keyboard"

    var id: Self { self }
  }

  enum SSHProbeSession: String, CaseIterable, Identifiable {
    case command = "Command"
    case ptyResize = "PTY resize"
    case halfClose = "Half-close"

    var id: Self { self }
  }

  struct PendingHostKey: Identifiable {
    let id = UUID()
    let challenge: SSHCandidateHostKeyChallenge
  }

  struct PendingKeyboardChallenge: Identifiable {
    let id = UUID()
    let challenge: SSHKeyboardInteractiveChallenge
  }

  @Published var vtResult = "Not run"
  @Published var fontParityResult = "Not run"
  @Published var coreResult = "Not run"
  @Published var frameDecoderResult = "Not run"
  @Published var keychainResult = "Not run"
  @Published var networkPathSummary = "Starting monitor…"
  @Published var reconnectStateSummary = "Idle"
  @Published var lifecycleProbeResult = "Not run"
  @Published var memoryResults: [HarnessMemoryResult] = []
  @Published var memoryStatus = "Not run"
  @Published var wholeAppMemoryResult: HarnessWholeAppMemoryResult?
  @Published var wholeAppMemoryStatus = "Not run"
  @Published var activeSSHMemoryResult: HarnessActiveSSHMemoryResult?
  @Published var activeSSHMemoryStatus = "Not run"
  @Published var host = "10.0.0.103"
  @Published var port = "22022"
  @Published var username = "ghosttea"
  @Published var sshAuthentication = SSHProbeAuthentication.password
  @Published var sshSession = SSHProbeSession.command
  @Published var password = "ghosttea-password"
  @Published var privateKey = ""
  @Published var privateKeyPassphrase = ""
  @Published var command = "printf 'ghosttea-device-ok\\n'; uname -a"
  @Published var sshStatus = "Not connected"
  @Published var sshOutput = ""
  @Published var sshStandardError = ""
  @Published var pendingHostKey: PendingHostKey?
  @Published var pendingKeyboardChallenge: PendingKeyboardChallenge?
  @Published private var isBridgingSSHInteraction = false
  @Published var isRunningMemory = false
  @Published var isRunningFontParity = false
  @Published var isRunningCore = false
  @Published var isRunningFrameDecoder = false
  @Published var isRunningWholeAppMemory = false
  @Published var isRunningActiveSSHMemory = false
  @Published var isRunningKeychain = false
  @Published var isRunningSSH = false

  private var hostKeyContinuation: CheckedContinuation<SSHCandidateHostKeyDecision, Never>?
  private var keyboardChallengeContinuation: CheckedContinuation<[String], Error>?
  private var sshTask: Task<Void, Never>?
  private var sshCancellationRequestedAt: ContinuousClock.Instant?
  private var sshCancellationReason: SSHCancellationReason?
  private var sshGeneration: UInt64?
  private var reconnectModel = TerminalReconnectModel()
  private var networkPathTask: Task<Void, Never>?
  private var lifecycleProbe = LifecycleProbe.none
  private var backgroundCancellationMilliseconds: Int64?
  private var disposableFixtureHost = "10.0.0.103"

  init() {
    if let configuredHost = ProcessInfo.processInfo.environment["GHOSTTEA_FIXTURE_HOST"],
      !configuredHost.isEmpty
    {
      disposableFixtureHost = configuredHost
      host = configuredHost
    }
    let updates = AppleTerminalNetworkPathMonitor().updates()
    networkPathTask = Task { [weak self] in
      for await path in updates {
        guard let self else { return }
        self.handleNetworkPathChange(path)
      }
    }
    if ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_MEMORY_GATE"] == "1" {
      Task { [weak self] in
        await Task.yield()
        self?.runWholeAppMemoryGate()
      }
    }
    Task { [weak self] in
      await Task.yield()
      self?.runFontParityProof()
    }
    Task { [weak self] in
      await Task.yield()
      self?.runCoreProof()
    }
    Task { [weak self] in
      await Task.yield()
      self?.runFrameDecoderProof()
    }
  }

  deinit {
    networkPathTask?.cancel()
  }

  var isPresentingSSHInteraction: Bool {
    pendingHostKey != nil || pendingKeyboardChallenge != nil || isBridgingSSHInteraction
  }

  var deviceSummary: String {
    let device = UIDevice.current
    return
      "\(device.model) · iOS \(device.systemVersion) · \(ProcessInfo.processInfo.physicalMemory / 1_048_576) MiB RAM"
  }

  func runVTProof() {
    do {
      vtResult = try HarnessDiagnostics.runVTProof()
    } catch {
      vtResult = "Failed: \(error)"
    }
  }

  func runFontParityProof() {
    guard !isRunningFontParity else { return }
    isRunningFontParity = true
    fontParityResult = "Running bundled-font parity fixture…"
    Task {
      do {
        let result = try await Task.detached(priority: .userInitiated) {
          try GhostteaFontProof.run()
        }.value
        fontParityResult =
          result.passed
          ? "Passed · runtime output matches desktop golden"
          : "Failed · runtime output differs from desktop golden"
        print(result.passed ? "GHOSTTEA_FONT_PARITY_PASS" : "GHOSTTEA_FONT_PARITY_FAIL")
        finishFontParityAutomation(exitCode: result.passed ? 0 : 1)
      } catch {
        fontParityResult = "Failed: \(error)"
        print("GHOSTTEA_FONT_PARITY_ERROR \(error)")
        finishFontParityAutomation(exitCode: 2)
      }
      isRunningFontParity = false
    }
  }

  private func finishFontParityAutomation(exitCode: Int32) {
    guard ProcessInfo.processInfo.environment["GHOSTTEA_FONT_PARITY_AUTOMATION"] == "1" else {
      return
    }
    fflush(nil)
    Darwin.exit(exitCode)
  }

  func runCoreProof() {
    guard !isRunningCore else { return }
    isRunningCore = true
    coreResult = "Running production C ABI fixture…"
    Task {
      do {
        let runtime = try GhostteaRuntime()
        let terminal = try GhostteaTerminal(
          runtime: runtime,
          configuration: .init(sessionHandle: 42)
        )
        let update = try await terminal.feed(
          Data("phase3-device\r\n\u{1B}]0;core-title\u{07}\u{1B}[6n".utf8),
          render: .full
        )
        let kinds = update.effects.map(\.kind)
        guard update.effects.map(\.sequence) == Array(0..<UInt32(update.effects.count)),
          kinds.first == .writeToTransport,
          kinds.contains(.frameReady),
          kinds.contains(.logicalSnapshotJSON),
          !(await terminal.isPoisoned),
          !runtime.isPoisoned
        else {
          throw HarnessError.coreParityMismatch
        }
        let accessibility = try await terminal.accessibilityRows(start: 0, count: 2)
        guard String(decoding: accessibility, as: UTF8.self).contains("phase3-device") else {
          throw HarnessError.coreParityMismatch
        }
        coreResult = "Passed · ordered production ABI effects and TRF1"
        print("GHOSTTEA_CORE_PASS")
        finishCoreAutomation(exitCode: 0)
      } catch {
        coreResult = "Failed: \(error)"
        print("GHOSTTEA_CORE_ERROR \(error)")
        finishCoreAutomation(exitCode: 2)
      }
      isRunningCore = false
    }
  }

  private func finishCoreAutomation(exitCode: Int32) {
    guard ProcessInfo.processInfo.environment["GHOSTTEA_CORE_AUTOMATION"] == "1" else {
      return
    }
    fflush(nil)
    Darwin.exit(exitCode)
  }

  func runFrameDecoderProof() {
    guard !isRunningFrameDecoder else { return }
    isRunningFrameDecoder = true
    frameDecoderResult = "Running strict TRF1 decoder fixture…"
    Task {
      do {
        let runtime = try GhostteaRuntime()
        let terminal = try GhostteaTerminal(
          runtime: runtime,
          configuration: .init(sessionHandle: 74, columns: 100, rows: 30)
        )
        let fullUpdate = try await terminal.feed(
          Data("phase4-device ✓ 界\r\n".utf8), render: .full)
        let incrementalUpdate = try await terminal.feed(
          Data("retained-state\r\n".utf8), render: .damage)
        guard let frame = fullUpdate.effects.first(where: { $0.kind == .frameReady })?.payload,
          let incremental = incrementalUpdate.effects.first(where: { $0.kind == .frameReady })?.payload
        else {
          throw HarnessError.frameDecoderMismatch
        }
        let summary = try GhostteaTerminalFrameDecoder.inspect(frame)
        let retained = try GhostteaTerminalFrameDecoder.retain([frame, incremental, incremental])
        let metal = try GhostteaMetalProof.run(frame: frame)
        guard summary.sessionHandle == 74,
          summary.columns == 100,
          summary.rows == 30,
          summary.sectionCount >= 6,
          summary.glyphDefinitionCount > 0,
          summary.styleDefinitionCount > 0,
          summary.rowReplacementCount == 30,
          summary.accessibilityRows.contains(where: { $0.contains("phase4-device ✓ 界") }),
          summary.cursorRow == 1,
          summary.scrollbarLength == 30,
          retained.appliedFrameCount == 2,
          retained.staleFrameCount == 1,
          retained.refreshRequestCount == 0,
          !retained.awaitingResync,
          retained.rows.contains(where: { $0.contains("phase4-device ✓ 界") }),
          retained.rows.contains(where: { $0.contains("retained-state") }),
          !metal.deviceName.isEmpty,
          metal.uploadedBytes > 0,
          metal.cachedUploadBytes == 0,
          metal.alphaGlyphCount > 0,
          metal.residentAtlasBytes == 20 * 1024 * 1024
        else {
          throw HarnessError.frameDecoderMismatch
        }
        let atlasMiB = metal.residentAtlasBytes / 1_048_576
        frameDecoderResult =
          "Passed · strict TRF1, retained state, Metal atlases (\(metal.deviceName), \(atlasMiB) MiB)"
        print("GHOSTTEA_TRF1_PASS")
        finishFrameDecoderAutomation(exitCode: 0)
      } catch {
        frameDecoderResult = "Failed: \(error)"
        print("GHOSTTEA_TRF1_ERROR \(error)")
        finishFrameDecoderAutomation(exitCode: 2)
      }
      isRunningFrameDecoder = false
    }
  }

  private func finishFrameDecoderAutomation(exitCode: Int32) {
    guard ProcessInfo.processInfo.environment["GHOSTTEA_TRF1_AUTOMATION"] == "1" else {
      return
    }
    fflush(nil)
    Darwin.exit(exitCode)
  }

  func runKeychainProof() {
    guard !isRunningKeychain else { return }
    isRunningKeychain = true
    keychainResult = "Running save/load/delete proof…"
    Task {
      let credential = SSHCredentialID(connectionID: UUID(), kind: .password)
      do {
        let store = try KeychainSSHCredentialStore()
        let expected = Data(UUID().uuidString.utf8)
        try await store.store(expected, for: credential)
        guard try await store.load(credential) == expected else {
          throw HarnessError.keychainRoundTripMismatch
        }
        try await store.remove(credential)
        guard try await store.load(credential) == nil else {
          throw HarnessError.keychainRemovalFailed
        }
        keychainResult = "Passed · device-only, non-synchronizing item removed"
      } catch {
        if let store = try? KeychainSSHCredentialStore() {
          try? await store.remove(credential)
        }
        keychainResult = "Failed: \(error)"
      }
      isRunningKeychain = false
    }
  }

  func runMemoryMatrix() {
    guard !isRunningMemory else { return }
    isRunningMemory = true
    memoryStatus = "Running deterministic 1/4/8-session matrix…"
    Task {
      do {
        let results = try await Task.detached(priority: .userInitiated) {
          try HarnessDiagnostics.runMemoryMatrix()
        }.value
        memoryResults = results
        memoryStatus = "Complete"
      } catch {
        memoryStatus = "Failed: \(error)"
      }
      isRunningMemory = false
    }
  }

  func runWholeAppMemoryGate() {
    guard !isRunningWholeAppMemory else { return }
    isRunningWholeAppMemory = true
    wholeAppMemoryStatus = "Running foreground/background process gate…"
    wholeAppMemoryResult = nil
    let physicalMemory = ProcessInfo.processInfo.physicalMemory
    Task {
      do {
        let result = try await Task.detached(priority: .userInitiated) {
          try HarnessDiagnostics.runWholeAppMemoryGate(
            physicalMemoryBytes: physicalMemory
          )
        }.value
        wholeAppMemoryResult = result
        wholeAppMemoryStatus = result.passed ? "Passed" : "Failed"
      } catch {
        wholeAppMemoryStatus = "Failed: \(error)"
      }
      isRunningWholeAppMemory = false
      if ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_ACTIVE_SSH_MEMORY_GATE"] == "1" {
        runActiveSSHMemoryGate()
      }
    }
  }

  func runActiveSSHMemoryGate() {
    guard !isRunningActiveSSHMemory, !isRunningSSH else { return }
    let fixtureHost = disposableFixtureHost
    let physicalMemory = ProcessInfo.processInfo.physicalMemory
    let knownHosts: String
    do {
      knownHosts = try knownHostsPath()
    } catch {
      activeSSHMemoryStatus = "Failed: \(error)"
      return
    }
    isRunningActiveSSHMemory = true
    activeSSHMemoryResult = nil
    activeSSHMemoryStatus = "Connecting, pausing demand, then draining 32 MiB…"
    Task {
      do {
        let result = try await HarnessDiagnostics.runActiveSSHMemoryGate(
          host: fixtureHost,
          port: 22_022,
          username: "ghosttea",
          password: Data("ghosttea-password".utf8),
          knownHostsPath: knownHosts,
          physicalMemoryBytes: physicalMemory
        )
        activeSSHMemoryResult = result
        activeSSHMemoryStatus = result.passed ? "Passed" : "Failed"
      } catch {
        activeSSHMemoryStatus = "Failed: \(error)"
      }
      isRunningActiveSSHMemory = false
    }
  }

  @discardableResult
  func runSSHCommand() -> Bool {
    guard !isRunningSSH else { return false }
    guard let numericPort = Int(port), (1...65_535).contains(numericPort) else {
      sshStatus = "Enter a valid port"
      return false
    }
    guard !host.isEmpty, !username.isEmpty else {
      sshStatus = "Host and username are required"
      return false
    }
    guard sshAuthentication != .privateKey || !privateKey.isEmpty else {
      sshStatus = "Paste a disposable OpenSSH private key"
      return false
    }

    let reconnectEffects = reconnectModel.update(.connectRequested)
    guard
      case .startFreshConnection(let generation) = reconnectEffects.first
    else {
      updateReconnectStateSummary()
      sshStatus = "Waiting for a usable network path"
      return false
    }

    let requestedHost = host
    let requestedUsername = username
    let requestedAuthentication = sshAuthentication
    let requestedSession = sshSession
    let requestedPassword = Data(password.utf8)
    let requestedPrivateKey = Data(privateKey.utf8)
    let requestedPassphrase = Data(privateKeyPassphrase.utf8)
    let requestedCommand = command
    password = ""
    privateKey = ""
    privateKeyPassphrase = ""
    isRunningSSH = true
    sshStatus = "Connecting…"
    sshOutput = ""
    sshStandardError = ""
    isBridgingSSHInteraction = false

    sshCancellationRequestedAt = nil
    sshCancellationReason = nil
    sshGeneration = generation
    sshTask = Task {
      do {
        let credentialStore = try KeychainSSHCredentialStore()
        let connectionID = UUID()
        let credentials: [SSHCredentialID]
        let authentication: SSHCandidateAuthentication
        do {
          switch requestedAuthentication {
          case .password:
            let credential = SSHCredentialID(connectionID: connectionID, kind: .password)
            credentials = [credential]
            authentication = .passwordCredential(
              username: requestedUsername,
              credential: credential,
              resolver: { requestedCredential in
                try await credentialStore.require(requestedCredential)
              }
            )
            try await credentialStore.store(requestedPassword, for: credential)
          case .privateKey:
            let privateKeyCredential = SSHCredentialID(
              connectionID: connectionID,
              kind: .privateKey
            )
            let passphraseCredential =
              requestedPassphrase.isEmpty
              ? nil
              : SSHCredentialID(
                connectionID: connectionID,
                kind: .privateKeyPassphrase
              )
            credentials = [privateKeyCredential, passphraseCredential].compactMap { $0 }
            authentication = .publicKeyCredential(
              username: requestedUsername,
              privateKeyCredential: privateKeyCredential,
              passphraseCredential: passphraseCredential,
              resolver: { requestedCredential in
                try await credentialStore.require(requestedCredential)
              }
            )
            try await credentialStore.store(requestedPrivateKey, for: privateKeyCredential)
            if let passphraseCredential {
              try await credentialStore.store(requestedPassphrase, for: passphraseCredential)
            }
          case .keyboardInteractive:
            credentials = []
            authentication = .keyboardInteractive(
              username: requestedUsername,
              responder: { [weak self] challenge in
                guard let self else { throw CancellationError() }
                return try await self.requestKeyboardChallengeResponse(challenge)
              }
            )
          }
          let candidateSession: SSHCandidateSession
          let initialColumns: Int
          let initialRows: Int
          switch requestedSession {
          case .command:
            candidateSession = .command(requestedCommand, allocatePTY: false)
            initialColumns = 80
            initialRows = 24
          case .ptyResize:
            candidateSession = .shell
            initialColumns = 132
            initialRows = 41
          case .halfClose:
            candidateSession = .command("cat", allocatePTY: false)
            initialColumns = 80
            initialRows = 24
          }
          let knownHostsPath = try self.knownHostsPath()
          let configuration = try SSHCandidateConfiguration(
            host: requestedHost,
            port: numericPort,
            knownHostsPath: knownHostsPath,
            hostKeyPolicy: .ask { [weak self] challenge in
              guard let self else { return .reject }
              return await self.requestHostKeyDecision(challenge)
            },
            authentication: authentication,
            session: candidateSession,
            columns: initialColumns,
            rows: initialRows,
            connectTimeoutMilliseconds: 15_000,
            handshakeTimeoutMilliseconds: 15_000
          )
          let transport = SSHCandidateTransport(configuration: configuration)
          let connection = try await transport.connect()
          _ = reconnectModel.update(.connectionEstablished(generation: generation))
          updateReconnectStateSummary()
          didEstablishConnectionForLifecycleProbe()
          finishSSHInteraction()
          do {
            try await removeCredentials(credentials, from: credentialStore)
            var negotiatedSummary: String?
            let candidate = connection as? SSHCandidateConnection
            if let candidate {
              let summary =
                "\(candidate.negotiatedAlgorithms.hostKey) · \(candidate.negotiatedAlgorithms.serverToClientCipher)"
              negotiatedSummary = summary
              sshStatus = "Connected · \(summary)"
            } else {
              sshStatus = "Connected"
            }
            let halfClosePayload = Data("ghosttea-half-close-device-ok\n".utf8)
            switch requestedSession {
            case .command:
              break
            case .ptyResize:
              try await connection.write(
                Data(
                  "printf 'INITIAL '; stty size; while [ \"$(stty size)\" = '41 132' ]; do sleep 1; done; printf 'RESIZED '; stty size; exit 0\n"
                    .utf8
                )
              )
            case .halfClose:
              try await connection.write(halfClosePayload)
              try await connection.finishInput()
            }
            var standardOutput = Data()
            var standardError = Data()
            var sentResize = false
            if let candidate {
              while let chunk = try await candidate.readCommandOutput(maxBytes: 32_768) {
                switch chunk {
                case .standardOutput(let bytes):
                  try appendSSHOutput(
                    bytes,
                    to: &standardOutput,
                    otherStreamBytes: standardError.count
                  )
                case .standardError(let bytes):
                  try appendSSHOutput(
                    bytes,
                    to: &standardError,
                    otherStreamBytes: standardOutput.count
                  )
                }
                if requestedSession == .ptyResize,
                  !sentResize,
                  String(decoding: standardOutput, as: UTF8.self).contains("INITIAL 41 132")
                {
                  try await connection.resize(columns: 140, rows: 50)
                  sentResize = true
                }
              }
            } else {
              while let chunk = try await connection.read(maxBytes: 32_768) {
                try appendSSHOutput(chunk, to: &standardOutput, otherStreamBytes: 0)
              }
            }
            let termination = try await connection.waitForExit()
            try validateSSHSessionProbe(
              requestedSession,
              standardOutput: standardOutput,
              standardError: standardError,
              termination: termination,
              sentResize: sentResize,
              halfClosePayload: halfClosePayload
            )
            try validateFreshReconnectProbe(
              standardOutput: standardOutput,
              standardError: standardError,
              termination: termination
            )
            sshOutput = String(decoding: standardOutput, as: UTF8.self)
            sshStandardError = String(decoding: standardError, as: UTF8.self)
            sshStatus = ["Completed", termination.description, negotiatedSummary]
              .compactMap { $0 }
              .joined(separator: " · ")
            _ = reconnectModel.update(.connectionCompleted(generation: generation))
            updateReconnectStateSummary()
            completeFreshReconnectProbeIfNeeded()
            await connection.disconnect()
          } catch {
            await connection.disconnect()
            throw error
          }
        } catch {
          try? await removeCredentials(credentials, from: credentialStore)
          throw error
        }
      } catch {
        if let requestedAt = sshCancellationRequestedAt,
          let cancellationReason = sshCancellationReason
        {
          let duration = requestedAt.duration(to: .now)
          let milliseconds = durationMilliseconds(duration)
          switch cancellationReason {
          case .user:
            sshStatus = "Cancelled in \(milliseconds) ms"
          case .networkChange:
            sshStatus = reconnectModel.path.canAttemptConnection
              ? "Network route changed · reconnect available · cancelled in \(milliseconds) ms"
              : "Network unavailable · waiting to reconnect · cancelled in \(milliseconds) ms"
          case .background:
            sshStatus = "Suspended in background · cancelled in \(milliseconds) ms"
          }
          recordLifecycleProbeCancellation(
            reason: cancellationReason,
            milliseconds: milliseconds
          )
        } else {
          _ = reconnectModel.update(
            .connectionFailed(generation: generation, reconnectable: false)
          )
          updateReconnectStateSummary()
          sshStatus = "Failed: \(error)"
          failLifecycleProbeIfActive("SSH failed: \(error)")
        }
      }
      finishSSHInteraction()
      isRunningSSH = false
      sshCancellationRequestedAt = nil
      sshCancellationReason = nil
      sshGeneration = nil
      sshTask = nil
      evaluateBackgroundLifecycleProbe()
    }
    return true
  }

  func loadSSHCommandPreset(_ preset: SSHCommandPreset) {
    switch preset {
    case .defaultOutput:
      command = "printf 'ghosttea-device-ok\\n'; uname -a"
    case .exitStreams:
      command = "printf 'fixture-stdout\\n'; printf 'fixture-stderr\\n' >&2; exit 37"
    case .signalTermination:
      command = "kill -TERM $$"
    }
  }

  func loadDisposableFixtureDefaults() {
    host = disposableFixtureHost
    port = "22022"
    username = "ghosttea"
    sshAuthentication = .password
    password = "ghosttea-password"
  }

  func runAutomaticRouteChangeProbe() {
    guard !isRunningSSH else { return }
    guard reconnectModel.path.canAttemptConnection,
      reconnectModel.path.interfaces.contains(.wifi)
    else {
      lifecycleProbeResult = "Failed · start on a satisfied Wi-Fi path"
      return
    }
    loadDisposableFixtureDefaults()
    sshSession = .command
    command = "printf 'READY\\n'; while :; do sleep 1; done"
    lifecycleProbe = .routeAwaitingConnection
    lifecycleProbeResult = "Connecting · host-key confirmation may be required"
    if !runSSHCommand() {
      lifecycleProbe = .none
      lifecycleProbeResult = "Failed · \(sshStatus)"
    }
  }

  func runAutomaticFreshReconnectProbe() {
    guard !isRunningSSH else { return }
    guard reconnectModel.path.canAttemptConnection else {
      lifecycleProbeResult = "Failed · restore a satisfied path first"
      return
    }
    loadDisposableFixtureDefaults()
    sshSession = .command
    command = "printf 'ghosttea-auto-reconnect-ok\\n'"
    lifecycleProbe = .freshReconnect
    lifecycleProbeResult = "Running explicit fresh reconnect…"
    if !runSSHCommand() {
      lifecycleProbe = .none
      lifecycleProbeResult = "Failed · \(sshStatus)"
    }
  }

  func runAutomaticBackgroundProbe() {
    guard !isRunningSSH else { return }
    guard reconnectModel.path.canAttemptConnection else {
      lifecycleProbeResult = "Failed · start on a satisfied network path"
      return
    }
    loadDisposableFixtureDefaults()
    sshSession = .command
    command = "printf 'READY\\n'; while :; do sleep 1; done"
    backgroundCancellationMilliseconds = nil
    lifecycleProbe = .backgroundAwaitingConnection
    lifecycleProbeResult = "Connecting · host-key confirmation may be required"
    if !runSSHCommand() {
      lifecycleProbe = .none
      lifecycleProbeResult = "Failed · \(sshStatus)"
    }
  }

  func cancelSSHCommand() {
    let effects = reconnectModel.update(.disconnectRequested)
    applyReconnectEffects(effects, cancellationReason: .user)
    updateReconnectStateSummary()
  }

  func sceneDidEnterBackground() {
    if lifecycleProbe == .backgroundAwaitingConnection {
      lifecycleProbeResult = "Failed · backgrounded before SSH connected"
      lifecycleProbe = .none
    } else if lifecycleProbe == .backgroundAwaitingReturn {
      lifecycleProbeResult = "Background observed · waiting for teardown"
    }
    let effects = reconnectModel.update(.enteredBackground)
    applyReconnectEffects(effects, cancellationReason: .background)
    updateReconnectStateSummary()
  }

  func sceneDidBecomeActive() {
    let effects = reconnectModel.update(.becameActive)
    applyReconnectEffects(effects, cancellationReason: .networkChange)
    updateReconnectStateSummary()
    evaluateBackgroundLifecycleProbe()
  }

  private func requestSSHCancellation(_ reason: SSHCancellationReason) {
    guard isRunningSSH, sshCancellationRequestedAt == nil else { return }
    sshCancellationRequestedAt = .now
    sshCancellationReason = reason
    switch reason {
    case .user:
      sshStatus = "Cancelling…"
    case .networkChange:
      sshStatus = "Network route changed · cancelling…"
    case .background:
      sshStatus = "Suspending · cancelling…"
    }
    resolveHostKey(.reject)
    cancelKeyboardChallenge()
    sshTask?.cancel()
  }

  private func handleNetworkPathChange(_ path: TerminalNetworkPath) {
    networkPathSummary = describe(path)
    let effects = reconnectModel.update(.pathChanged(path))
    applyReconnectEffects(effects, cancellationReason: .networkChange)
    updateReconnectStateSummary()
  }

  private func didEstablishConnectionForLifecycleProbe() {
    switch lifecycleProbe {
    case .routeAwaitingConnection:
      lifecycleProbe = .routeAwaitingTransition
      lifecycleProbeResult = "Connected · disable Wi-Fi; do not tap Cancel"
    case .backgroundAwaitingConnection:
      lifecycleProbe = .backgroundAwaitingReturn
      lifecycleProbeResult = "Connected · background and reopen the app"
    default:
      break
    }
  }

  private func recordLifecycleProbeCancellation(
    reason: SSHCancellationReason,
    milliseconds: Int64
  ) {
    switch lifecycleProbe {
    case .routeAwaitingTransition:
      guard reason == .networkChange else {
        failLifecycleProbeIfActive("expected a network-route cancellation")
        return
      }
      guard milliseconds < 1_000 else {
        failLifecycleProbeIfActive("route teardown took \(milliseconds) ms")
        return
      }
      guard !reconnectModel.path.interfaces.contains(.wifi),
        reconnectModel.state == .reconnectAvailable
          || reconnectModel.state == .waitingForNetwork
      else {
        failLifecycleProbeIfActive("route state did not offer or await reconnect")
        return
      }
      lifecycleProbeResult =
        "Passed · automatic route teardown \(milliseconds) ms · \(reconnectStateSummary)"
      lifecycleProbe = .none
    case .backgroundAwaitingReturn:
      guard reason == .background else {
        failLifecycleProbeIfActive("expected a background cancellation")
        return
      }
      backgroundCancellationMilliseconds = milliseconds
      lifecycleProbeResult = "Background teardown \(milliseconds) ms · reopen to finish"
    default:
      break
    }
  }

  private func evaluateBackgroundLifecycleProbe() {
    guard lifecycleProbe == .backgroundAwaitingReturn,
      let milliseconds = backgroundCancellationMilliseconds,
      !isRunningSSH,
      reconnectModel.state == .reconnectAvailable
    else { return }
    guard milliseconds < 1_000 else {
      failLifecycleProbeIfActive("background teardown took \(milliseconds) ms")
      return
    }
    lifecycleProbeResult =
      "Passed · background teardown \(milliseconds) ms · explicit reconnect available"
    lifecycleProbe = .none
  }

  private func validateFreshReconnectProbe(
    standardOutput: Data,
    standardError: Data,
    termination: TerminalExitStatus
  ) throws {
    guard lifecycleProbe == .freshReconnect else { return }
    guard
      standardOutput == Data("ghosttea-auto-reconnect-ok\n".utf8),
      standardError.isEmpty,
      termination == .exited(code: 0)
    else {
      throw HarnessError.sessionProbeMismatch("explicit fresh reconnect")
    }
  }

  private func completeFreshReconnectProbeIfNeeded() {
    guard lifecycleProbe == .freshReconnect else { return }
    lifecycleProbeResult = "Passed · explicit fresh reconnect produced exact output"
    lifecycleProbe = .none
  }

  private func failLifecycleProbeIfActive(_ reason: String) {
    guard lifecycleProbe != .none else { return }
    lifecycleProbeResult = "Failed · \(reason)"
    lifecycleProbe = .none
  }

  private func applyReconnectEffects(
    _ effects: [TerminalReconnectEffect],
    cancellationReason: SSHCancellationReason
  ) {
    for effect in effects {
      switch effect {
      case .startFreshConnection:
        // Fresh connections are started only by `runSSHCommand`, after fields
        // and credentials have been validated and captured.
        break
      case .tearDownConnection(let generation):
        guard sshGeneration == generation else { continue }
        requestSSHCancellation(cancellationReason)
      case .reconnectBecameAvailable:
        if !isRunningSSH {
          sshStatus = "Reconnect available · submit credentials to start a fresh SSH session"
        }
      }
    }
  }

  private func updateReconnectStateSummary() {
    switch reconnectModel.state {
    case .idle:
      reconnectStateSummary = "Idle"
    case .waitingForNetwork:
      reconnectStateSummary = "Waiting for network"
    case .connecting(let generation):
      reconnectStateSummary = "Connecting · generation \(generation)"
    case .connected(let generation):
      reconnectStateSummary = "Connected · generation \(generation)"
    case .reconnectAvailable:
      reconnectStateSummary = "Reconnect available"
    case .suspended:
      reconnectStateSummary = "Suspended"
    case .failed:
      reconnectStateSummary = "Failed"
    }
  }

  private func describe(_ path: TerminalNetworkPath) -> String {
    let availability: String
    switch path.availability {
    case .unknown: availability = "Unknown"
    case .satisfied: availability = "Satisfied"
    case .unsatisfied: availability = "Unsatisfied"
    case .requiresConnection: availability = "Requires connection"
    }

    let interfaceNames = path.interfaces.map { interface in
      switch interface {
      case .wifi: return "Wi-Fi"
      case .cellular: return "Cellular"
      case .wiredEthernet: return "Ethernet"
      case .loopback: return "Loopback"
      case .other: return "Other"
      }
    }.sorted()
    let route = interfaceNames.isEmpty ? "no route" : interfaceNames.joined(separator: ", ")
    var qualifiers: [String] = []
    if path.isExpensive { qualifiers.append("expensive") }
    if path.isConstrained { qualifiers.append("constrained") }
    return ([availability, route] + qualifiers).joined(separator: " · ")
  }

  func resolveHostKey(_ decision: SSHCandidateHostKeyDecision) {
    let continuation = hostKeyContinuation
    hostKeyContinuation = nil
    pendingHostKey = nil
    isBridgingSSHInteraction = decision != .reject
    continuation?.resume(returning: decision)
  }

  func resolveKeyboardChallenge(_ responses: [String]) {
    let continuation = keyboardChallengeContinuation
    keyboardChallengeContinuation = nil
    pendingKeyboardChallenge = nil
    isBridgingSSHInteraction = true
    continuation?.resume(returning: responses)
  }

  func cancelKeyboardChallenge() {
    let continuation = keyboardChallengeContinuation
    keyboardChallengeContinuation = nil
    pendingKeyboardChallenge = nil
    isBridgingSSHInteraction = false
    continuation?.resume(throwing: CancellationError())
  }

  private func requestHostKeyDecision(
    _ challenge: SSHCandidateHostKeyChallenge
  ) async -> SSHCandidateHostKeyDecision {
    if let continuation = hostKeyContinuation {
      continuation.resume(returning: .reject)
    }
    return await withCheckedContinuation { continuation in
      hostKeyContinuation = continuation
      isBridgingSSHInteraction = false
      pendingHostKey = PendingHostKey(challenge: challenge)
    }
  }

  private func requestKeyboardChallengeResponse(
    _ challenge: SSHKeyboardInteractiveChallenge
  ) async throws -> [String] {
    if let continuation = keyboardChallengeContinuation {
      continuation.resume(throwing: CancellationError())
    }
    return try await withCheckedThrowingContinuation { continuation in
      keyboardChallengeContinuation = continuation
      isBridgingSSHInteraction = false
      pendingKeyboardChallenge = PendingKeyboardChallenge(challenge: challenge)
    }
  }

  private func finishSSHInteraction() {
    isBridgingSSHInteraction = false
  }

  private func knownHostsPath() throws -> String {
    let root = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = root.appending(path: "GhostteaHarness", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete]
    )
    return directory.appending(path: "known_hosts", directoryHint: .notDirectory).path
  }

  private func removeCredentials(
    _ credentials: [SSHCredentialID],
    from store: KeychainSSHCredentialStore
  ) async throws {
    for credential in credentials {
      try await store.remove(credential)
    }
  }

  private func appendSSHOutput(
    _ bytes: Data,
    to stream: inout Data,
    otherStreamBytes: Int
  ) throws {
    guard stream.count + otherStreamBytes + bytes.count <= 1_048_576 else {
      throw HarnessError.outputLimitExceeded
    }
    stream.append(bytes)
  }

  private func validateSSHSessionProbe(
    _ session: SSHProbeSession,
    standardOutput: Data,
    standardError: Data,
    termination: TerminalExitStatus,
    sentResize: Bool,
    halfClosePayload: Data
  ) throws {
    switch session {
    case .command:
      return
    case .ptyResize:
      let output = String(decoding: standardOutput, as: UTF8.self)
      guard
        sentResize,
        output.contains("INITIAL 41 132"),
        output.contains("RESIZED 50 140"),
        standardError.isEmpty,
        termination == .exited(code: 0)
      else {
        throw HarnessError.sessionProbeMismatch("PTY resize")
      }
    case .halfClose:
      guard
        standardOutput == halfClosePayload,
        standardError.isEmpty,
        termination == .exited(code: 0)
      else {
        throw HarnessError.sessionProbeMismatch("input half-close")
      }
    }
  }

  private func durationMilliseconds(_ duration: Duration) -> Int64 {
    let components = duration.components
    return components.seconds * 1_000 + components.attoseconds / 1_000_000_000_000_000
  }
}

private enum HarnessError: Error, CustomStringConvertible {
  case coreParityMismatch
  case frameDecoderMismatch
  case keychainRemovalFailed
  case keychainRoundTripMismatch
  case outputLimitExceeded
  case sessionProbeMismatch(String)

  var description: String {
    switch self {
    case .coreParityMismatch:
      return "production core fixture did not preserve ordered effects and state"
    case .frameDecoderMismatch:
      return "strict TRF1 decoder did not preserve the production frame"
    case .keychainRemovalFailed:
      return "credential remained after Keychain removal"
    case .keychainRoundTripMismatch:
      return "Keychain credential round trip changed the secret"
    case .outputLimitExceeded:
      return "command output exceeded the 1 MiB harness limit"
    case .sessionProbeMismatch(let probe):
      return "\(probe) session probe did not produce its exact expected result"
    }
  }
}

extension TerminalExitStatus {
  fileprivate var description: String {
    switch self {
    case .exited(let code):
      return "exit \(code)"
    case .signaled(let name):
      return "signal \(name)"
    }
  }
}
