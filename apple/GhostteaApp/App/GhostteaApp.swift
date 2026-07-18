import SwiftUI

@main
struct GhostteaApp: App {
  @StateObject private var sharedRuntime = GhostteaSharedRuntimeModel()
  @StateObject private var sshModel = GhostteaSSHAppModel()

  var body: some Scene {
    WindowGroup(id: "terminal") {
      GhostteaSceneRoot(sharedRuntime: sharedRuntime, sshModel: sshModel)
    }
  }
}

private struct GhostteaSceneRoot: View {
  @StateObject private var sharedModel: GhostteaAppModel
  let sshModel: GhostteaSSHAppModel

  init(sharedRuntime: GhostteaSharedRuntimeModel, sshModel: GhostteaSSHAppModel) {
    self.sshModel = sshModel
    _sharedModel = StateObject(
      wrappedValue: GhostteaAppModel(sharedRuntime: sharedRuntime))
  }

  var body: some View {
    GhostteaContentView()
      .environmentObject(sharedModel)
      .environmentObject(sshModel)
      .onDisappear { sharedModel.sceneDisconnected() }
  }
}
