import Foundation
import Testing

@testable import GhostteaCredentials

#if canImport(Darwin)
  import Darwin
#endif

@Test func privateKeyMaterializationIsProtectedAndRemoved() throws {
  let root = FileManager.default.temporaryDirectory.appending(
    path: "GhostteaMaterializerTests-\(UUID().uuidString)",
    directoryHint: .isDirectory
  )
  defer { try? FileManager.default.removeItem(at: root) }

  let expected = Data("fixture-private-key-bytes".utf8)
  let key = try ProtectedPrivateKeyMaterializer(rootDirectory: root).materialize(expected)
  let url = URL(filePath: key.path)
  #expect(try Data(contentsOf: url) == expected)

  let attributes = try FileManager.default.attributesOfItem(atPath: key.path)
  #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
  #expect((attributes[.type] as? FileAttributeType) == .typeRegular)
  #expect((attributes[.protectionKey] as? FileProtectionType) == .complete)
  let rootAttributes = try FileManager.default.attributesOfItem(atPath: root.path)
  #expect((rootAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
  #if canImport(Darwin)
    let backupExclusionBytes = key.path.withCString { path in
      "com.apple.metadata:com_apple_backup_excludeItem".withCString { attribute in
        getxattr(path, attribute, nil, 0, 0, 0)
      }
    }
    #expect(backupExclusionBytes > 0)
  #endif

  try key.remove()
  #expect(!FileManager.default.fileExists(atPath: key.path))
  try key.remove()
}

@Test func privateKeyMaterializationCleansUpOnDeinit() throws {
  let root = FileManager.default.temporaryDirectory.appending(
    path: "GhostteaMaterializerDeinitTests-\(UUID().uuidString)",
    directoryHint: .isDirectory
  )
  defer { try? FileManager.default.removeItem(at: root) }

  var path: String?
  var key: MaterializedPrivateKey? = try ProtectedPrivateKeyMaterializer(
    rootDirectory: root
  ).materialize(Data("key".utf8))
  path = key?.path
  #expect(path.map { FileManager.default.fileExists(atPath: $0) } == true)
  key = nil
  #expect(path.map { !FileManager.default.fileExists(atPath: $0) } == true)
}
