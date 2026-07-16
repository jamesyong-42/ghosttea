import Foundation

public enum PrivateKeyMaterializationError: Error, Equatable, Sendable {
  case createDirectory
  case createFile
  case applyProtection
  case removeFile
}

/// A short-lived private-key file owned by the caller.
///
/// Call `remove()` as soon as authentication completes. Deinitialization makes
/// a final best-effort removal attempt, but is not the primary cleanup path.
public final class MaterializedPrivateKey: @unchecked Sendable {
  public let path: String

  private let lock = NSLock()
  private var removed = false

  init(url: URL) {
    path = url.path
  }

  public func remove() throws {
    try lock.withLock {
      guard !removed else { return }
      do {
        try FileManager.default.removeItem(atPath: path)
        removed = true
      } catch let error as CocoaError where error.code == .fileNoSuchFile {
        removed = true
      } catch {
        throw PrivateKeyMaterializationError.removeFile
      }
    }
  }

  deinit {
    try? remove()
  }
}

/// Materializes private-key bytes only for the duration of libssh2 file-based
/// authentication.
public struct ProtectedPrivateKeyMaterializer: Sendable {
  private let rootDirectory: URL

  public init(rootDirectory: URL? = nil) {
    self.rootDirectory =
      rootDirectory
      ?? FileManager.default.temporaryDirectory.appending(
        path: "GhostteaPrivateKeys",
        directoryHint: .isDirectory
      )
  }

  public func materialize(_ privateKey: Data) throws -> MaterializedPrivateKey {
    do {
      try FileManager.default.createDirectory(
        at: rootDirectory,
        withIntermediateDirectories: true,
        attributes: [
          .posixPermissions: 0o700,
          .protectionKey: FileProtectionType.complete,
        ]
      )
    } catch {
      throw PrivateKeyMaterializationError.createDirectory
    }

    do {
      try FileManager.default.setAttributes(
        [
          .posixPermissions: 0o700,
          .protectionKey: FileProtectionType.complete,
        ],
        ofItemAtPath: rootDirectory.path
      )
      let attributes = try FileManager.default.attributesOfItem(atPath: rootDirectory.path)
      guard
        (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700,
        (attributes[.type] as? FileAttributeType) == .typeDirectory
      else {
        throw PrivateKeyMaterializationError.applyProtection
      }
    } catch {
      throw PrivateKeyMaterializationError.applyProtection
    }

    let url = rootDirectory.appending(
      path: UUID().uuidString.lowercased(),
      directoryHint: .notDirectory
    )
    guard
      FileManager.default.createFile(
        atPath: url.path,
        contents: privateKey,
        attributes: [
          .posixPermissions: 0o600,
          .protectionKey: FileProtectionType.complete,
        ]
      )
    else {
      throw PrivateKeyMaterializationError.createFile
    }

    do {
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      var mutableURL = url
      try mutableURL.setResourceValues(resourceValues)
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard
        (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
        (attributes[.type] as? FileAttributeType) == .typeRegular
      else {
        throw PrivateKeyMaterializationError.applyProtection
      }
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw PrivateKeyMaterializationError.applyProtection
    }

    return MaterializedPrivateKey(url: url)
  }
}
