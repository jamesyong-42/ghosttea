import Foundation

public enum TerminalNetworkAvailability: Equatable, Sendable {
  case unknown
  case satisfied
  case unsatisfied
  case requiresConnection
}

public enum TerminalNetworkInterface: Hashable, Sendable {
  case wifi
  case cellular
  case wiredEthernet
  case loopback
  case other
}

/// A transport-neutral snapshot of the route currently selected by the host.
///
/// This is a hint about path state, not proof that a particular SSH endpoint is
/// reachable. A change in the selected interface invalidates an ordinary live
/// SSH connection even when both the old and new paths are marked satisfied.
public struct TerminalNetworkPath: Equatable, Sendable {
  public let availability: TerminalNetworkAvailability
  public let interfaces: Set<TerminalNetworkInterface>
  public let isExpensive: Bool
  public let isConstrained: Bool

  public init(
    availability: TerminalNetworkAvailability,
    interfaces: Set<TerminalNetworkInterface> = [],
    isExpensive: Bool = false,
    isConstrained: Bool = false
  ) {
    self.availability = availability
    self.interfaces = interfaces
    self.isExpensive = isExpensive
    self.isConstrained = isConstrained
  }

  public static let unknown = TerminalNetworkPath(availability: .unknown)

  public var canAttemptConnection: Bool {
    availability == .satisfied
  }

  fileprivate var routeIdentity: RouteIdentity {
    RouteIdentity(availability: availability, interfaces: interfaces)
  }
}

private struct RouteIdentity: Equatable {
  let availability: TerminalNetworkAvailability
  let interfaces: Set<TerminalNetworkInterface>
}

public enum TerminalReconnectState: Equatable, Sendable {
  case idle
  case waitingForNetwork
  case connecting(generation: UInt64)
  case connected(generation: UInt64)
  case reconnectAvailable
  case suspended
  case failed
}

public enum TerminalReconnectEvent: Equatable, Sendable {
  /// A user or product policy explicitly requests a fresh connection.
  case connectRequested
  case connectionEstablished(generation: UInt64)
  case connectionCompleted(generation: UInt64)
  case connectionFailed(generation: UInt64, reconnectable: Bool)
  case pathChanged(TerminalNetworkPath)
  case enteredBackground
  case becameActive
  case disconnectRequested
}

public enum TerminalReconnectEffect: Equatable, Sendable {
  case startFreshConnection(generation: UInt64)
  case tearDownConnection(generation: UInt64)
  case reconnectBecameAvailable
}

/// Deterministic policy for ordinary connections that cannot survive route or
/// process suspension. It never reconnects silently: restoration produces a
/// `reconnectBecameAvailable` effect and requires a new `connectRequested`.
/// Generation checks prevent late completions from a torn-down task from
/// changing the replacement connection's state.
public struct TerminalReconnectModel: Equatable, Sendable {
  public private(set) var state: TerminalReconnectState = .idle
  public private(set) var path: TerminalNetworkPath

  private var nextGeneration: UInt64 = 1
  private var activeGeneration: UInt64?
  private var connectionDesired = false
  private var isForeground = true

  public init(initialPath: TerminalNetworkPath = .unknown) {
    path = initialPath
  }

  public mutating func update(
    _ event: TerminalReconnectEvent
  ) -> [TerminalReconnectEffect] {
    switch event {
    case .connectRequested:
      connectionDesired = true
      guard isForeground else {
        state = .suspended
        return []
      }
      guard path.canAttemptConnection else {
        state = .waitingForNetwork
        return []
      }
      guard activeGeneration == nil else { return [] }
      return startFreshConnection()

    case .connectionEstablished(let generation):
      guard activeGeneration == generation, state == .connecting(generation: generation) else {
        return []
      }
      state = .connected(generation: generation)
      return []

    case .connectionCompleted(let generation):
      guard activeGeneration == generation else { return [] }
      activeGeneration = nil
      connectionDesired = false
      state = .idle
      return []

    case .connectionFailed(let generation, let reconnectable):
      guard activeGeneration == generation else { return [] }
      activeGeneration = nil
      guard reconnectable else {
        connectionDesired = false
        state = .failed
        return []
      }
      return transitionAfterConnectionLoss(notifyWhenAvailable: true)

    case .pathChanged(let newPath):
      let routeChanged = path.routeIdentity != newPath.routeIdentity
      path = newPath

      if routeChanged, let generation = activeGeneration {
        activeGeneration = nil
        let availabilityEffects = transitionAfterConnectionLoss(notifyWhenAvailable: true)
        return [.tearDownConnection(generation: generation)] + availabilityEffects
      }

      guard connectionDesired, activeGeneration == nil, isForeground else { return [] }
      switch (state, newPath.canAttemptConnection) {
      case (.waitingForNetwork, true):
        state = .reconnectAvailable
        return [.reconnectBecameAvailable]
      case (.reconnectAvailable, false):
        state = .waitingForNetwork
      default:
        break
      }
      return []

    case .enteredBackground:
      isForeground = false
      state = connectionDesired ? .suspended : .idle
      guard let generation = activeGeneration else { return [] }
      activeGeneration = nil
      return [.tearDownConnection(generation: generation)]

    case .becameActive:
      isForeground = true
      guard connectionDesired, activeGeneration == nil else { return [] }
      if path.canAttemptConnection {
        state = .reconnectAvailable
        return [.reconnectBecameAvailable]
      }
      state = .waitingForNetwork
      return []

    case .disconnectRequested:
      connectionDesired = false
      state = .idle
      guard let generation = activeGeneration else { return [] }
      activeGeneration = nil
      return [.tearDownConnection(generation: generation)]
    }
  }

  private mutating func startFreshConnection() -> [TerminalReconnectEffect] {
    let generation = nextGeneration
    nextGeneration &+= 1
    activeGeneration = generation
    state = .connecting(generation: generation)
    return [.startFreshConnection(generation: generation)]
  }

  private mutating func transitionAfterConnectionLoss(
    notifyWhenAvailable: Bool
  ) -> [TerminalReconnectEffect] {
    guard connectionDesired else {
      state = .idle
      return []
    }
    guard isForeground else {
      state = .suspended
      return []
    }
    guard path.canAttemptConnection else {
      state = .waitingForNetwork
      return []
    }
    state = .reconnectAvailable
    return notifyWhenAvailable ? [.reconnectBecameAvailable] : []
  }
}
