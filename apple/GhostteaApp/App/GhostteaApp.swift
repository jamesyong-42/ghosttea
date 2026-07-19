import GhostteaDiagnostics
import SwiftUI

@main
struct GhostteaApp: App {
  @StateObject private var sharedRuntime: GhostteaSharedRuntimeModel
  @StateObject private var sshModel: GhostteaSSHAppModel

  init() {
    let diagnostics: GhostteaDiagnosticRecorder
    #if DEBUG
      if let automationDirectory = ghostteaProcessRestorationAutomationDirectory() {
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
    let sshModel = GhostteaSSHAppModel(diagnostics: diagnostics)
    _sshModel = StateObject(wrappedValue: sshModel)
    Task { try? await diagnostics.beginLaunch() }
    #if DEBUG
      if ghostteaProcessRestorationAutomationDirectory() != nil {
        Task { @MainActor in sshModel.start() }
      }
    #endif
  }

  var body: some Scene {
    WindowGroup(id: "terminal", for: UUID.self) { requestedSceneID in
      GhostteaSceneContainer(
        requestedSceneID: requestedSceneID.wrappedValue,
        sharedRuntime: sharedRuntime,
        sshModel: sshModel)
    }
  }
}

#if DEBUG
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
#endif

private struct GhostteaSceneContainer: View {
  @State private var sceneID: UUID
  let sharedRuntime: GhostteaSharedRuntimeModel
  let sshModel: GhostteaSSHAppModel

  init(
    requestedSceneID: UUID?,
    sharedRuntime: GhostteaSharedRuntimeModel,
    sshModel: GhostteaSSHAppModel
  ) {
    _sceneID = State(initialValue: requestedSceneID ?? UUID())
    self.sharedRuntime = sharedRuntime
    self.sshModel = sshModel
  }

  var body: some View {
    GhostteaSceneRoot(
      sceneID: sceneID,
      sharedRuntime: sharedRuntime,
      sshModel: sshModel)
  }
}

private struct GhostteaSceneRoot: View {
  @Environment(\.openWindow) private var openWindow
  @Environment(\.dismissWindow) private var dismissWindow
  @StateObject private var sharedModel: GhostteaAppModel
  let sceneID: UUID
  let sharedRuntime: GhostteaSharedRuntimeModel
  let sshModel: GhostteaSSHAppModel

  init(
    sceneID: UUID,
    sharedRuntime: GhostteaSharedRuntimeModel,
    sshModel: GhostteaSSHAppModel
  ) {
    self.sceneID = sceneID
    self.sharedRuntime = sharedRuntime
    self.sshModel = sshModel
    _sharedModel = StateObject(
      wrappedValue: GhostteaAppModel(
        sharedRuntime: sharedRuntime,
        diagnostics: sharedRuntime.diagnostics,
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
