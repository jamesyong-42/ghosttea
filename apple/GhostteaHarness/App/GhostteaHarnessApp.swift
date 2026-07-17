import SwiftUI

@main
struct GhostteaHarnessApp: App {
  @StateObject private var model = HarnessModel()
  @StateObject private var sceneLifecycle = HarnessSceneLifecycleCoordinator()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(model)
        .environmentObject(sceneLifecycle)
    }
  }
}
