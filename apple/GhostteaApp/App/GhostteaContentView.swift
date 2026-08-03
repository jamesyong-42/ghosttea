import GhostteaCore
import SafariServices
import SwiftUI

struct GhostteaContentView: View {
  @EnvironmentObject private var model: GhostteaAppModel
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.openWindow) private var openWindow
  @State private var presentsAbout = false

  var body: some View {
    TabView {
      sharedSessions
        .tabItem { Label("Shared", systemImage: "rectangle.connected.to.line.below") }
      GhostteaSSHView()
        .tabItem { Label("SSH", systemImage: "terminal") }
      GhostteaSettingsView()
        .tabItem { Label("Settings", systemImage: "gearshape") }
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
      .navigationTitle(
        model.selectedSession.map { GhostteaTerminalTitle.textPresentation($0.title) }
          ?? "Ghosttea"
      )
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if UIDevice.current.userInterfaceIdiom == .pad {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              openWindow(id: "terminal", value: UUID())
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
            controlStatus
          }
        } else {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              presentsAbout = true
            } label: {
              Label("About Ghosttea", systemImage: "info.circle")
            }
          }
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
    .onReceive(NotificationCenter.default.publisher(for: UIApplication.willTerminateNotification)) {
      _ in
      model.terminationRecorded()
    }
    .sheet(item: $model.authPage) { page in
      GhostteaLoginView(url: page.url, onDismiss: model.loginSheetDismissed)
        .ignoresSafeArea()
    }
    .sheet(isPresented: $presentsAbout) {
      GhostteaAboutView(diagnostics: model.diagnostics)
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
                  Text(GhostteaTerminalTitle.textPresentation(session.title))
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
      GhostteaTerminalTransparencyBackdrop()
        .ignoresSafeArea()
      if let frame = model.frame {
        GhostteaSharedTerminalSurface(
          frame: frame,
          visible: scenePhase == .active,
          configuration: model.presentationConfiguration,
          onGridSize: model.updateGrid,
          onNeedsFullRefresh: model.requestFullRefresh,
          onHardwareInput: model.handleHardwareKey,
          onSoftwareInput: model.handleSoftwareInput,
          onMouseInput: model.handleMouse,
          onScrollRows: model.handleScroll,
          onSelectionCommit: model.copySelection,
          onSelectAll: model.copyAll
        )
        // §8.1's "cooled" treatment: the retained frame stays legible and
        // copyable, but plainly is not live. No animation — the state it
        // reports is not a transition worth watching.
        .saturation(isCooled ? 0.2 : 1)
        .opacity(isCooled ? 0.65 : 1)
      } else {
        ProgressView(model.status)
          .tint(model.presentationConfiguration.terminalForegroundColor)
          .foregroundStyle(model.presentationConfiguration.terminalForegroundColor)
      }
    }
    .overlay(alignment: .top) {
      if let banner = model.banner {
        GhostteaAttachmentBannerView(banner: banner, onAction: model.perform)
      }
    }
    .overlay(alignment: .bottom) {
      if let cue = model.inputCue {
        GhostteaAttachmentInputCueView(cue: cue)
          .padding(.bottom, 24)
      }
    }
  }

  @ViewBuilder private var controlStatus: some View {
    if model.hasControl {
      Label("Control", systemImage: "checkmark.circle.fill")
        .labelStyle(.titleOnly)
        .font(.caption)
        .foregroundStyle(.green)
    } else if model.canTakeControl {
      Button {
        model.takeControl()
      } label: {
        if model.isClaimingControl {
          ProgressView()
            .controlSize(.small)
            .accessibilityLabel("Taking control")
        } else {
          Text("Take Control")
            .font(.caption)
        }
      }
      .disabled(model.isClaimingControl)
    } else {
      Text("Read-only")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  /// Whether the frame on screen is retained rather than live.
  private var isCooled: Bool { model.banner?.coolsTerminal == true }

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

/// A deliberately recognizable app-owned layer behind the terminal. At full
/// terminal background opacity it disappears; reducing `background-opacity`
/// reveals the colored shapes and watermark without making the iOS window
/// itself transparent.
struct GhostteaTerminalTransparencyBackdrop: View {
  var body: some View {
    GeometryReader { proxy in
      let width = max(proxy.size.width, 1)
      let height = max(proxy.size.height, 1)
      ZStack {
        LinearGradient(
          colors: [
            Color(red: 0.05, green: 0.10, blue: 0.20),
            Color(red: 0.15, green: 0.08, blue: 0.24),
            Color(red: 0.03, green: 0.19, blue: 0.22),
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing)

        Circle()
          .fill(Color.cyan.opacity(0.48))
          .frame(width: width * 0.62, height: width * 0.62)
          .blur(radius: 10)
          .offset(x: width * 0.34, y: -height * 0.31)

        Circle()
          .fill(Color.orange.opacity(0.42))
          .frame(width: width * 0.44, height: width * 0.44)
          .blur(radius: 8)
          .offset(x: -width * 0.38, y: height * 0.28)

        RoundedRectangle(cornerRadius: 42, style: .continuous)
          .stroke(Color.white.opacity(0.2), lineWidth: 2)
          .frame(width: width * 0.78, height: min(height * 0.38, 280))
          .rotationEffect(.degrees(-14))
          .offset(x: width * 0.22, y: height * 0.12)

        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Image(systemName: "circle.lefthalf.filled")
            Text("SWIFTUI BACKDROP")
          }
          .font(.caption2.weight(.semibold))
          .tracking(1.8)
          Text("GHOSTTEA GLASS")
            .font(.system(size: min(width * 0.1, 48), weight: .black, design: .rounded))
        }
        .foregroundStyle(Color.white.opacity(0.22))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .multilineTextAlignment(.trailing)
        .padding(28)
      }
      .clipped()
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
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
