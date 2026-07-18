#if DEBUG
  import Darwin
  import Foundation

  @MainActor
  final class GhostteaMultiSceneProbe {
    enum Action {
      case none
      case open(UUID)
      case dismiss(UUID)
    }

    static let shared = GhostteaMultiSceneProbe()

    private struct SceneRecord {
      let viewID: String
      let runtimeID: ObjectIdentifier
    }

    private var activeScenes: [UUID: SceneRecord] = [:]
    private var allViewIDs: Set<String> = []
    private var expectedSecondSceneID: UUID?
    private var reachedTwoScenes = false

    private var enabled: Bool {
      ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_MULTISCENE"] == "1"
    }

    func sceneAppeared(
      sceneID: UUID,
      viewID: String,
      runtime: GhostteaSharedRuntimeModel
    ) -> Action {
      guard enabled else { return .none }
      activeScenes[sceneID] = SceneRecord(
        viewID: viewID,
        runtimeID: ObjectIdentifier(runtime))
      allViewIDs.insert(viewID)

      if activeScenes.count == 1, expectedSecondSceneID == nil {
        let second = UUID()
        expectedSecondSceneID = second
        return .open(second)
      }

      guard activeScenes.count == 2, !reachedTwoScenes else { return .none }
      let records = Array(activeScenes.values)
      guard Set(records.map(\.viewID)).count == 2 else {
        fail("duplicate scene terminal view IDs")
      }
      guard Set(records.map(\.runtimeID)).count == 1 else {
        fail("WindowGroup scenes did not share one mesh runtime")
      }
      guard let expectedSecondSceneID, activeScenes[expectedSecondSceneID] != nil else {
        fail("requested second WindowGroup scene did not materialize")
      }
      reachedTwoScenes = true
      print("GHOSTTEA_MULTISCENE_READY scenes=2 runtime=shared viewIDs=distinct")
      return .dismiss(expectedSecondSceneID)
    }

    func sceneDisappeared(sceneID: UUID) {
      guard enabled else { return }
      activeScenes[sceneID] = nil
      guard reachedTwoScenes, activeScenes.count == 1 else { return }
      guard allViewIDs.count == 2 else {
        fail("scene identity changed during close-window teardown")
      }
      let survivor = activeScenes.values.first!
      guard survivor.viewID.hasPrefix("ios-scene-") else {
        fail("surviving scene lost its terminal identity")
      }
      print(
        "GHOSTTEA_MULTISCENE_PASS "
          + "scenes=2 closed=1 survivor=1 runtime=shared viewIDs=distinct")
      Darwin.exit(EXIT_SUCCESS)
    }

    private func fail(_ message: String) -> Never {
      print("GHOSTTEA_MULTISCENE_FAIL \(message)")
      Darwin.exit(EXIT_FAILURE)
    }
  }
#endif
