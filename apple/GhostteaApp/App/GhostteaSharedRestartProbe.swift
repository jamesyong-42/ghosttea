#if DEBUG
  import Foundation
  import GhostteaTruffle

  struct GhostteaSharedRestartProbeResult: Sendable {
    let oldGeneration: UInt64
    let newGeneration: UInt64

    var marker: String {
      let generation = oldGeneration == newGeneration
        ? "stable-\(oldGeneration)"
        : "\(oldGeneration)->\(newGeneration)"
      let stalePeer = oldGeneration == newGeneration ? "not-stale" : "rejected"
      return "GHOSTTEA_SHARED_RESTART_PASS "
        + "peerGeneration=\(generation) "
        + "hostInstance=changed stalePeer=\(stalePeer) "
        + "staleSession=rejected freshAttach=1 snapshot=1"
    }
  }

  enum GhostteaSharedRestartProbeError: Error, CustomStringConvertible {
    case missingDurableHostReference
    case missingSession
    case hostDidNotRestart
    case hostInstanceDidNotChange
    case stalePeerAccepted
    case staleSessionAccepted
    case missingSnapshot

    var description: String {
      switch self {
      case .missingDurableHostReference:
        "desktop peer has no durable Truffle device ID"
      case .missingSession:
        "desktop advertised no attachable session"
      case .hostDidNotRestart:
        "desktop did not return with a fresh host instance"
      case .hostInstanceDidNotChange:
        "fresh peer retained the previous desktop host instance ID"
      case .stalePeerAccepted:
        "the departed peer generation still accepted a connection"
      case .staleSessionAccepted:
        "the restarted desktop accepted the previous process session ID"
      case .missingSnapshot:
        "fresh attachment did not produce an authoritative snapshot"
      }
    }
  }

  enum GhostteaSharedRestartProbe {
    static func run(
      directory: GhostteaTrufflePeerDirectory,
      host oldHost: GhostteaTruffleHostCandidate
    ) async throws -> GhostteaSharedRestartProbeResult {
      guard let durableHost = oldHost.persistentReference else {
        throw GhostteaSharedRestartProbeError.missingDurableHostReference
      }
      let oldClient = try await directory.connect(to: oldHost)
      let oldHostInstance = await oldClient.hostInstanceID
      let oldSessions: [GhostteaSharedSessionSummary]
      do {
        oldSessions = try await oldClient.listSessions().filter(\.attachable)
        await oldClient.close()
      } catch {
        await oldClient.close()
        throw error
      }
      guard let oldSession = oldSessions.first else {
        throw GhostteaSharedRestartProbeError.missingSession
      }
      let oldGeneration = oldHost.peer.generation
      print("GHOSTTEA_SHARED_RESTART_READY generation=\(oldGeneration)")

      let fresh = try await waitForFreshHost(
        directory: directory,
        reference: durableHost,
        previousHostInstance: oldHostInstance)
      let freshHost = fresh.host

      if freshHost.peer.generation != oldGeneration {
        do {
          let staleClient = try await directory.connect(to: oldHost)
          await staleClient.close()
          throw GhostteaSharedRestartProbeError.stalePeerAccepted
        } catch GhostteaSharedRestartProbeError.stalePeerAccepted {
          throw GhostteaSharedRestartProbeError.stalePeerAccepted
        } catch {
          // Expected only when the Layer-3 peer actually left and rejoined.
        }
      }

      let freshSessions = fresh.sessions
      guard !freshSessions.contains(where: { $0.sessionID == oldSession.sessionID }) else {
        throw GhostteaSharedRestartProbeError.staleSessionAccepted
      }
      guard let freshSession = freshSessions.first else {
        throw GhostteaSharedRestartProbeError.missingSession
      }

      do {
        let staleAttachment = try await directory.attach(
          to: freshHost,
          sessionID: oldSession.sessionID,
          viewID: "ghosttea-stale-session-\(UUID().uuidString)",
          cols: 101,
          rows: 29)
        await staleAttachment.detach()
        throw GhostteaSharedRestartProbeError.staleSessionAccepted
      } catch GhostteaSharedRestartProbeError.staleSessionAccepted {
        throw GhostteaSharedRestartProbeError.staleSessionAccepted
      } catch {
        // Expected: session IDs are scoped to the departed desktop process.
      }

      let freshAttachment = try await directory.attach(
        to: freshHost,
        sessionID: freshSession.sessionID,
        viewID: "ghosttea-fresh-session-\(UUID().uuidString)",
        cols: 101,
        rows: 29)
      do {
        try await freshAttachment.requestSnapshot()
        try await expectSnapshot(freshAttachment)
        await freshAttachment.detach()
      } catch {
        await freshAttachment.detach()
        throw error
      }

      return GhostteaSharedRestartProbeResult(
        oldGeneration: oldGeneration,
        newGeneration: freshHost.peer.generation)
    }

    private struct FreshHost: Sendable {
      let host: GhostteaTruffleHostCandidate
      let sessions: [GhostteaSharedSessionSummary]
    }

    private static func waitForFreshHost(
      directory: GhostteaTrufflePeerDirectory,
      reference: GhostteaTruffleHostReference,
      previousHostInstance: String
    ) async throws -> FreshHost {
      let deadline = ContinuousClock.now.advanced(by: .seconds(120))
      while ContinuousClock.now < deadline {
        if let candidate = try? await directory.resolve(reference),
          let client = try? await directory.connect(to: candidate)
        {
          let hostInstance = await client.hostInstanceID
          if hostInstance != previousHostInstance {
            do {
              let sessions = try await client.listSessions().filter(\.attachable)
              await client.close()
              return FreshHost(host: candidate, sessions: sessions)
            } catch {
              await client.close()
            }
          } else {
            await client.close()
          }
        }
        try await Task.sleep(for: .milliseconds(500))
      }
      throw GhostteaSharedRestartProbeError.hostDidNotRestart
    }

    private static func expectSnapshot(_ attachment: GhostteaTruffleAttachment) async throws {
      try await withThrowingTaskGroup(of: Bool.self) { group in
        group.addTask {
          for _ in 0..<64 {
            if case .state(.snapshot) = try await attachment.nextEvent() { return true }
          }
          return false
        }
        group.addTask {
          try await Task.sleep(for: .seconds(10))
          await attachment.detach()
          return false
        }
        guard try await group.next() == true else {
          group.cancelAll()
          throw GhostteaSharedRestartProbeError.missingSnapshot
        }
        group.cancelAll()
      }
    }
  }
#endif
