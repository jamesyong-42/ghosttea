import Foundation
import GhostteaCore
import GhostteaSSH
import GhostteaSSHWorkspace
import GhostteaSession
import GhostteaTransport
import GhostteaWorkspace
import Testing

private actor EventRecorder {
  private(set) var events: [GhostteaSSHWorkspaceSessionEvent] = []

  func append(_ event: GhostteaSSHWorkspaceSessionEvent) {
    events.append(event)
  }
}

private func testSSHConfiguration() throws -> GhostteaSSHConfiguration {
  try GhostteaSSHConfiguration(
    host: "workspace.invalid",
    knownHostsPath: "/tmp/ghosttea-workspace-known-hosts",
    authentication: .keyboardInteractive(
      username: "ghosttea",
      responder: { _ in [] }
    ),
    columns: 100,
    rows: 30
  )
}

@Test func factoryAllocatesIndependentTerminalsAndRoutesIdentity() async throws {
  let recorder = EventRecorder()
  let factory = try GhostteaSSHWorkspaceSessionFactory(
    runtime: GhostteaRuntime(),
    ssh: testSSHConfiguration(),
    sessionConfiguration: .ssh(
      initialPath: TerminalNetworkPath(availability: .unsatisfied)
    ),
    initialSessionHandle: 700,
    identityPrefix: "test",
    eventHandler: { event in await recorder.append(event) }
  )

  let first = try await factory.allocate(.newTab)
  let second = try await factory.allocate(
    .split(axis: .vertical, sourceSessionID: first.sessionID)
  )

  #expect(first.sessionID == "test-session-700")
  #expect(second.sessionID == "test-session-701")
  #expect(first.session.terminalSessionHandle == 700)
  #expect(second.session.terminalSessionHandle == 701)
  #expect(first.session.id == first.sessionID)
  #expect(second.session.id == second.sessionID)
  #expect(first.session.terminal !== second.session.terminal)
  #expect(first.session.session !== second.session.session)
  #expect(
    second.session.request
      == .split(axis: .vertical, sourceSessionID: first.sessionID)
  )

  let events = await recorder.events
  #expect(events.map(\.sessionID) == [first.sessionID, second.sessionID])
  #expect(
    events.allSatisfy {
      $0.event
        == .stateChanged(
          GhostteaSessionSnapshot(reconnectState: .waitingForNetwork)
        )
    }
  )
}

@Test func factoryCanAllocateWithoutStartingTransport() async throws {
  let recorder = EventRecorder()
  let factory = try GhostteaSSHWorkspaceSessionFactory(
    runtime: GhostteaRuntime(),
    ssh: testSSHConfiguration(),
    sessionConfiguration: .ssh(
      initialPath: TerminalNetworkPath(availability: .unsatisfied)
    ),
    identityPrefix: "restored",
    eventHandler: { event in await recorder.append(event) }
  )

  let allocation = try await factory.allocate(.newTab, connect: false)

  #expect(await allocation.session.session.snapshot().reconnectState == .idle)
  #expect(await recorder.events.isEmpty)
}

@Test func factoryRejectsZeroInitialHandle() throws {
  #expect(throws: GhostteaSSHWorkspaceSessionFactoryError.invalidInitialSessionHandle) {
    try GhostteaSSHWorkspaceSessionFactory(
      runtime: GhostteaRuntime(),
      ssh: testSSHConfiguration(),
      initialSessionHandle: 0
    )
  }
}
