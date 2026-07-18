import GhostteaConnectionProfiles
import SwiftUI

/// Transient editor state. Secret strings are cleared before a successful
/// request leaves the editor, but Swift/String internals may copy storage and
/// this type does not claim guaranteed zeroization.
public struct GhostteaSSHConnectionProfileEditorState {
  public var draft: GhostteaSSHConnectionProfileDraft
  public var replaceCredential: Bool
  public var password: String
  public var privateKey: String
  public var usePrivateKeyPassphrase: Bool
  public var privateKeyPassphrase: String

  private let existingProfile: GhostteaSSHConnectionProfile?

  public init(profile: GhostteaSSHConnectionProfile? = nil) {
    existingProfile = profile
    draft = profile.map(GhostteaSSHConnectionProfileDraft.init) ?? .init()
    replaceCredential = profile == nil
    password = ""
    privateKey = ""
    usePrivateKeyPassphrase = false
    privateKeyPassphrase = ""
  }

  public mutating func takeSaveRequest() throws -> GhostteaSSHConnectionProfileSaveRequest {
    let submission: GhostteaSSHProfileCredentialSubmission
    if !replaceCredential, existingProfile != nil {
      submission = .keepExisting
    } else {
      switch draft.authenticationKind {
      case .password:
        submission = .password(Data(password.utf8))
      case .privateKey:
        submission = .privateKey(
          privateKey: Data(privateKey.utf8),
          passphrase: usePrivateKeyPassphrase ? Data(privateKeyPassphrase.utf8) : nil
        )
      case .keyboardInteractive:
        submission = .keyboardInteractive
      }
    }
    let request = GhostteaSSHConnectionProfileSaveRequest(
      draft: draft,
      credentialSubmission: submission
    )
    _ = try request.prepare(existingProfile: existingProfile)
    password = ""
    privateKey = ""
    privateKeyPassphrase = ""
    return request
  }
}

public struct GhostteaSSHConnectionProfilesView: View {
  public let profiles: [GhostteaSSHConnectionProfile]
  private let onSave: (GhostteaSSHConnectionProfileSaveRequest) -> Void
  private let onDelete: (UUID) -> Void

  @State private var editedProfile: GhostteaSSHConnectionProfile?
  @State private var presentsEditor = false

  public init(
    profiles: [GhostteaSSHConnectionProfile],
    onSave: @escaping (GhostteaSSHConnectionProfileSaveRequest) -> Void,
    onDelete: @escaping (UUID) -> Void
  ) {
    self.profiles = profiles
    self.onSave = onSave
    self.onDelete = onDelete
  }

  public var body: some View {
    NavigationStack {
      Group {
        if profiles.isEmpty {
          ContentUnavailableView(
            "No Saved Connections",
            systemImage: "server.rack",
            description: Text("Add an SSH connection to open it from the command palette.")
          )
        } else {
          List {
            ForEach(profiles, id: \.id) { profile in
              Button {
                editedProfile = profile
                presentsEditor = true
              } label: {
                VStack(alignment: .leading, spacing: 3) {
                  Text(profile.name)
                    .foregroundStyle(.primary)
                  Text("\(profile.username)@\(profile.host):\(profile.port)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
              }
              .accessibilityIdentifier("ghosttea.profile.\(profile.id.uuidString.lowercased())")
              .swipeActions {
                Button("Delete", role: .destructive) { onDelete(profile.id) }
              }
            }
          }
        }
      }
      .navigationTitle("Saved Connections")
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button {
            editedProfile = nil
            presentsEditor = true
          } label: {
            Label("Add Connection", systemImage: "plus")
          }
          .accessibilityIdentifier("ghosttea.profile.add")
        }
      }
      .sheet(isPresented: $presentsEditor) {
        GhostteaSSHConnectionProfileEditorView(
          profile: editedProfile,
          onCancel: { presentsEditor = false },
          onSave: { request in
            presentsEditor = false
            onSave(request)
          }
        )
      }
    }
    .accessibilityIdentifier("ghosttea.connection-profiles")
  }
}

public struct GhostteaSSHConnectionProfileEditorView: View {
  private let onCancel: () -> Void
  private let onSave: (GhostteaSSHConnectionProfileSaveRequest) -> Void
  private let isEditing: Bool

  @State private var state: GhostteaSSHConnectionProfileEditorState
  @State private var validationMessage: String?

  public init(
    profile: GhostteaSSHConnectionProfile?,
    onCancel: @escaping () -> Void,
    onSave: @escaping (GhostteaSSHConnectionProfileSaveRequest) -> Void
  ) {
    isEditing = profile != nil
    self.onCancel = onCancel
    self.onSave = onSave
    _state = State(initialValue: GhostteaSSHConnectionProfileEditorState(profile: profile))
  }

