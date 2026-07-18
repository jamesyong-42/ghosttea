import Foundation
import GhostteaCredentials

public enum GhostteaSSHProfileAuthenticationKind: String, CaseIterable, Equatable, Sendable {
  case password = "Password"
  case privateKey = "Private key"
  case keyboardInteractive = "Keyboard interactive"
}

public enum GhostteaSSHProfileAttachKind: String, CaseIterable, Equatable, Sendable {
  case shell = "Shell"
  case tmux = "tmux"
  case zellij = "Zellij"
}

public enum GhostteaSSHConnectionProfileDraftError: Error, Equatable, Sendable {
  case invalidPort(String)
  case invalidColumns(String)
  case invalidRows(String)
  case emptyAttachSessionName
  case authenticationKindMismatch
  case missingExistingAuthentication
  case emptyPrivateKey
}

/// Editable, non-secret connection metadata.
///
/// Secret fields deliberately do not exist here. A UI submits them separately
/// through `GhostteaSSHProfileCredentialSubmission`, which can be consumed and
/// released without ever making secret bytes part of profile persistence.
public struct GhostteaSSHConnectionProfileDraft: Equatable, Sendable {
  public var id: UUID
  public var name: String
  public var host: String
  public var port: String
  public var username: String
  public var authenticationKind: GhostteaSSHProfileAuthenticationKind
  public var attachKind: GhostteaSSHProfileAttachKind
  public var attachSessionName: String
  public var terminalType: String
  public var columns: String
  public var rows: String

  public init(
    id: UUID = UUID(),
    name: String = "",
    host: String = "",
    port: String = "22",
    username: String = "",
    authenticationKind: GhostteaSSHProfileAuthenticationKind = .password,
    attachKind: GhostteaSSHProfileAttachKind = .shell,
    attachSessionName: String = "",
    terminalType: String = "xterm-256color",
    columns: String = "80",
    rows: String = "24"
  ) {
    self.id = id
    self.name = name
    self.host = host
    self.port = port
    self.username = username
    self.authenticationKind = authenticationKind
    self.attachKind = attachKind
    self.attachSessionName = attachSessionName
    self.terminalType = terminalType
    self.columns = columns
    self.rows = rows
  }

  public init(profile: GhostteaSSHConnectionProfile) {
    let authenticationKind: GhostteaSSHProfileAuthenticationKind
    switch profile.authentication {
    case .password: authenticationKind = .password
    case .privateKey: authenticationKind = .privateKey
    case .keyboardInteractive: authenticationKind = .keyboardInteractive
    }
    let attachKind: GhostteaSSHProfileAttachKind
    let attachSessionName: String
    switch profile.attach {
    case .shell:
      attachKind = .shell
      attachSessionName = ""
    case .tmux(let sessionName):
      attachKind = .tmux
      attachSessionName = sessionName
    case .zellij(let sessionName):
      attachKind = .zellij
      attachSessionName = sessionName
    }
    self.init(
      id: profile.id,
      name: profile.name,
      host: profile.host,
      port: String(profile.port),
      username: profile.username,
      authenticationKind: authenticationKind,
      attachKind: attachKind,
      attachSessionName: attachSessionName,
      terminalType: profile.terminalType,
      columns: String(profile.columns),
      rows: String(profile.rows)
    )
  }

  public func profile(
    authentication: GhostteaSSHProfileAuthentication
  ) throws -> GhostteaSSHConnectionProfile {
    guard authentication.kind == authenticationKind else {
      throw GhostteaSSHConnectionProfileDraftError.authenticationKindMismatch
    }
    guard let parsedPort = Int(port) else {
      throw GhostteaSSHConnectionProfileDraftError.invalidPort(port)
    }
    guard let parsedColumns = Int(columns) else {
      throw GhostteaSSHConnectionProfileDraftError.invalidColumns(columns)
    }
    guard let parsedRows = Int(rows) else {
      throw GhostteaSSHConnectionProfileDraftError.invalidRows(rows)
    }
    let attach: GhostteaSSHProfileAttach
    switch attachKind {
    case .shell:
      attach = .shell
    case .tmux, .zellij:
      let sessionName = attachSessionName.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !sessionName.isEmpty else {
        throw GhostteaSSHConnectionProfileDraftError.emptyAttachSessionName
      }
      attach =
        attachKind == .tmux
        ? .tmux(sessionName: sessionName)
        : .zellij(
          sessionName: sessionName
        )
    }
    return try GhostteaSSHConnectionProfile(
      id: id,
      name: name,
      host: host,
      port: parsedPort,
      username: username,
      authentication: authentication,
      attach: attach,
      terminalType: terminalType,
      columns: parsedColumns,
      rows: parsedRows
    )
  }
}

