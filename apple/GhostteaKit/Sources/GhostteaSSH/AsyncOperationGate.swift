actor AsyncOperationGate {
  private var isHeld = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func acquire() async {
    if !isHeld {
      isHeld = true
      return
    }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  func release() {
    guard !waiters.isEmpty else {
      isHeld = false
      return
    }
    waiters.removeFirst().resume()
  }
}
