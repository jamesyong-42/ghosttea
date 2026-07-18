import Foundation
import GhostteaDiagnostics
import GhostteaTruffle
import SwiftUI
import UIKit

#if DEBUG
  import Darwin
#endif

struct GhostteaLoginPage: Identifiable {
  let url: URL
  var id: String { url.absoluteString }
}

/// Application-owned private-mesh runtime. Every WindowGroup scene shares this
/// object, while terminal attachments and presentation state remain scene-owned.
@MainActor
final class GhostteaSharedRuntimeModel: ObservableObject {
  @Published private(set) var phase: GhostteaTruffleRuntimePhase = .stopped
  @Published private(set) var status = "Starting Ghosttea…"
  @Published private(set) var hosts: [GhostteaTruffleHostCandidate] = []
  @Published var authPage: GhostteaLoginPage?
  @Published private(set) var isBusy = false

  private var mesh: GhostteaTruffleRuntime?
  let diagnostics: GhostteaDiagnosticRecorder
  private(set) var directory: GhostteaTrufflePeerDirectory?
  private var eventTask: Task<Void, Never>?
  #if DEBUG
    private var sharedAutomationProbeStarted = false
  #endif

  init(diagnostics: GhostteaDiagnosticRecorder) {
    self.diagnostics = diagnostics
  }

  func start() {
    guard mesh == nil, !isBusy else { return }
    trace("starting private mesh")
    isBusy = true
    status = "Starting private mesh…"
    phase = .starting
    Task {
      do {
        let runtime = try await GhostteaTruffleRuntime.start(
          deviceName: UIDevice.current.name,
          onAuthRequired: { [weak self] url in
            self?.authPage = GhostteaLoginPage(url: url)
          })
        mesh = runtime
        directory = await runtime.directory
        trace("private mesh runtime started")
        let events = await runtime.events()
        eventTask = Task { [weak self] in
          for await event in events {
            guard let self else { return }
            await self.handle(event)
          }
        }
        phase = await runtime.phase
        isBusy = false
        await refreshHosts()
      } catch {
        record(.truffleStartFailed)
        fail("Could not start the private mesh")
      }
    }
  }

  func stop() async {
    let runtime = mesh
    eventTask?.cancel()
    eventTask = nil
    await runtime?.stop()
    mesh = nil
    directory = nil
    hosts = []
    phase = .stopped
    isBusy = false
    status = "Disconnected"
  }

  func loginSheetDismissed() {
    authPage = nil
    Task {
      do { try await mesh?.refresh() } catch {
        record(.truffleRefreshFailed)
        status = "Could not refresh private-mesh login"
      }
    }
  }

  func refreshHosts() async {
    guard let mesh else { return }
    hosts = await mesh.candidates()
    trace("discovered \(hosts.count) online Ghosttea host(s)")
    if phase == .running {
      status =
        hosts.isEmpty
        ? "Connected. Start the Ghosttea desktop demo to share a session."
        : "\(hosts.count) Ghosttea host\(hosts.count == 1 ? "" : "s") available"
    }
    startSharedAutomationProbeIfRequested()
  }

  private func handle(_ event: GhostteaTruffleRuntimeEvent) async {
    switch event {
    case .phase(let newPhase):
      trace("private mesh phase: \(newPhase.rawValue)")
      phase = newPhase
      switch newPhase {
      case .running:
        authPage = nil
        await refreshHosts()
      case .needsLogin: status = "Sign in to Tailscale to find your desktop"
      case .needsMachineAuth: status = "Waiting for Tailscale device approval"
      case .starting: status = "Connecting private mesh…"
      case .failed: status = "The private mesh stopped unexpectedly"
      case .stopping, .stopped: status = "Disconnected"
      }
    case .authRequired(let url):
      trace("interactive authentication required at \(url.host ?? "Tailscale")")
      authPage = GhostteaLoginPage(url: url)
    case .peersChanged:
      trace("private mesh peer set changed")
      await refreshHosts()
    case .health(let message):
      trace("private mesh health: \(message)")
      status = message
    }
  }

  private func fail(_ message: String) {
    trace(message)
    isBusy = false
    status = message
    if mesh == nil { phase = .failed }
  }

  private func trace(_ message: String) {
    #if DEBUG
      print("[Ghosttea] \(message)")
    #endif
  }

  private func record(_ code: GhostteaDiagnosticCode) {
    Task { try? await diagnostics.record(code, severity: .error) }
  }

  private func startSharedAutomationProbeIfRequested() {
    #if DEBUG
      guard
        !sharedAutomationProbeStarted,
        phase == .running,
        let directory
      else { return }
      let environment = ProcessInfo.processInfo.environment
      let runInterop = environment["GHOSTTEA_AUTORUN_SHARED_INTEROP"] == "1"
      let runRestart = environment["GHOSTTEA_AUTORUN_SHARED_RESTART"] == "1"
      guard runInterop != runRestart else { return }
      let host =
        runRestart
        ? hosts.first(where: { $0.persistentReference != nil })
        : hosts.first
      guard let host else { return }
      sharedAutomationProbeStarted = true
      isBusy = true
      status =
        runRestart
        ? "Waiting for desktop restart…"
        : "Running shared-session interop probe…"
      Task {
        do {
          if runRestart {
            let result = try await GhostteaSharedRestartProbe.run(
              directory: directory, host: host)
            print(result.marker)
            Darwin.exit(EXIT_SUCCESS)
          }
          let client = try await directory.connect(to: host)
          let advertised: [GhostteaSharedSessionSummary]
          do {
            advertised = try await client.listSessions().filter(\.attachable)
            await client.close()
          } catch {
            await client.close()
            throw error
          }
          guard let session = advertised.first else {
            throw GhostteaTruffleError.handshakeRejected(
              "desktop advertised no attachable session")
          }
          let result = try await GhostteaSharedInteropProbe.run(
            directory: directory, host: host, session: session)
          print(result.marker)
          Darwin.exit(EXIT_SUCCESS)
        } catch {
          let marker =
            runRestart
            ? "GHOSTTEA_SHARED_RESTART_FAIL"
            : "GHOSTTEA_SHARED_INTEROP_FAIL"
          print(marker)
          Darwin.exit(EXIT_FAILURE)
        }
      }
    #endif
  }
}