  public var body: some View {
    NavigationStack {
      Form {
        Section("Connection") {
          TextField("Name", text: $state.draft.name)
          TextField("Host", text: $state.draft.host)
            .ghostteaConnectionIdentifierInput()
          TextField("Port", text: $state.draft.port)
            .ghostteaNumberInput()
          TextField("Username", text: $state.draft.username)
            .ghostteaConnectionIdentifierInput()
        }

        Section("Authentication") {
          Picker("Method", selection: $state.draft.authenticationKind) {
            ForEach(GhostteaSSHProfileAuthenticationKind.allCases, id: \.self) {
              Text($0.rawValue).tag($0)
            }
          }
          .onChange(of: state.draft.authenticationKind) { _, _ in
            state.replaceCredential = true
          }

          if isEditing {
            Toggle("Replace saved credential", isOn: $state.replaceCredential)
          }
          if state.replaceCredential {
            credentialFields
          }
        }

        Section("Session") {
          Picker("Open", selection: $state.draft.attachKind) {
            ForEach(GhostteaSSHProfileAttachKind.allCases, id: \.self) {
              Text($0.rawValue).tag($0)
            }
          }
          if state.draft.attachKind != .shell {
            TextField("Session name", text: $state.draft.attachSessionName)
              .ghostteaConnectionIdentifierInput()
          }
        }

        Section("Terminal") {
          TextField("Terminal type", text: $state.draft.terminalType)
            .ghostteaConnectionIdentifierInput()
          TextField("Columns", text: $state.draft.columns)
            .ghostteaNumberInput()
          TextField("Rows", text: $state.draft.rows)
            .ghostteaNumberInput()
        }

        if let validationMessage {
          Section {
            Text(validationMessage)
              .foregroundStyle(.red)
          }
        }
      }
      .navigationTitle(isEditing ? "Edit Connection" : "New Connection")
      .ghostteaInlineNavigationTitle()
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save", action: save)
            .accessibilityIdentifier("ghosttea.profile.save")
        }
      }
    }
  }

  @ViewBuilder private var credentialFields: some View {
    switch state.draft.authenticationKind {
    case .password:
      SecureField("Password", text: $state.password)
    case .privateKey:
      TextEditor(text: $state.privateKey)
        .frame(minHeight: 110)
        .accessibilityLabel("Private key")
      Toggle("Key has passphrase", isOn: $state.usePrivateKeyPassphrase)
      if state.usePrivateKeyPassphrase {
        SecureField("Private-key passphrase", text: $state.privateKeyPassphrase)
      }
    case .keyboardInteractive:
      Text("Prompts are requested at connection time and are never saved in the profile.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  private func save() {
    do {
      let request = try state.takeSaveRequest()
      validationMessage = nil
      onSave(request)
    } catch {
      validationMessage = validationMessage(for: error)
    }
  }

  private func validationMessage(for error: any Error) -> String {
    switch error {
    case GhostteaSSHConnectionProfileDraftError.invalidPort:
      "Enter a valid port from 1 through 65535."
    case GhostteaSSHConnectionProfileDraftError.invalidColumns:
      "Enter a valid initial column count."
    case GhostteaSSHConnectionProfileDraftError.invalidRows:
      "Enter a valid initial row count."
    case GhostteaSSHConnectionProfileDraftError.emptyAttachSessionName:
      "Enter the tmux or Zellij session name."
    case GhostteaSSHConnectionProfileDraftError.emptyPrivateKey:
      "Paste a private key."
    case GhostteaSSHConnectionProfileError.emptyName:
      "Enter a connection name."
    case GhostteaSSHConnectionProfileError.emptyHost:
      "Enter a host."
    case GhostteaSSHConnectionProfileError.emptyUsername:
      "Enter a username."
    case GhostteaSSHConnectionProfileError.invalidPort:
      "Enter a valid port from 1 through 65535."
    case GhostteaSSHConnectionProfileError.invalidTerminalSize:
      "Enter terminal dimensions from 1 through 65535."
    default:
      "Review the connection fields and try again."
    }
  }
}

extension View {
  @ViewBuilder fileprivate func ghostteaConnectionIdentifierInput() -> some View {
    #if os(iOS)
      textInputAutocapitalization(.never)
        .autocorrectionDisabled()
    #else
      self
    #endif
  }

  @ViewBuilder fileprivate func ghostteaNumberInput() -> some View {
    #if os(iOS)
      keyboardType(.numberPad)
    #else
      self
    #endif
  }

  @ViewBuilder fileprivate func ghostteaInlineNavigationTitle() -> some View {
    #if os(iOS)
      navigationBarTitleDisplayMode(.inline)
    #else
      self
    #endif
  }
}
