import Foundation

public struct SequencedTerminalBytes: Equatable, Sendable {
  public let sequence: UInt64
  public let bytes: Data

  public init(sequence: UInt64, bytes: Data) {
    self.sequence = sequence
    self.bytes = bytes
  }
}

/// A bounded lossless queue. Enqueueing never waits for network I/O; callers
/// explicitly schedule `drain` on a separate task owned by the session.
public actor OrderedTerminalWriter {
  public let maxItems: Int
  public let maxBytes: Int

  private var queue: [SequencedTerminalBytes] = []
  private var queuedBytes = 0
  private var isDraining = false

  public init(maxItems: Int, maxBytes: Int) {
    precondition(maxItems > 0)
    precondition(maxBytes > 0)
    self.maxItems = maxItems
    self.maxBytes = maxBytes
  }

  public func enqueue(_ item: SequencedTerminalBytes) throws {
    guard queue.count < maxItems, queuedBytes + item.bytes.count <= maxBytes else {
      throw TerminalTransportError.outboundBackpressure(
        maxItems: maxItems,
        maxBytes: maxBytes
      )
    }
    if let last = queue.last {
      precondition(item.sequence > last.sequence, "outbound sequences must be strictly increasing")
    }
    queue.append(item)
    queuedBytes += item.bytes.count
  }

  public func drain(to connection: any TerminalConnection) async throws {
    guard !isDraining else {
      throw TerminalTransportError.writerAlreadyDraining
    }
    isDraining = true
    defer { isDraining = false }

    while let item = queue.first {
      try await connection.write(item.bytes)
      queue.removeFirst()
      queuedBytes -= item.bytes.count
    }
  }

  public func pending() -> (items: Int, bytes: Int) {
    (queue.count, queuedBytes)
  }
}
