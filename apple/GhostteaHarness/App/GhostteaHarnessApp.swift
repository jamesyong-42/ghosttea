import SwiftUI

@main
struct GhostteaHarnessApp: App {
  @StateObject private var model = HarnessModel()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(model)
    }
  }
}
