import Foundation
import Testing

@testable import GhostteaCredentials

@Test func credentialReferenceUsesOnlyOpaqueIdentityAndKind() {
  let connectionID = UUID(uuidString: "A1241C1D-FE71-44A2-A2B8-F76E61A85A7D")!

  #expect(
    SSHCredentialID(connectionID: connectionID, kind: .password).keychainAccount
      == "v1:a1241c1d-fe71-44a2-a2b8-f76e61a85a7d:password"
  )
  #expect(
    SSHCredentialID(connectionID: connectionID, kind: .privateKey).keychainAccount
      == "v1:a1241c1d-fe71-44a2-a2b8-f76e61a85a7d:privateKey"
  )
}

@Test func credentialStoreRejectsEmptyService() {
  #expect(throws: SSHCredentialStoreError.invalidService) {
    try KeychainSSHCredentialStore(service: " \n ")
  }
}
