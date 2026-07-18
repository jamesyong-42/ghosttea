import SwiftUI

@main
struct GhostteaApp: App {
  @StateObject private var model = GhostteaAppModel()

  var body: some Scene {
    WindowGroup {
      GhostteaContentView()
        .environmentObject(model)
    }
  }
}

