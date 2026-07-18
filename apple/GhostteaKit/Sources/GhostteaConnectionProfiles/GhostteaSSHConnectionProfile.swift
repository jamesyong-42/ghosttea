import Foundation
import GhostteaCredentials
import GhostteaSSH

public let ghostteaSSHConnectionProfileSchemaVersion = 1

public enum GhostteaSSHProfileAuthentication: Equatable, Sendable, Codable {
  case password(credential: SSHCredentialID)
  case privateKey(
    privateKeyCredential: SSHCredentialID,
    passphraseCredential: SSHCredentialID?
  )
  case keyboardInteractive

  private enum CodingKeys: String, CodingKey {
    case kind
    case credential
    case privateKeyCredential
    case passphraseCredential
  }

  private enum Kind: String, Codable {
    case password
    case privateKey = "private-key"
    case keyboardInteractive = "keyboard-interactive"
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .kind) {
    case .password:
      self = .password(
        credential: try container.decode(SSHCredentialID.self, forKey: .credential)
      )
    case .privateKey:
      self = .privateKey(
        privateKeyCredential: try container.decode(
          SSHCredentialID.self,
          forKey: .privateKeyCredential
        ),
        passphraseCredential: try container.decodeIfPresent(
          SSHCredentialID.self,
          forKey: .passphraseCredential
        )
      )
    case .keyboardInteractive:
      self = .keyboardInteractive
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .password(let credential):
      try container.encode(Kind.password, forKey: .kind)
      try container.encode(credential, forKey: .credential)
    case .privateKey(let privateKeyCredential, let passphraseCredential):
      try container.encode(Kind.privateKey, forKey: .kind)
      try container.encode(privateKeyCredential, forKey: .privateKeyCredential)
      try container.encodeIfPresent(passphraseCredential, forKey: .passphraseCredential)
    case .keyboardInteractive:
      try container.encode(Kind.keyboardInteractive, forKey: .kind)
    }
  }
}

public enum GhostteaSSHProfileAttach: Equatable, Sendable, Codable {
  case shell
  case tmux(sessionName: String)
  case zellij(sessionName: String)

  private enum CodingKeys: String, CodingKey {
    case kind
    case sessionName
  }

  private enum Kind: String, Codable {
    case shell
    case tmux
    case zellij
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .kind) {
    case .shell:
      self = .shell
    case .tmux:
      self = .tmux(sessionName: try container.decode(String.self, forKey: .sessionName))
    case .zellij:
      self = .zellij(sessionName: try container.decode(String.self, forKey: .sessionName))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .shell:
      try container.encode(Kind.shell, forKey: .kind)
    case .tmux(let sessionName):
      try container.encode(Kind.tmux, forKey: .kind)
      try container.encode(sessionName, forKey: .sessionName)
    case .zellij(let sessionName):
      try container.encode(Kind.zellij, forKey: .kind)
      try container.encode(sessionName, forKey: .sessionName)
    }
  }

  fileprivate var sshAttachProfile: GhostteaSSHAttachProfile {
    switch self {
    case .shell: .shell
    case .tmux(let sessionName): .tmux(sessionName: sessionName)
    case .zellij(let sessionName): .zellij(sessionName: sessionName)
    }
  }
}

public enum GhostteaSSHConnectionProfileError: Error, Equatable, Sendable {
  case unsupportedVersion(Int)
  case emptyName
  case emptyHost
  case emptyUsername
  case invalidPort(Int)
  case invalidTerminalSize(columns: Int, rows: Int)
  case invalidPasswordCredentialKind
  case invalidPrivateKeyCredentialKind
  case invalidPassphraseCredentialKind
  case mismatchedCredentialConnection
  case missingKeyboardInteractiveResponder
  case duplicateProfileID(UUID)
}

/// A versioned, non-secret recipe for recreating an SSH session.
///
/// Host and username are ordinary connection metadata. Authentication cases
/// contain only opaque Keychain references; there is deliberately no password,
/// private-key data, passphrase, or filesystem-key-path field.
public struct GhostteaSSHConnectionProfile: Equatable, Sendable, Codable {
  public let version: Int
  public let id: UUID
  public let name: String
  public let host: String
  public let port: Int
  public let username: String
  public let authentication: GhostteaSSHProfileAuthentication
  public let attach: GhostteaSSHProfileAttach
  public let terminalType: String
  public let columns: Int
  public let rows: Int

  private enum CodingKeys: String, CodingKey {
    case version
    case id
    case name
    case host
    case port
    case username
    case authentication
    case attach
    case terminalType
    case columns
    case rows
  }

