import Foundation
import Security

public enum SSHCredentialKind: String, CaseIterable, Sendable {
  case password
  case privateKey
  case privateKeyPassphrase
}

/// A non-secret reference suitable for workspace restoration.
///
/// The connection UUID may be persisted with workspace metadata. Hostnames,
/// usernames, and secret values must not be encoded into this identifier.
public struct SSHCredentialID: Hashable, Sendable {
  public let connectionID: UUID
  public let kind: SSHCredentialKind

  public init(connectionID: UUID, kind: SSHCredentialKind) {
    self.connectionID = connectionID
    self.kind = kind
  }

  var keychainAccount: String {
    "v1:\(connectionID.uuidString.lowercased()):\(kind.rawValue)"
  }
}

public enum SSHCredentialStoreError: Error, Equatable, Sendable {
  case invalidService
  case missingCredential(SSHCredentialID)
  case keychain(operation: String, status: OSStatus)
  case unexpectedResult
}

/// Stores SSH secrets in Apple's data-protection Keychain.
///
/// Items are device-only, unavailable while the device is locked, and never
/// synchronized through iCloud Keychain. Keychain metadata contains only the
/// caller's service name, an opaque connection UUID, and the credential kind.
public actor KeychainSSHCredentialStore {
  public static let defaultService = "com.vibecook.ghosttea.ssh.credentials"

  private let service: String
  private let accessGroup: String?

  public init(
    service: String = KeychainSSHCredentialStore.defaultService,
    accessGroup: String? = nil
  ) throws {
    guard !service.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw SSHCredentialStoreError.invalidService
    }
    self.service = service
    self.accessGroup = accessGroup
  }

  public func store(_ secret: Data, for credential: SSHCredentialID) throws {
    var values: [CFString: Any] = [
      kSecValueData: secret,
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    values[kSecAttrLabel] = "Ghosttea SSH \(credential.kind.rawValue)"

    let status = SecItemUpdate(baseQuery(for: credential) as CFDictionary, values as CFDictionary)
    switch status {
    case errSecSuccess:
      return
    case errSecItemNotFound:
      var item = baseQuery(for: credential)
      values.forEach { item[$0.key] = $0.value }
      let addStatus = SecItemAdd(item as CFDictionary, nil)
      if addStatus == errSecDuplicateItem {
        let retryStatus = SecItemUpdate(
          baseQuery(for: credential) as CFDictionary,
          values as CFDictionary
        )
        try requireSuccess(retryStatus, operation: "update credential after concurrent insert")
      } else {
        try requireSuccess(addStatus, operation: "store credential")
      }
    default:
      throw SSHCredentialStoreError.keychain(operation: "update credential", status: status)
    }
  }

  public func load(_ credential: SSHCredentialID) throws -> Data? {
    var query = baseQuery(for: credential)
    query[kSecMatchLimit] = kSecMatchLimitOne
    query[kSecReturnData] = kCFBooleanTrue
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      guard let data = result as? Data else {
        throw SSHCredentialStoreError.unexpectedResult
      }
      return data
    case errSecItemNotFound:
      return nil
    default:
      throw SSHCredentialStoreError.keychain(operation: "load credential", status: status)
    }
  }

  public func require(_ credential: SSHCredentialID) throws -> Data {
    guard let secret = try load(credential) else {
      throw SSHCredentialStoreError.missingCredential(credential)
    }
    return secret
  }

  public func remove(_ credential: SSHCredentialID) throws {
    let status = SecItemDelete(baseQuery(for: credential) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw SSHCredentialStoreError.keychain(operation: "remove credential", status: status)
    }
  }

  private func baseQuery(for credential: SSHCredentialID) -> [CFString: Any] {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: credential.keychainAccount,
      kSecAttrSynchronizable: kCFBooleanFalse as Any,
      kSecUseDataProtectionKeychain: kCFBooleanTrue as Any,
    ]
    if let accessGroup {
      query[kSecAttrAccessGroup] = accessGroup
    }
    return query
  }

  private func requireSuccess(_ status: OSStatus, operation: String) throws {
    guard status == errSecSuccess else {
      throw SSHCredentialStoreError.keychain(operation: operation, status: status)
    }
  }
}
