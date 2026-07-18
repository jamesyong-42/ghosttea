import SafariServices
import SwiftUI

struct GhostteaContentView: View {
  @EnvironmentObject private var model: GhostteaAppModel
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    TabView {
      sharedSessions
        .tabItem { Label("Shared", systemImage: "rectangle.connected.to.line.below") }
      GhostteaSSHView()
        .tabItem { Label("SSH", systemImage: "terminal") }
    }
  }

  private var sharedSessions: some View {
    NavigationStack {
      Group {
        if model.selectedSession != nil {
          terminal
        } else {
          browser
        }
      }
      .navigationTitle(model.selectedSession?.title ?? "Ghosttea")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if UIDevice.current.userInterfaceIdiom == .pad {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              openWindow(id: "terminal")
            } label: {
              Label("New Window", systemImage: "plus.rectangle.on.rectangle")
            }
          }
        }
        if model.selectedSession != nil {
          ToolbarItem(placement: .topBarLeading) {
            Button("Done") { model.disconnect() }
          }
          ToolbarItem(placement: .topBarTrailing) {
            Text(model.hasControl ? "Control" : "Read-only")
              .font(.caption)
              .foregroundStyle(model.hasControl ? .green : .secondary)
          }
        } else {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              Task { await model.refreshHosts() }
            } label: {
              Image(systemName: "arrow.clockwise")
            }
            .disabled(model.phase != .running)
          }
        }
      }
    }
    .task { model.start() }
    .onChange(of: scenePhase) { _, value in model.sceneChanged(value) }
    .sheet(item: $model.authPage) { page in
      GhostteaLoginView(url: page.url, onDismiss: model.loginSheetDismissed)
        .ignoresSafeArea()
    }
  }

  private var browser: some View {
    List {
      Section {
        HStack(spacing: 12) {
          if model.isBusy { ProgressView() }
          Image(systemName: phaseIcon)
            .foregroundStyle(model.phase == .running ? .green : .secondary)
          VStack(alignment: .leading, spacing: 3) {
            Text(model.phase.rawValue)
              .font(.headline)
            Text(model.status)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }

      if model.phase == .failed || model.phase == .stopped {
        Section {
          Button("Connect private mesh") { model.start() }
        }
      }

      if !model.hosts.isEmpty {
        Section("Desktops") {
          ForEach(model.hosts, id: \.peer.tailscaleId) { host in
            Button {
              model.loadSessions(from: host)
            } label: {
              HStack {
                VStack(alignment: .leading) {
                  Text(host.displayName)
                    .foregroundStyle(.primary)
                  Text(host.peer.tailnetIPs.first ?? host.peer.hostname)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                  .font(.caption)
                  .foregroundStyle(.tertiary)
              }
            }
          }
        }
      }

      if model.selectedHostName != nil {
        Section(model.selectedHostName ?? "Sessions") {
          if model.sessions.isEmpty, !model.isBusy {
            Text("No attachable terminal sessions")
              .foregroundStyle(.secondary)
          }
          ForEach(model.sessions, id: \.sessionID) { session in
            Button {
              model.attach(to: session)
            } label: {
              HStack {
                VStack(alignment: .leading, spacing: 3) {
                  Text(session.title)
                    .foregroundStyle(.primary)
                  if let cwd = session.cwdLabel {
                    Text(cwd)
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                }
                Spacer()
                Image(systemName: session.readWrite ? "keyboard" : "eye")
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      }
    }
  }

  private var terminal: some View {
    ZStack {
      Color(red: 40 / 255, green: 44 / 255, blue: 52 / 255)
        .ignoresSafeArea()
      if let frame = model.frame {
        GhostteaSharedTerminalSurface(
          frame: frame,
          visible: scenePhase == .active,
          onGridSize: model.updateGrid,
          onHardwareInput: model.handleHardwareKey,
          onSoftwareInput: model.handleSoftwareInput,
          onMouseInput: model.handleMouse,
          onScrollRows: model.handleScroll,
          onSelectionCommit: model.copySelection,
          onSelectAll: model.copyAll)
      } else {
        ProgressView(model.status)
          .tint(.white)
          .foregroundStyle(.white)
      }
    }
  }

  private var phaseIcon: String {
    switch model.phase {
    case .running: "checkmark.circle.fill"
    case .needsLogin: "person.crop.circle.badge.questionmark"
    case .needsMachineAuth: "person.badge.shield.checkmark"
    case .failed: "exclamationmark.triangle.fill"
    case .starting, .stopping: "network"
    case .stopped: "circle"
    }
  }
}

private struct GhostteaLoginView: UIViewControllerRepresentable {
  let url: URL
  let onDismiss: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onDismiss: onDismiss) }

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let controller = SFSafariViewController(url: url)
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_: SFSafariViewController, context: Context) {}

  final class Coordinator: NSObject, SFSafariViewControllerDelegate {
    let onDismiss: () -> Void
    init(onDismiss: @escaping () -> Void) { self.onDismiss = onDismiss }
    func safariViewControllerDidFinish(_: SFSafariViewController) { onDismiss() }
  }
}
