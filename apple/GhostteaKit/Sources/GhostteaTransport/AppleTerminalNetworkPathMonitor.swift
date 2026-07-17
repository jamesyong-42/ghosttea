#if canImport(Network)
  import Dispatch
  import Network

  /// Produces host-network path snapshots without exposing Network.framework to
  /// the transport or session contracts. The stream intentionally coalesces to
  /// its newest element: unlike terminal bytes, intermediate path notifications
  /// are not lossless application data.
  public struct AppleTerminalNetworkPathMonitor: Sendable {
    public init() {}

    public func updates() -> AsyncStream<TerminalNetworkPath> {
      AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "dev.ghosttea.network-path")
        monitor.pathUpdateHandler = { path in
          continuation.yield(TerminalNetworkPath(path))
        }
        continuation.onTermination = { @Sendable _ in
          monitor.cancel()
        }
        monitor.start(queue: queue)
      }
    }
  }

  extension TerminalNetworkPath {
    fileprivate init(_ path: NWPath) {
      let availability: TerminalNetworkAvailability
      switch path.status {
      case .satisfied:
        availability = .satisfied
      case .unsatisfied:
        availability = .unsatisfied
      case .requiresConnection:
        availability = .requiresConnection
      @unknown default:
        availability = .unknown
      }

      var interfaces: Set<TerminalNetworkInterface> = []
      if path.usesInterfaceType(.wifi) { interfaces.insert(.wifi) }
      if path.usesInterfaceType(.cellular) { interfaces.insert(.cellular) }
      if path.usesInterfaceType(.wiredEthernet) { interfaces.insert(.wiredEthernet) }
      if path.usesInterfaceType(.loopback) { interfaces.insert(.loopback) }
      if path.usesInterfaceType(.other) { interfaces.insert(.other) }

      self.init(
        availability: availability,
        interfaces: interfaces,
        isExpensive: path.isExpensive,
        isConstrained: path.isConstrained
      )
    }
  }
#endif
