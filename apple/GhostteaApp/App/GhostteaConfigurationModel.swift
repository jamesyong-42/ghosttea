import Foundation
import GhostteaAppearance
import GhostteaCore

@MainActor
final class GhostteaConfigurationModel: ObservableObject {
  enum ValidationState: Equatable {
    case idle
    case validating
    case valid
    case invalid
  }

  @Published private(set) var savedConfiguration: GhostteaConfigSnapshot
  @Published private(set) var effectiveConfiguration: GhostteaConfigSnapshot
  @Published private(set) var document: GhostteaConfigDocument
  @Published private(set) var rawDraft: String
  @Published private(set) var validation: GhostteaConfigDocumentValidation?
  @Published private(set) var validationState = ValidationState.idle
  @Published private(set) var isSaving = false
  @Published private(set) var message: String?
  @Published private(set) var errorMessage: String?
  @Published private(set) var documentAccessError: String?
  @Published private(set) var conflict: GhostteaConfigDocument?
  @Published private(set) var appearance: GhostteaAppearanceSelection
  @Published private(set) var friendly: GhostteaFriendlyConfigValues
  @Published private(set) var friendlySections: Set<GhostteaFriendlyConfigSection> = []

  let overlayURL: URL
  private let store: GhostteaConfigurationStore
  private var baseContents: String
  private var validationTask: Task<Void, Never>?
  private var validationSequence = 0

  init(overlayURL: URL) throws {
    self.overlayURL = overlayURL
    store = try GhostteaConfigurationStore(overlayURL: overlayURL, loadGhosttyFiles: true)
    let snapshot = try store.snapshot()
    let loadedDocument: GhostteaConfigDocument
    do {
      loadedDocument = try store.document()
    } catch {
      loadedDocument = GhostteaConfigDocument(
        schemaVersion: 1,
        revision: snapshot.revision,
        path: overlayURL.path,
        exists: FileManager.default.fileExists(atPath: overlayURL.path),
        contents: ""
      )
      documentAccessError =
        "The terminal can use its resolved fallback configuration, but this profile cannot be edited: \(error.localizedDescription)"
    }
    savedConfiguration = snapshot
    effectiveConfiguration = snapshot
    document = loadedDocument
    rawDraft = loadedDocument.contents
    baseContents = loadedDocument.contents
    appearance = GhostteaAppearanceSelection(config: snapshot)
    friendly = GhostteaFriendlyConfigValues(config: snapshot)
    friendlySections = GhostteaConfigurationDraft.friendlySections(in: loadedDocument.contents)
    validation = GhostteaConfigDocumentValidation(
      documentRevision: loadedDocument.revision,
      config: snapshot)
    validationState = documentAccessError == nil ? .valid : .invalid
  }

  deinit { validationTask?.cancel() }

  var isDirty: Bool { rawDraft != baseContents }
  var isDocumentEditable: Bool { documentAccessError == nil }
  var byteCount: Int { rawDraft.lengthOfBytes(using: .utf8) }
  var diagnostics: [GhostteaConfigDiagnostic] { validation?.config.diagnostics ?? [] }
  var blockingDiagnostics: [GhostteaConfigDiagnostic] {
    blockingDiagnostics(in: validation?.config)
  }
  var canSave: Bool {
    isDocumentEditable && isDirty && !isSaving && validationState == .valid
      && blockingDiagnostics.isEmpty
      && byteCount <= GhostteaConfigurationStore.maximumDocumentBytes
  }

  func editRaw(_ edited: String) {
    guard isDocumentEditable else { return }
    changeDraft(
      GhostteaConfigurationDraft.applyTextEdit(previous: rawDraft, edited: edited))
  }

  func replaceDraft(_ contents: String) {
    guard isDocumentEditable else { return }
    changeDraft(contents)
  }

  func appendToDraft(_ contents: String) {
    guard isDocumentEditable, !contents.isEmpty else { return }
    changeDraft(GhostteaConfigurationDraft.appendDocument(contents, to: rawDraft))
  }

