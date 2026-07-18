import SwiftUI

@main
struct GhostteaApp: App {
  @StateObject private var model = GhostteaAppModel()
  @StateObject private var sshModel = GhostteaSSHAppModel()

  var body: some Scene {
    WindowGroup {
      GhostteaContentView()
        .environmentObject(model)
        .environmentObject(sshModel)
    }
  }
}