  public init(
    version: Int = ghostteaSSHConnectionProfileSchemaVersion,
    id: UUID = UUID(),
    name: String,
    host: String,
    port: Int = 22,
    username: String,
    authentication: GhostteaSSHProfileAuthentication,
    attach: GhostteaSSHProfileAttach = .shell,
    terminalType: String = "xterm-256color",
    columns: Int = 80,
    rows: Int = 24
  ) throws {
    guard version == ghostteaSSHConnectionProfileSchemaVersion else {
      throw GhostteaSSHConnectionProfileError.unsupportedVersion(version)
    }
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw GhostteaSSHConnectionProfileError.emptyName
    }
    guard !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw GhostteaSSHConnectionProfileError.emptyHost
    }
    guard !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw GhostteaSSHConnectionProfileError.emptyUsername
    }
    guard (1...65_535).contains(port) else {
      throw GhostteaSSHConnectionProfileError.invalidPort(port)
    }
    guard
      (1...Int(UInt16.max)).contains(columns),
      (1...Int(UInt16.max)).contains(rows)
    else {
      throw GhostteaSSHConnectionProfileError.invalidTerminalSize(
        columns: columns,
        rows: rows
      )
    }
    try Self.validate(authentication)
    self.version = version
    self.id = id
    self.name = name
    self.host = host
    self.port = port
    self.username = username
    self.authentication = authentication
    self.attach = attach
    self.terminalType = terminalType
    self.columns = columns
    self.rows = rows
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      version: container.decode(Int.self, forKey: .version),
      id: container.decode(UUID.self, forKey: .id),
      name: container.decode(String.self, forKey: .name),
      host: container.decode(String.self, forKey: .host),
      port: container.decode(Int.self, forKey: .port),
      username: container.decode(String.self, forKey: .username),
      authentication: container.decode(
        GhostteaSSHProfileAuthentication.self,
        forKey: .authentication
      ),
      attach: container.decode(GhostteaSSHProfileAttach.self, forKey: .attach),
      terminalType: container.decode(String.self, forKey: .terminalType),
      columns: container.decode(Int.self, forKey: .columns),
      rows: container.decode(Int.self, forKey: .rows)
    )
  }

  public func configuration(
    knownHostsPath: String,
    hostKeyPolicy: GhostteaSSHHostKeyPolicy = .strictKnownHosts,
    credentialStore: KeychainSSHCredentialStore,
    keyboardInteractiveResponder: GhostteaSSHKeyboardInteractiveResponder? = nil
  ) throws -> GhostteaSSHConfiguration {
    let resolvedAuthentication: GhostteaSSHAuthentication
    switch authentication {
    case .password(let credential):
      resolvedAuthentication = .password(
        username: username,
        credential: credential,
        store: credentialStore
      )
    case .privateKey(let privateKeyCredential, let passphraseCredential):
      resolvedAuthentication = .privateKey(
        username: username,
        privateKeyCredential: privateKeyCredential,
        passphraseCredential: passphraseCredential,
        store: credentialStore
      )
    case .keyboardInteractive:
      guard let keyboardInteractiveResponder else {
        throw GhostteaSSHConnectionProfileError.missingKeyboardInteractiveResponder
      }
      resolvedAuthentication = .keyboardInteractive(
        username: username,
        responder: keyboardInteractiveResponder
      )
    }
    return try GhostteaSSHConfiguration(
      host: host,
      port: port,
      knownHostsPath: knownHostsPath,
      hostKeyPolicy: hostKeyPolicy,
      authentication: resolvedAuthentication,
      profile: attach.sshAttachProfile,
      terminalType: terminalType,
      columns: columns,
      rows: rows
    )
  }

  private static func validate(_ authentication: GhostteaSSHProfileAuthentication) throws {
    switch authentication {
    case .password(let credential):
      guard credential.kind == .password else {
        throw GhostteaSSHConnectionProfileError.invalidPasswordCredentialKind
      }
    case .privateKey(let privateKeyCredential, let passphraseCredential):
      guard privateKeyCredential.kind == .privateKey else {
        throw GhostteaSSHConnectionProfileError.invalidPrivateKeyCredentialKind
      }
      if let passphraseCredential {
        guard passphraseCredential.kind == .privateKeyPassphrase else {
          throw GhostteaSSHConnectionProfileError.invalidPassphraseCredentialKind
        }
        guard passphraseCredential.connectionID == privateKeyCredential.connectionID else {
          throw GhostteaSSHConnectionProfileError.mismatchedCredentialConnection
        }
      }
    case .keyboardInteractive:
      break
    }
  }
}

public actor GhostteaSSHConnectionProfileStore {
  private struct Document: Codable {
    let version: Int
    let profiles: [GhostteaSSHConnectionProfile]
  }

  public let fileURL: URL

  public init(fileURL: URL) {
    self.fileURL = fileURL
  }

  public func load() throws -> [GhostteaSSHConnectionProfile] {
    guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
    let document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: fileURL))
    guard document.version == ghostteaSSHConnectionProfileSchemaVersion else {
      throw GhostteaSSHConnectionProfileError.unsupportedVersion(document.version)
    }
    try validateUnique(document.profiles)
    return document.profiles
  }

  public func save(_ profiles: [GhostteaSSHConnectionProfile]) throws {
    try validateUnique(profiles)
    let directory = fileURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(
      Document(version: ghostteaSSHConnectionProfileSchemaVersion, profiles: profiles)
    )
    try data.write(to: fileURL, options: .atomic)
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.complete],
        ofItemAtPath: fileURL.path
      )
    #endif
  }

  private func validateUnique(_ profiles: [GhostteaSSHConnectionProfile]) throws {
    var ids = Set<UUID>()
    for profile in profiles where !ids.insert(profile.id).inserted {
      throw GhostteaSSHConnectionProfileError.duplicateProfileID(profile.id)
    }
  }
}