  func applyAppearance(_ next: GhostteaAppearanceSelection) {
    guard isDocumentEditable else { return }
    do {
      let contents = try GhostteaConfigurationDraft.patchAppearance(
        in: rawDraft,
        selection: next)
      appearance = next
      changeDraft(contents)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func updateFriendly(
    _ next: GhostteaFriendlyConfigValues,
    section: GhostteaFriendlyConfigSection
  ) {
    guard isDocumentEditable else { return }
    var sections = friendlySections
    sections.insert(section)
    do {
      let contents = try GhostteaConfigurationDraft.patchFriendly(
        in: rawDraft,
        values: next,
        sections: sections)
      friendly = next
      friendlySections = sections
      changeDraft(contents)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func resetFriendlyOverrides() {
    guard isDocumentEditable else { return }
    do {
      let contents = try GhostteaConfigurationDraft.patchFriendly(
        in: rawDraft,
        values: friendly,
        sections: [])
      friendlySections = []
      changeDraft(contents)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func importGhosttyProjection(from url: URL, append: Bool) async {
    await importOperation(append: append) {
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      let imported = try GhostteaConfiguration.load(overlayURL: url, loadGhosttyFiles: false)
      return GhostteaConfigurationDraft.portableConfig(from: imported)
    }
  }

  func importRawFile(from url: URL, append: Bool) async {
    await importOperation(append: append) {
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
      guard values.isRegularFile == true else { throw GhostteaConfigurationImportError.notRegular }
      guard (values.fileSize ?? 0) <= GhostteaConfigurationStore.maximumDocumentBytes else {
        throw GhostteaConfigurationImportError.tooLarge
      }
      let data = try Data(contentsOf: url, options: .mappedIfSafe)
      guard data.count <= GhostteaConfigurationStore.maximumDocumentBytes,
        let contents = String(data: data, encoding: .utf8)
      else { throw GhostteaConfigurationImportError.invalidText }
      return contents
    }
  }

  func save() async {
    guard canSave else { return }
    isSaving = true
    defer { isSaving = false }
    errorMessage = nil
    message = nil
    do {
      let draft = rawDraft
      let latest = try await Task.detached { [store] in try store.validate(contents: draft) }.value
      guard blockingDiagnostics(in: latest.config).isEmpty else {
        validation = latest
        validationState = .invalid
        throw GhostteaConfigurationImportError.validationFailed
      }
      guard draft == rawDraft else {
        message = "The draft changed during validation. Review the latest result, then save again."
        return
      }
      let expectedRevision = document.revision
      let result = try await Task.detached { [store] in
        try store.replace(expectedRevision: expectedRevision, contents: draft)
      }.value
      switch result {
      case .saved(let update):
        let hasNewerDraft = rawDraft != draft
        document = update.document
        baseContents = update.document.contents
        savedConfiguration = update.config
        conflict = nil
        if hasNewerDraft {
          validationState = .validating
          scheduleValidation()
          message = "Saved the earlier draft. Your newer edits remain unsaved and are validating."
        } else {
          rawDraft = update.document.contents
          effectiveConfiguration = update.config
          validation = GhostteaConfigDocumentValidation(
            documentRevision: update.document.revision,
            config: update.config)
          validationState = .valid
          appearance = GhostteaAppearanceSelection(config: update.config)
          friendly = GhostteaFriendlyConfigValues(config: update.config)
          friendlySections = GhostteaConfigurationDraft.friendlySections(
            in: update.document.contents)
          message =
            "Saved and loaded. Existing direct SSH sessions received live appearance updates."
        }
      case .conflict(let current):
        conflict = current
        message = "The file changed on disk. Nothing was overwritten."
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func reportExport(_ result: Result<URL, any Error>) {
    switch result {
    case .success(let url):
      errorMessage = nil
      message = "Exported \(url.lastPathComponent)."
    case .failure(let error):
      message = nil
      errorMessage = error.localizedDescription
    }
  }

  func adoptConflict(keepDraft: Bool) {
    guard let conflict else { return }
    document = conflict
    baseContents = conflict.contents
    if !keepDraft { rawDraft = conflict.contents }
    self.conflict = nil
    changeDraft(rawDraft)
  }

  func dismissConflict() {
    conflict = nil
  }

  func revert() {
    validationTask?.cancel()
    rawDraft = baseContents
    effectiveConfiguration = savedConfiguration
    validation = GhostteaConfigDocumentValidation(
      documentRevision: document.revision,
      config: savedConfiguration)
    validationState = isDocumentEditable ? .valid : .invalid
    appearance = GhostteaAppearanceSelection(config: savedConfiguration)
    friendly = GhostteaFriendlyConfigValues(config: savedConfiguration)
    friendlySections = GhostteaConfigurationDraft.friendlySections(in: baseContents)
    errorMessage = nil
    message = nil
    conflict = nil
  }

  private func changeDraft(_ contents: String) {
    rawDraft = contents
    friendlySections = GhostteaConfigurationDraft.friendlySections(in: contents)
    validationState = .validating
    errorMessage =
      byteCount > GhostteaConfigurationStore.maximumDocumentBytes
      ? "The draft exceeds the 64 KiB configuration limit." : nil
    message = nil
    conflict = nil
    scheduleValidation()
  }

  private func scheduleValidation() {
    validationTask?.cancel()
    guard byteCount <= GhostteaConfigurationStore.maximumDocumentBytes else {
      validationState = .invalid
      return
    }
    validationSequence += 1
    let sequence = validationSequence
    let draft = rawDraft
    validationTask = Task { [weak self, store] in
      try? await Task.sleep(for: .milliseconds(320))
      guard !Task.isCancelled else { return }
      do {
        let result = try await Task.detached { try store.validate(contents: draft) }.value
        guard !Task.isCancelled, let self, sequence == self.validationSequence,
          draft == self.rawDraft
        else { return }
        self.validation = result
        let valid = self.blockingDiagnostics(in: result.config).isEmpty
        self.validationState = valid ? .valid : .invalid
        if valid {
          self.effectiveConfiguration = result.config
          self.appearance = GhostteaAppearanceSelection(config: result.config)
          self.friendly = GhostteaFriendlyConfigValues(config: result.config)
          self.friendlySections = GhostteaConfigurationDraft.friendlySections(in: draft)
        }
      } catch {
        guard let self, sequence == self.validationSequence else { return }
        self.validationState = .invalid
        self.errorMessage = error.localizedDescription
      }
    }
  }

  private func importOperation(
    append: Bool,
    _ operation: @escaping @Sendable () throws -> String
  ) async {
    guard isDocumentEditable else { return }
    errorMessage = nil
    do {
      let contents = try await Task.detached(operation: operation).value
      guard
        contents.lengthOfBytes(using: .utf8)
          <= GhostteaConfigurationStore.maximumDocumentBytes
      else { throw GhostteaConfigurationImportError.tooLarge }
      if append { appendToDraft(contents) } else { replaceDraft(contents) }
      message = "Imported into the draft. Review validation, then save to load it permanently."
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func blockingDiagnostics(
    in config: GhostteaConfigSnapshot?
  ) -> [GhostteaConfigDiagnostic] {
    guard let config else { return [] }
    let inherited = Set(
      savedConfiguration.diagnostics.filter { $0.severity == .error }.map(Self.diagnosticIdentity))
    return config.diagnostics.filter {
      $0.severity == .error && !inherited.contains(Self.diagnosticIdentity($0))
    }
  }

  private static func diagnosticIdentity(_ value: GhostteaConfigDiagnostic) -> String {
    [
      value.code, value.message, value.source ?? "", value.line.map(String.init) ?? "",
      value.key ?? "",
    ].joined(separator: "\u{0}")
  }
}

private enum GhostteaConfigurationImportError: Error, LocalizedError {
  case notRegular
  case tooLarge
  case invalidText
  case validationFailed

  var errorDescription: String? {
    switch self {
    case .notRegular: "The selected item is not a regular file."
    case .tooLarge: "The selected configuration exceeds the 64 KiB limit."
    case .invalidText: "The selected configuration is not valid UTF-8 text."
    case .validationFailed: "Fix configuration errors before saving."
    }
  }
}
