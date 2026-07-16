import Foundation
import GhostteaCredentials
import GhostteaSSH
import GhostteaTransport
import UIKit

@MainActor
final class HarnessModel: ObservableObject {
  struct PendingHostKey: Identifiable {
    let id = UUID()
    let challenge: SSHCandidateHostKeyChallenge
  }

  @Published var vtResult = "Not run"
  @Published var keychainResult = "Not run"
  @Published var memoryResults: [HarnessMemoryResult] = []
  @Published var memoryStatus = "Not run"
  @Published var host = ""
  @Published var port = "22"
  @Published var username = ""
  @Published var password = ""
  @Published var command = "printf 'ghosttea-device-ok\\n'; uname -a"
  @Published var sshStatus = "Not connected"
  @Published var sshOutput = ""
  @Published var pendingHostKey: PendingHostKey?
  @Published var isRunningMemory = false
  @Published var isRunningKeychain = false
  @Published var isRunningSSH = false

  private var hostKeyContinuation: CheckedContinuation<SSHCandidateHostKeyDecision, Never>?

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

  func runSSHCommand() {
    guard !isRunningSSH else { return }
    guard let numericPort = Int(port), (1...65_535).contains(numericPort) else {
      sshStatus = "Enter a valid port"
      return
    }
    guard !host.isEmpty, !username.isEmpty else {
      sshStatus = "Host and username are required"
      return
    }

    let requestedHost = host
    let requestedUsername = username
    let requestedPassword = password
    let requestedCommand = command
    isRunningSSH = true
    sshStatus = "Connecting…"
    sshOutput = ""

    Task {
      do {
        let knownHostsPath = try self.knownHostsPath()
        let configuration = try SSHCandidateConfiguration(
          host: requestedHost,
          port: numericPort,
          knownHostsPath: knownHostsPath,
          hostKeyPolicy: .ask { [weak self] challenge in
            guard let self else { return .reject }
            return await self.requestHostKeyDecision(challenge)
          },
          authentication: .password(
            username: requestedUsername,
            password: requestedPassword
          ),
          session: .command(requestedCommand, allocatePTY: false),
          connectTimeoutMilliseconds: 15_000,
          handshakeTimeoutMilliseconds: 15_000
        )
        let transport = SSHCandidateTransport(configuration: configuration)
        let connection = try await transport.connect()
        do {
          var negotiatedSummary: String?
          if let candidate = connection as? SSHCandidateConnection {
            let summary =
              "\(candidate.negotiatedAlgorithms.hostKey) · \(candidate.negotiatedAlgorithms.serverToClientCipher)"
            negotiatedSummary = summary
            sshStatus = "Connected · \(summary)"
          } else {
            sshStatus = "Connected"
          }
          var received = Data()
          while let chunk = try await connection.read(maxBytes: 32_768) {
            guard received.count + chunk.count <= 1_048_576 else {
              throw HarnessError.outputLimitExceeded
            }
            received.append(chunk)
          }
          let termination = try await connection.waitForExit()
          sshOutput = String(decoding: received, as: UTF8.self)
          sshStatus = ["Completed", termination.description, negotiatedSummary]
            .compactMap { $0 }
            .joined(separator: " · ")
          await connection.disconnect()
        } catch {
          await connection.disconnect()
          throw error
        }
      } catch {
        sshStatus = "Failed: \(error)"
      }
      password = ""
      isRunningSSH = false
    }
  }

  func resolveHostKey(_ decision: SSHCandidateHostKeyDecision) {
    let continuation = hostKeyContinuation
    hostKeyContinuation = nil
    pendingHostKey = nil
    continuation?.resume(returning: decision)
  }

  private func requestHostKeyDecision(
    _ challenge: SSHCandidateHostKeyChallenge
  ) async -> SSHCandidateHostKeyDecision {
    if let continuation = hostKeyContinuation {
      continuation.resume(returning: .reject)
    }
    return await withCheckedContinuation { continuation in
      hostKeyContinuation = continuation
      pendingHostKey = PendingHostKey(challenge: challenge)
    }
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
}

private enum HarnessError: Error, CustomStringConvertible {
  case keychainRemovalFailed
  case keychainRoundTripMismatch
  case outputLimitExceeded

  var description: String {
    switch self {
    case .keychainRemovalFailed:
      return "credential remained after Keychain removal"
    case .keychainRoundTripMismatch:
      return "Keychain credential round trip changed the secret"
    case .outputLimitExceeded:
      return "command output exceeded the 1 MiB harness limit"
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