extension GhostteaSSHProfileAuthentication {
  public var kind: GhostteaSSHProfileAuthenticationKind {
    switch self {
    case .password: .password
    case .privateKey: .privateKey
    case .keyboardInteractive: .keyboardInteractive
    }
  }

  public var credentialIDs: [SSHCredentialID] {
    switch self {
    case .password(let credential):
      [credential]
    case .privateKey(let privateKeyCredential, let passphraseCredential):
      [privateKeyCredential] + [passphraseCredential].compactMap { $0 }
    case .keyboardInteractive:
      []
    }
  }
}

public enum GhostteaSSHProfileCredentialSubmission: Equatable, Sendable {
  case keepExisting
  case password(Data)
  case privateKey(privateKey: Data, passphrase: Data?)
  case keyboardInteractive
}

public struct GhostteaSSHCredentialWrite: Equatable, Sendable {
  public let credential: SSHCredentialID
  public let secret: Data

  public init(credential: SSHCredentialID, secret: Data) {
    self.credential = credential
    self.secret = secret
  }
}

public struct GhostteaSSHPreparedProfileSave: Equatable, Sendable {
  public let profile: GhostteaSSHConnectionProfile
  public let credentialWrites: [GhostteaSSHCredentialWrite]

  public init(
    profile: GhostteaSSHConnectionProfile,
    credentialWrites: [GhostteaSSHCredentialWrite]
  ) {
    self.profile = profile
    self.credentialWrites = credentialWrites
  }
}

public struct GhostteaSSHConnectionProfileSaveRequest: Equatable, Sendable {
  public let draft: GhostteaSSHConnectionProfileDraft
  public let credentialSubmission: GhostteaSSHProfileCredentialSubmission

  public init(
    draft: GhostteaSSHConnectionProfileDraft,
    credentialSubmission: GhostteaSSHProfileCredentialSubmission
  ) {
    self.draft = draft
    self.credentialSubmission = credentialSubmission
  }

  public func prepare(
    existingProfile: GhostteaSSHConnectionProfile?,
    connectionID: UUID = UUID()
  ) throws -> GhostteaSSHPreparedProfileSave {
    let authentication: GhostteaSSHProfileAuthentication
    let writes: [GhostteaSSHCredentialWrite]
    switch credentialSubmission {
    case .keepExisting:
      guard let existingProfile else {
        throw GhostteaSSHConnectionProfileDraftError.missingExistingAuthentication
      }
      authentication = existingProfile.authentication
      writes = []
    case .password(let secret):
      let credential = SSHCredentialID(connectionID: connectionID, kind: .password)
      authentication = .password(credential: credential)
      writes = [GhostteaSSHCredentialWrite(credential: credential, secret: secret)]
    case .privateKey(let privateKey, let passphrase):
      guard !privateKey.isEmpty else {
        throw GhostteaSSHConnectionProfileDraftError.emptyPrivateKey
      }
      let privateKeyCredential = SSHCredentialID(
        connectionID: connectionID,
        kind: .privateKey
      )
      let passphraseCredential = passphrase.map { _ in
        SSHCredentialID(connectionID: connectionID, kind: .privateKeyPassphrase)
      }
      authentication = .privateKey(
        privateKeyCredential: privateKeyCredential,
        passphraseCredential: passphraseCredential
      )
      writes =
        [GhostteaSSHCredentialWrite(credential: privateKeyCredential, secret: privateKey)]
        + zip([passphraseCredential].compactMap { $0 }, [passphrase].compactMap { $0 }).map {
          GhostteaSSHCredentialWrite(credential: $0.0, secret: $0.1)
        }
    case .keyboardInteractive:
      authentication = .keyboardInteractive
      writes = []
    }
    return GhostteaSSHPreparedProfileSave(
      profile: try draft.profile(authentication: authentication),
      credentialWrites: writes
    )
  }
}
