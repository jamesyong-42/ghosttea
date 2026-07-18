import Foundation
import GhostteaCore
import GhostteaTransport

public struct GhostteaResizeCommit: Sendable {
  public let size: GhostteaTerminalGridSize
  public let layoutEpoch: UInt64
  public let update: GhostteaUpdate
}

public struct GhostteaResizeFailure: Error, CustomStringConvertible, Sendable {
  public let size: GhostteaTerminalGridSize
  public let message: String
  public let rollbackMessage: String?

  public var description: String {
    if let rollbackMessage {
      return
        "resize \(size.columns)x\(size.rows) failed: \(message); rollback failed: \(rollbackMessage)"
    }
    return "resize \(size.columns)x\(size.rows) failed: \(message)"
  }
}

public actor GhostteaResizeCoordinator {
  public typealias CommitHandler = @Sendable (GhostteaResizeCommit) async -> Void
  public typealias FailureHandler = @Sendable (GhostteaResizeFailure) async -> Void

  private struct Request: Sendable {
    let generation: UInt64
    let size: GhostteaTerminalGridSize
  }

  private let resizeCore:
    @Sendable (GhostteaTerminalGridSize, UInt64) async throws -> GhostteaUpdate
  private let resizeTransport: (@Sendable (GhostteaTerminalGridSize) async throws -> Void)?
  private let onCommit: CommitHandler
  private let onFailure: FailureHandler
  private var lastAppliedSize: GhostteaTerminalGridSize
  private var layoutEpoch: UInt64
  private var generation: UInt64 = 0
  private var pending: Request?
  private var processing = false

  public init(
    terminal: GhostteaTerminal,
    connection: (any TerminalConnection)?,
    initialSize: GhostteaTerminalGridSize,
    initialLayoutEpoch: UInt64 = 1,
    onCommit: @escaping CommitHandler,
    onFailure: @escaping FailureHandler = { _ in }
  ) {
    resizeCore = { size, layoutEpoch in
      try await terminal.resize(
        columns: size.columns,
        rows: size.rows,
        layoutEpoch: layoutEpoch,
        render: .full
      )
    }
    if let connection {
      resizeTransport = { (size: GhostteaTerminalGridSize) async throws in
        try await connection.resize(columns: Int(size.columns), rows: Int(size.rows))
      }
    } else {
      resizeTransport = nil
    }
    lastAppliedSize = initialSize
    layoutEpoch = initialLayoutEpoch
    self.onCommit = onCommit
    self.onFailure = onFailure
  }

  init(
    initialSize: GhostteaTerminalGridSize,
    initialLayoutEpoch: UInt64 = 1,
    resizeCore:
      @escaping @Sendable (GhostteaTerminalGridSize, UInt64) async throws -> GhostteaUpdate,
    resizeTransport: (@Sendable (GhostteaTerminalGridSize) async throws -> Void)?,
    onCommit: @escaping CommitHandler,
    onFailure: @escaping FailureHandler = { _ in }
  ) {
    self.resizeCore = resizeCore
    self.resizeTransport = resizeTransport
    self.lastAppliedSize = initialSize
    self.layoutEpoch = initialLayoutEpoch
    self.onCommit = onCommit
    self.onFailure = onFailure
  }

  public func request(_ size: GhostteaTerminalGridSize) {
    guard size != pending?.size, size != lastAppliedSize || processing else { return }
    generation &+= 1
    pending = Request(generation: generation, size: size)
    guard !processing else { return }
    processing = true
    Task { await drain() }
  }

  public func waitUntilIdle() async {
    while processing {
      await Task.yield()
    }
  }

  private func drain() async {
    await Task.yield()
    while let request = pending {
      pending = nil
      if request.size == lastAppliedSize { continue }
      await apply(request)
    }
    processing = false
    if pending != nil {
      processing = true
      Task { await drain() }
    }
  }

  private func apply(_ request: Request) async {
    let previousSize = lastAppliedSize
    let nextEpoch = layoutEpoch == UInt64.max ? UInt64.max : layoutEpoch + 1
    do {
      try await resizeTransport?(request.size)
    } catch {
      await publishFailure(error, rollback: nil, request: request)
      return
    }
    do {
      let update = try await resizeCore(request.size, nextEpoch)
      lastAppliedSize = request.size
      layoutEpoch = nextEpoch
      guard request.generation == generation else { return }
      await onCommit(
        GhostteaResizeCommit(size: request.size, layoutEpoch: nextEpoch, update: update))
    } catch {
      var rollbackError: Error?
      if let resizeTransport {
        do {
          try await resizeTransport(previousSize)
        } catch {
          rollbackError = error
        }
      }
      await publishFailure(error, rollback: rollbackError, request: request)
    }
  }

  private func publishFailure(_: Error, rollback: Error?, request: Request) async {
    guard request.generation == generation else { return }
    await onFailure(
      GhostteaResizeFailure(
        size: request.size,
        message: "Terminal resize failed",
        rollbackMessage: rollback == nil ? nil : "Terminal resize rollback failed"
      ))
  }
}
