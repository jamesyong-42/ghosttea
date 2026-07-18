#if os(iOS)
  import Foundation
  import Truffle
  import TruffleTailscale

  public enum GhostteaTruffleRuntimePhase: String, Sendable {
    case starting
    case needsLogin
    case needsMachineAuth
    case running
    case stopping
    case stopped
    case failed

    init(_ phase: MeshPhase) {
      self = GhostteaTruffleRuntimePhase(rawValue: phase.rawValue) ?? .failed
    }
  }

  public enum GhostteaTruffleRuntimeEvent: Sendable {
    case phase(GhostteaTruffleRuntimePhase)
    case authRequired(URL)
    case peersChanged
    case health(String)
  }

  /// Application-owned production composition of Ghosttea's shared-session
  /// protocol and Truffle's in-process Tailscale runtime.
  public actor GhostteaTruffleRuntime {
    public let node: MeshNode
    public let directory: GhostteaTrufflePeerDirectory

    private init(node: MeshNode) {
      self.node = node
      directory = GhostteaTrufflePeerDirectory(node: node)
    }

    public static func start(
      deviceName: String,
      stateDirectory: URL? = nil,
      controlURL: URL? = nil,
      onAuthRequired: @MainActor @escaping @Sendable (URL) async -> Void
    ) async throws -> GhostteaTruffleRuntime {
      let node = try await MeshNode.startTailscale(
        MeshConfiguration(
          appId: GhostteaTruffleContract.appID,
          deviceName: deviceName,
          stateDirectory: stateDirectory,
          controlURL: controlURL,
          ephemeral: false,
          auth: .interactive(onAuthRequired: onAuthRequired)
        ))
      return GhostteaTruffleRuntime(node: node)
    }

    public var phase: GhostteaTruffleRuntimePhase {
      get async { GhostteaTruffleRuntimePhase(await node.phase) }
    }

    public func refresh() async throws {
      try await node.refresh()
    }

    public func candidates() async -> [GhostteaTruffleHostCandidate] {
      await directory.candidates()
    }

    public func events() async -> AsyncStream<GhostteaTruffleRuntimeEvent> {
      let upstream = await node.events
      return AsyncStream(bufferingPolicy: .bufferingNewest(128)) { continuation in
        let task = Task {
          for await event in upstream {
            switch event {
            case .phase(let phase):
              continuation.yield(.phase(GhostteaTruffleRuntimePhase(phase)))
            case .authRequired(let url):
              continuation.yield(.authRequired(url))
            case .peerUpsert, .peerLeft:
              continuation.yield(.peersChanged)
            case .health(let message):
              continuation.yield(.health(message))
            case .message:
              break
            }
          }
          continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
      }
    }

    public func stop() async {
      await node.stop()
    }
  }
#endif
