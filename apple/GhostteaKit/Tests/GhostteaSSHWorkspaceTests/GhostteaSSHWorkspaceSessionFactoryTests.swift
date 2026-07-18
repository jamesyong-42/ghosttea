import Foundation
import GhostteaConnectionProfiles
import GhostteaCore
import GhostteaCredentials
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

@Test func factoryRestoresStableIdentityWithFreshHandleAndRejectsDuplicate() async throws {
  let factory = try GhostteaSSHWorkspaceSessionFactory(
    runtime: GhostteaRuntime(),
    ssh: testSSHConfiguration(),
    sessionConfiguration: .ssh(
      initialPath: TerminalNetworkPath(availability: .unsatisfied)
    ),
    initialSessionHandle: 900,
    identityPrefix: "fresh"
  )

  let restored = try await factory.allocate(
    .newTab,
    ssh: testSSHConfiguration(),
    sessionID: "persisted-session",
    profileID: "profile-a",
    connect: false
  )

  #expect(restored.sessionID == "persisted-session")
  #expect(restored.session.profileID == "profile-a")
  #expect(restored.session.terminalSessionHandle == 900)
  await #expect(
    throws: GhostteaSSHWorkspaceSessionFactoryError.duplicateSessionID(
      "persisted-session"
    )
  ) {
    try await factory.allocate(
      .newTab,
      ssh: testSSHConfiguration(),
      sessionID: "persisted-session",
      profileID: "profile-a",
      connect: false
    )
  }
}

@Test func factoryRestoresAvailableProfilesAndCollapsesMissingBindings() async throws {
  let profileID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
  let profile = try GhostteaSSHConnectionProfile(
    id: profileID,
    name: "Restore test",
    host: "workspace.invalid",
    username: "ghosttea",
    authentication: .keyboardInteractive,
    columns: 100,
    rows: 30
  )
  let first = try GhostteaWorkspaceDocument(
    root: .pane(GhostteaWorkspacePane(id: "pane-a", sessionID: "session-a")),
    activePaneID: "pane-a"
  )
  let second = try GhostteaWorkspaceDocument(
    root: .split(
      GhostteaWorkspaceSplit(
        id: "split-b",
        axis: .horizontal,
        ratio: 0.5,
        first: .pane(GhostteaWorkspacePane(id: "pane-b", sessionID: "session-b")),
        second: .pane(GhostteaWorkspacePane(id: "pane-c", sessionID: "session-c"))
      )
    ),
    activePaneID: "pane-c"
  )
  let workspace = try GhostteaWorkspaceTabsDocument(
    selectedTabID: "tab-b",
    tabs: [
      GhostteaWorkspaceTab(id: "tab-a", workspace: first),
      GhostteaWorkspaceTab(id: "tab-b", workspace: second),
    ]
  )
  let persisted = try GhostteaWorkspaceRestorationDocument(
    workspace: workspace,
    sessionProfiles: [
      GhostteaWorkspaceSessionProfileBinding(
        sessionID: "session-a",
        profileID: profileID.uuidString.lowercased()
      ),
      GhostteaWorkspaceSessionProfileBinding(
        sessionID: "session-b",
        profileID: UUID().uuidString.lowercased()
      ),
      GhostteaWorkspaceSessionProfileBinding(
        sessionID: "session-c",
        profileID: profileID.uuidString.lowercased()
      ),
    ]
  )
  let factory = try GhostteaSSHWorkspaceSessionFactory(
    runtime: GhostteaRuntime(),
    ssh: testSSHConfiguration(),
    sessionConfiguration: .ssh(
      initialPath: TerminalNetworkPath(availability: .unsatisfied)
    ),
    initialSessionHandle: 1_000
  )
  let store = try KeychainSSHCredentialStore(
    service: "com.vibecook.ghosttea.workspace-restore-tests"
  )

  let result = try await factory.restore(
    persisted,
    profiles: [profile],
    knownHostsPath: "/tmp/ghosttea-workspace-restore-known-hosts",
    credentialStore: store,
    keyboardInteractiveResponder: { _ in [] }
  )

  #expect(result.document?.sessionIDs == ["session-a", "session-c"])
  #expect(result.unavailableSessionIDs == ["session-b"])
  #expect(result.sessions["session-a"]?.terminalSessionHandle == 1_000)
  #expect(result.sessions["session-c"]?.terminalSessionHandle == 1_001)
  #expect(result.sessions["session-a"]?.profileID == profileID.uuidString.lowercased())
  #expect(await result.sessions["session-a"]?.session.snapshot().reconnectState == .idle)

  for resource in result.sessions.values {
    await GhostteaSSHWorkspaceSessionFactory.disconnect(resource)
  }
}
