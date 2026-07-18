import GhostteaConnectionProfilesUI
import GhostteaSSH
import SwiftUI

struct GhostteaSSHView: View {
  @EnvironmentObject private var model: GhostteaSSHAppModel
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    NavigationStack {
      Group {
        if model.activeProfile != nil { terminal } else { connections }
      }
      .navigationTitle(model.activeProfile?.name ?? "SSH")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if model.activeProfile != nil {
          ToolbarItem(placement: .topBarLeading) {
            Button("Done") { model.disconnect() }
          }
          ToolbarItem(placement: .topBarTrailing) {
            if model.status == "Reconnect available" {
              Button("Reconnect") { model.reconnect() }
            } else {
              Text(model.status).font(.caption).foregroundStyle(.secondary)
            }
          }
        } else {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              model.presentsProfileManager = true
            } label: {
              Label("Manage connections", systemImage: "plus")
            }
          }
        }
      }
    }
    .task { model.start() }
    .onChange(of: scenePhase) { _, phase in model.sceneChanged(phase) }
    .sheet(isPresented: $model.presentsProfileManager) {
      GhostteaSSHConnectionProfilesView(
        profiles: model.profiles,
        onSave: model.saveProfile,
        onDelete: model.deleteProfile
      )
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { model.presentsProfileManager = false }
        }
      }
    }
    .sheet(item: $model.pendingKeyboardChallenge) { pending in
      GhostteaKeyboardChallengeView(
        challenge: pending.challenge,
        onCancel: model.cancelKeyboardChallenge,
        onSubmit: model.resolveKeyboardChallenge
      )
      .interactiveDismissDisabled()
    }
    .confirmationDialog(
      "Verify SSH host",
      isPresented: hostKeyPresented,
      titleVisibility: .visible,
      presenting: model.pendingHostKey
    ) { _ in
      Button("Trust Once") { model.resolveHostKey(.acceptOnce) }
      Button("Trust & Save") { model.resolveHostKey(.acceptAndStore) }
      Button("Reject", role: .destructive) { model.resolveHostKey(.reject) }
    } message: { pending in
      let challenge = pending.challenge
      Text(
        "\(challenge.status == .changed ? "Warning: the saved key changed.\n" : "")"
          + "\(challenge.host):\(challenge.port)\n\(challenge.algorithm)\n\(challenge.fingerprint)")
    }
  }

  private var connections: some View {
    List {
      Section {
        Text(model.status).font(.footnote).foregroundStyle(.secondary)
      }
      if model.profiles.isEmpty {
        ContentUnavailableView(
          "No Saved Connections",
          systemImage: "server.rack",
          description: Text("Add an SSH server; credentials stay in this device's Keychain."))
      } else {
        Section("Saved Connections") {
          ForEach(model.profiles, id: \.id) { profile in
            Button {
              model.connect(profile)
            } label: {
              HStack {
                VStack(alignment: .leading, spacing: 3) {
                  Text(profile.name).foregroundStyle(.primary)
                  Text("\(profile.username)@\(profile.host):\(profile.port)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
              }
            }
            .disabled(model.isBusy)
          }
        }
      }
    }
  }

  private var terminal: some View {
    ZStack {
      Color(red: 40 / 255, green: 44 / 255, blue: 52 / 255).ignoresSafeArea()
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
        ProgressView(model.status).tint(.white).foregroundStyle(.white)
      }
    }
  }

  private var hostKeyPresented: Binding<Bool> {
    Binding(
      get: { model.pendingHostKey != nil },
      set: { presented in
        if !presented, model.pendingHostKey != nil { model.resolveHostKey(.reject) }
      })
  }
}

private struct GhostteaKeyboardChallengeView: View {
  let challenge: GhostteaSSHKeyboardInteractiveChallenge
  let onCancel: () -> Void
  let onSubmit: ([String]) -> Void

  @State private var responses: [String]

  init(
    challenge: GhostteaSSHKeyboardInteractiveChallenge,
    onCancel: @escaping () -> Void,
    onSubmit: @escaping ([String]) -> Void
  ) {
    self.challenge = challenge
    self.onCancel = onCancel
    self.onSubmit = onSubmit
    _responses = State(initialValue: Array(repeating: "", count: challenge.prompts.count))
  }

  var body: some View {
    NavigationStack {
      Form {
        if !challenge.instruction.isEmpty {
          Section { Text(challenge.instruction).font(.footnote) }
        }
        Section {
          ForEach(Array(challenge.prompts.enumerated()), id: \.offset) { index, prompt in
            if prompt.echoesResponse {
              TextField(prompt.text, text: $responses[index])
            } else {
              SecureField(prompt.text, text: $responses[index])
            }
          }
        }
      }
      .navigationTitle(challenge.name.isEmpty ? "SSH verification" : challenge.name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
        ToolbarItem(placement: .confirmationAction) {
          Button("Continue") { onSubmit(responses) }
        }
      }
    }
  }
}
