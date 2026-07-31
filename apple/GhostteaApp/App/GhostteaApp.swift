import GhostteaCore
import GhostteaDiagnostics
import SwiftUI

@main
struct GhostteaApp: App {
  @StateObject private var sharedRuntime: GhostteaSharedRuntimeModel
  @StateObject private var sshModel: GhostteaSSHAppModel
  private let configuration: GhostteaConfigSnapshot

  init() {
    let configuration = ghostteaApplicationConfiguration()
    self.configuration = configuration
    let diagnostics: GhostteaDiagnosticRecorder
    #if DEBUG
      if let automationDirectory = ghostteaAutomationDirectory() {
        diagnostics =
          (try? GhostteaDiagnosticRecorder.applicationSupport(
            directoryName: automationDirectory
          ))
          ?? GhostteaDiagnosticRecorder(
            fileURL: FileManager.default.temporaryDirectory
              .appendingPathComponent("ghosttea-restoration-automation-diagnostics.json"))
      } else {
        diagnostics =
          (try? GhostteaDiagnosticRecorder.applicationSupport())
          ?? GhostteaDiagnosticRecorder(
            fileURL: FileManager.default.temporaryDirectory
              .appendingPathComponent("ghosttea-redacted-diagnostics.json"))
      }
    #else
      diagnostics =
        (try? GhostteaDiagnosticRecorder.applicationSupport())
        ?? GhostteaDiagnosticRecorder(
          fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("ghosttea-redacted-diagnostics.json"))
    #endif
    _sharedRuntime = StateObject(
      wrappedValue: GhostteaSharedRuntimeModel(diagnostics: diagnostics))
    let sshModel = GhostteaSSHAppModel(
      diagnostics: diagnostics,
      configuration: configuration
    )
    _sshModel = StateObject(wrappedValue: sshModel)
    Task { try? await diagnostics.beginLaunch() }
    #if DEBUG
      if ghostteaAutomationDirectory() != nil {
        Task { @MainActor in sshModel.start() }
      }
    #endif
  }

  var body: some Scene {
    WindowGroup(id: "terminal", for: UUID.self) { requestedSceneID in
      GhostteaSceneContainer(
        requestedSceneID: requestedSceneID.wrappedValue,
        sharedRuntime: sharedRuntime,
        sshModel: sshModel,
        configuration: configuration)
    }
  }
}

func ghostteaApplicationSupportRoot() throws -> URL {
  guard
    let root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first
  else {
    throw GhostteaAppBootstrapError.applicationSupportUnavailable
  }
  #if DEBUG
    if let automationDirectory = ghostteaAutomationDirectory() {
      return root.appendingPathComponent(automationDirectory, isDirectory: true)
    }
  #endif
  return root.appendingPathComponent("Ghosttea", isDirectory: true)
}

private func ghostteaApplicationConfiguration() -> GhostteaConfigSnapshot {
  let overlayURL = try? ghostteaApplicationSupportRoot()
    .appendingPathComponent("config.ghostty")
  do {
    return try GhostteaConfiguration.load(
      overlayURL: overlayURL,
      loadGhosttyFiles: true
    )
  } catch {
    do {
      return try GhostteaConfiguration.load(loadGhosttyFiles: false)
    } catch {
      preconditionFailure("Ghosttea configuration engine unavailable: \(error)")
    }
  }
}

private enum GhostteaAppBootstrapError: Error {
  case applicationSupportUnavailable
}

#if DEBUG
  func ghostteaAutomationDirectory() -> String? {
    let candidates = [
      ghostteaProcessRestorationAutomationDirectory(),
      ghostteaMemoryRecoveryAutomationDirectory(),
    ].compactMap { $0 }
    return candidates.count == 1 ? candidates[0] : nil
  }

  func ghostteaProcessRestorationAutomationDirectory() -> String? {
    let environment = ProcessInfo.processInfo.environment
    let prepare = environment["GHOSTTEA_AUTORUN_PROCESS_RESTORATION_PREPARE"] == "1"
    let verify = environment["GHOSTTEA_AUTORUN_PROCESS_RESTORATION_VERIFY"] == "1"
    guard prepare != verify,
      let runID = environment["GHOSTTEA_PROCESS_RESTORATION_RUN_ID"],
      runID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil
    else { return nil }
    return "GhostteaProcessRestorationAutomation-\(runID)"
  }

  func ghostteaMemoryRecoveryAutomationDirectory() -> String? {
    let environment = ProcessInfo.processInfo.environment
    guard environment["GHOSTTEA_AUTORUN_MEMORY_RECOVERY"] == "1",
      let runID = environment["GHOSTTEA_MEMORY_RECOVERY_RUN_ID"],
      runID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil
    else { return nil }
    return "GhostteaMemoryRecoveryAutomation-\(runID)"
  }
#endif

private struct GhostteaSceneContainer: View {
  @State private var sceneID: UUID
  let sharedRuntime: GhostteaSharedRuntimeModel
  let sshModel: GhostteaSSHAppModel
  let configuration: GhostteaConfigSnapshot

  init(
    requestedSceneID: UUID?,
    sharedRuntime: GhostteaSharedRuntimeModel,
    sshModel: GhostteaSSHAppModel,
    configuration: GhostteaConfigSnapshot
  ) {
    _sceneID = State(initialValue: requestedSceneID ?? UUID())
    self.sharedRuntime = sharedRuntime
    self.sshModel = sshModel
    self.configuration = configuration
  }

  var body: some View {
    GhostteaSceneRoot(
      sceneID: sceneID,
      sharedRuntime: sharedRuntime,
      sshModel: sshModel,
      configuration: configuration)
  }
}

private struct GhostteaSceneRoot: View {
  @Environment(\.openWindow) private var openWindow
  @Environment(\.dismissWindow) private var dismissWindow
  @StateObject private var sharedModel: GhostteaAppModel
  let sceneID: UUID
  let sharedRuntime: GhostteaSharedRuntimeModel
  let sshModel: GhostteaSSHAppModel
  let configuration: GhostteaConfigSnapshot

  init(
    sceneID: UUID,
    sharedRuntime: GhostteaSharedRuntimeModel,
    sshModel: GhostteaSSHAppModel,
    configuration: GhostteaConfigSnapshot
  ) {
    self.sceneID = sceneID
    self.sharedRuntime = sharedRuntime
    self.sshModel = sshModel
    self.configuration = configuration
    _sharedModel = StateObject(
      wrappedValue: GhostteaAppModel(
        sharedRuntime: sharedRuntime,
        diagnostics: sharedRuntime.diagnostics,
        configuration: configuration,
        sceneID: sceneID))
  }

  var body: some View {
    GhostteaContentView()
      .environmentObject(sharedModel)
      .environmentObject(sshModel)
      .onAppear { runMultiSceneProbeIfRequested() }
      .onDisappear {
        sharedModel.sceneDisconnected()
        #if DEBUG
          GhostteaMultiSceneProbe.shared.sceneDisappeared(sceneID: sceneID)
        #endif
      }
  }

  private func runMultiSceneProbeIfRequested() {
    #if DEBUG
      switch GhostteaMultiSceneProbe.shared.sceneAppeared(
        sceneID: sceneID,
        viewID: sharedModel.terminalViewID,
        runtime: sharedRuntime)
      {
      case .none:
        break
      case .open(let newSceneID):
        openWindow(id: "terminal", value: newSceneID)
      case .dismiss(let closingSceneID):
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(300))
          dismissWindow(id: "terminal", value: closingSceneID)
        }
      }
    #endif
  }
}
