#if os(iOS)
  import Foundation
  import MetalKit
  import UIKit

  public struct GhostteaTerminalMetalDiagnostics: Equatable, Sendable {
    public let acceptedFrames: Int
    public let renderedFrames: Int
    public let staleFrames: Int
    public let fullRefreshRequests: Int
    public let resourceEvictions: Int
    public let resourceRebuilds: Int
    public let residentAtlasBytes: Int
    public let lastError: String?

    init(
      acceptedFrames: Int = 0,
      renderedFrames: Int = 0,
      staleFrames: Int = 0,
      fullRefreshRequests: Int = 0,
      resourceEvictions: Int = 0,
      resourceRebuilds: Int = 0,
      residentAtlasBytes: Int = 0,
      lastError: String? = nil
    ) {
      self.acceptedFrames = acceptedFrames
      self.renderedFrames = renderedFrames
      self.staleFrames = staleFrames
      self.fullRefreshRequests = fullRefreshRequests
      self.resourceEvictions = resourceEvictions
      self.resourceRebuilds = resourceRebuilds
      self.residentAtlasBytes = residentAtlasBytes
      self.lastError = lastError
    }
  }

  @MainActor
  public final class GhostteaTerminalMetalView: MTKView, MTKViewDelegate {
    private struct PressedHardwareKey {
      let event: GhostteaHardwareKeyEvent
      let handled: Bool
    }

    private enum PointerInteraction {
      case none
      case remote
      case selection(anchor: GhostteaTerminalCellPoint)
    }

    public var onNeedsFullRefresh: (() -> Void)?
    public var onHardwareKeyEvent: ((GhostteaHardwareKeyEvent) -> Bool)?
    public var onSoftwareInputEvent: ((GhostteaSoftwareInputEvent) -> Void)?
    public var onMarkedTextChange: ((GhostteaMarkedTextState?) -> Void)?
    public var onMouseInputEvent: ((GhostteaTerminalMouseEvent) -> Void)?
    public var onScrollRows: ((Int) -> Void)?
    public var onSelectionChange: ((GhostteaTerminalSelection?) -> Void)?
    public var onSelectionCommit: ((GhostteaTerminalSelection) -> Void)?
    public var forceLocalSelection = false
    public weak var inputDelegate: UITextInputDelegate?
    public var markedTextStyle: [NSAttributedString.Key: Any]? {
      didSet { updateMarkedTextOverlay() }
    }
    public var autocapitalizationType: UITextAutocapitalizationType = .none
    public var autocorrectionType: UITextAutocorrectionType = .no
    public var spellCheckingType: UITextSpellCheckingType = .no
    public var smartQuotesType: UITextSmartQuotesType = .no
    public var smartDashesType: UITextSmartDashesType = .no
    public var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    public var keyboardType: UIKeyboardType = .default
    public var keyboardAppearance: UIKeyboardAppearance = .dark
    public var returnKeyType: UIReturnKeyType = .default
    public var enablesReturnKeyAutomatically = false
    public var isSecureTextEntry = false
    public var textContentType: UITextContentType?
    public var showsTerminalAccessoryRow = true {
      didSet {
        guard showsTerminalAccessoryRow != oldValue else { return }
        if isFirstResponder { reloadInputViews() }
      }
    }
    public var terminalAccessoryKeys = GhostteaAccessoryKey.terminalDefaults {
      didSet {
        terminalAccessoryInputView.setKeys(terminalAccessoryKeys)
        if isFirstResponder { reloadInputViews() }
      }
    }
    public var focusesInputOnTap = true {
      didSet { inputFocusTapRecognizer.isEnabled = focusesInputOnTap }
    }
    public var onGridSizeChange: ((GhostteaTerminalGridSize) -> Void)? {
      didSet { updateGridSize(notifyUnchanged: true) }
    }
    public var includesSafeAreaInsets = true {
      didSet {
        guard includesSafeAreaInsets != oldValue else { return }
        geometryDidChange()
      }
    }
    public var terminalContentInsets = UIEdgeInsets.zero {
      didSet {
        guard terminalContentInsets != oldValue else { return }
        geometryDidChange()
      }
    }
    public private(set) var diagnostics = GhostteaTerminalMetalDiagnostics()
    public private(set) var currentGridSize: GhostteaTerminalGridSize?

    private let metalRuntime: GhostteaMetalRuntime
    private var terminalRenderer: GhostteaMetalRenderer?
    private var retainedState = RetainedTRF1State()
    private var terminalSelection: GhostteaMetalSelection?
    private var terminalFocused = true
    private var terminalVisible = true
    private var cursorBlinkVisible = true
    private var gpuSuspended = false
    private var compositionBuffer = GhostteaCompositionBuffer()
    private var accessoryInputState = GhostteaAccessoryInputState()
    private var pointerInteraction = PointerInteraction.none
    private var absoluteSelection: GhostteaTerminalSelection?
    private var wheelAccumulator = GhostteaWheelAccumulator()
    private var previousScrollTranslation: CGFloat = 0
    private var pressedHardwareKeys: [UInt16: PressedHardwareKey] = [:]
    private let markedTextLabel = UILabel()
    private lazy var textInputTokenizer = UITextInputStringTokenizer(textInput: self)
    private lazy var terminalAccessoryInputView: GhostteaTerminalAccessoryView = {
      let view = GhostteaTerminalAccessoryView(keys: terminalAccessoryKeys)
      view.onKey = { [weak self] key in self?.activateAccessoryKey(key) }
      return view
    }()
    private lazy var inputFocusTapRecognizer = UITapGestureRecognizer(
      target: self,
      action: #selector(handleInputFocusTap)
    )
    private lazy var pointerPanRecognizer: UIPanGestureRecognizer = {
      let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handlePointerPan(_:)))
      recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
      recognizer.allowedScrollTypesMask = .all
      recognizer.maximumNumberOfTouches = 1
      recognizer.cancelsTouchesInView = false
      return recognizer
    }()
    private lazy var touchSelectionRecognizer: UILongPressGestureRecognizer = {
      let recognizer = UILongPressGestureRecognizer(
        target: self,
        action: #selector(handleTouchSelection(_:))
      )
      recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
      recognizer.minimumPressDuration = 0.35
      recognizer.cancelsTouchesInView = false
      return recognizer
    }()
    private lazy var pointerHoverRecognizer = UIHoverGestureRecognizer(
      target: self,
      action: #selector(handlePointerHover(_:))
    )
    private lazy var cursorBlinkController = GhostteaCursorBlinkController { [weak self] visible in
      self?.applyCursorBlinkVisibility(visible)
    }

    public init(terminalFrame: CGRect = .zero) throws {
      let runtime = try GhostteaMetalRuntime()
      metalRuntime = runtime
      super.init(frame: terminalFrame, device: runtime.device)
      colorPixelFormat = .rgba8Unorm
      clearColor = MTLClearColor(red: 40 / 255, green: 44 / 255, blue: 52 / 255, alpha: 1)
      framebufferOnly = true
      autoResizeDrawable = true
      isPaused = true
      enableSetNeedsDisplay = true
      delegate = self
      inputFocusTapRecognizer.cancelsTouchesInView = false
      addGestureRecognizer(inputFocusTapRecognizer)
      addGestureRecognizer(pointerPanRecognizer)
      addGestureRecognizer(touchSelectionRecognizer)
      addGestureRecognizer(pointerHoverRecognizer)
      markedTextLabel.backgroundColor = UIColor(
        red: 40 / 255,
        green: 44 / 255,
        blue: 52 / 255,
        alpha: 1
      )
      markedTextLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
      markedTextLabel.textColor = UIColor(red: 0.75, green: 0.78, blue: 0.82, alpha: 1)
      markedTextLabel.isHidden = true
      markedTextLabel.isUserInteractionEnabled = false
      markedTextLabel.accessibilityElementsHidden = true
      addSubview(markedTextLabel)
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(applicationDidEnterBackground),
        name: UIApplication.didEnterBackgroundNotification,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(applicationWillEnterForeground),
        name: UIApplication.willEnterForegroundNotification,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(applicationDidReceiveMemoryWarning),
        name: UIApplication.didReceiveMemoryWarningNotification,
        object: nil
      )
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
      fatalError("GhostteaTerminalMetalView must be initialized programmatically")
    }

    deinit {
      NotificationCenter.default.removeObserver(self)
    }

    public override func layoutSubviews() {
      super.layoutSubviews()
      geometryDidChange()
    }

    public override func safeAreaInsetsDidChange() {
      super.safeAreaInsetsDidChange()
      geometryDidChange()
    }

    public override func didMoveToWindow() {
      super.didMoveToWindow()
      updateCursorBlinkSurfaceVisibility()
    }

    public override var canBecomeFirstResponder: Bool { true }

    public override var inputAccessoryView: UIView? {
      showsTerminalAccessoryRow && !terminalAccessoryKeys.isEmpty
        ? terminalAccessoryInputView : nil
    }

    public var latchedAccessoryModifiers: GhostteaInputModifiers {
      accessoryInputState.modifiers
    }

    public var terminalMouseTrackingEnabled: Bool { retainedState.mouseTracking }

    public func pointerOwner(forceLocalSelection: Bool = false) -> GhostteaPointerOwner {
      .resolve(
        mouseTracking: terminalMouseTrackingEnabled,
        forceLocalSelection: forceLocalSelection
      )
    }

    public func viewportCell(at location: CGPoint) -> GhostteaViewportCellPoint {
      let insets = effectiveContentInsets()
      let x = location.x - CGFloat(insets.left + GhostteaTerminalLayout.horizontalPadding)
      let y = location.y - CGFloat(insets.top + GhostteaTerminalLayout.verticalPadding)
      let maximumColumn = max(0, Int(currentGridSize?.columns ?? retainedState.columns) - 1)
      let maximumRow = max(0, Int(currentGridSize?.rows ?? UInt16(retainedState.rows.count)) - 1)
      let column = max(
        0,
        min(maximumColumn, Int(floor(x / CGFloat(GhostteaTerminalLayout.cellWidth))))
      )
      let row = max(
        0,
        min(maximumRow, Int(floor(y / CGFloat(GhostteaTerminalLayout.lineHeight))))
      )
      return GhostteaViewportCellPoint(column: UInt16(column), row: UInt16(row))
    }

    public func terminalMouseEvent(
      action: GhostteaMouseAction,
      button: GhostteaMouseButton,
      at location: CGPoint,
      modifiers: GhostteaInputModifiers = []
    ) -> GhostteaTerminalMouseEvent {
      let insets = effectiveContentInsets()
      return GhostteaTerminalMouseEvent(
        action: action,
        button: button,
        modifiers: modifiers,
        x: Float(max(0, min(bounds.width, location.x))),
        y: Float(max(0, min(bounds.height, location.y))),
        screenWidth: Self.boundedGeometry(bounds.width),
        screenHeight: Self.boundedGeometry(bounds.height),
        cellWidth: Self.boundedGeometry(CGFloat(GhostteaTerminalLayout.cellWidth)),
        cellHeight: Self.boundedGeometry(CGFloat(GhostteaTerminalLayout.lineHeight)),
        paddingLeft: Self.boundedGeometry(
          CGFloat(insets.left + GhostteaTerminalLayout.horizontalPadding)),
        paddingTop: Self.boundedGeometry(
          CGFloat(insets.top + GhostteaTerminalLayout.verticalPadding))
      )
    }

    @discardableResult
    public func focusTerminalInput() -> Bool {
      let focused = becomeFirstResponder()
      if focused { setTerminalFocused(true) }
      return focused
    }

    @objc private func handleInputFocusTap() {
      _ = focusTerminalInput()
    }

    public override func resignFirstResponder() -> Bool {
      let resigned = super.resignFirstResponder()
      if resigned {
        commitMarkedTextIfNeeded()
        clearAccessoryModifiers()
        releaseHandledHardwareKeys()
        setTerminalFocused(false)
      }
      return resigned
    }

    public override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      let unhandled = handleHardwarePresses(presses, ending: false)
      if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
    }

    public override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      let unhandled = handleHardwarePresses(presses, ending: true)
      if !unhandled.isEmpty { super.pressesEnded(unhandled, with: event) }
    }

    public override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      let unhandled = handleHardwarePresses(presses, ending: true)
      if !unhandled.isEmpty { super.pressesCancelled(unhandled, with: event) }
    }

    public override func paste(_ sender: Any?) {
      guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
      commitMarkedTextIfNeeded()
      emitSoftwareInputEvents([.paste(text)])
    }

    public func activateAccessoryKey(_ key: GhostteaAccessoryKey) {
      switch key {
      case .control, .option:
        break
      default:
        commitMarkedTextIfNeeded()
      }
      let event = accessoryInputState.activate(key)
      updateAccessoryModifierPresentation()
      if let event { emitSoftwareInputEvents([event]) }
    }

    private static func boundedGeometry(_ value: CGFloat) -> UInt32 {
      UInt32(max(0, min(CGFloat(UInt32.max), value.rounded())))
    }

    @discardableResult
    public func apply(frame data: Data) throws -> Bool {
      do {
        switch try retainedState.apply(data) {
        case .applied:
          updateRenderedSelection()
          updateCursorBlinkSurfaceVisibility()
          cursorBlinkController.updateCursor(retainedState.cursor)
          updateMarkedTextOverlay()
          updateDiagnostics(acceptedFrames: diagnostics.acceptedFrames + 1, clearError: true)
          requestEventDrivenDraw()
          return true
        case .stale:
          updateDiagnostics(staleFrames: diagnostics.staleFrames + 1)
          return false
        case .needsFullRefresh:
          requestFullRefresh()
          return false
        }
      } catch {
        updateDiagnostics(lastError: String(describing: error))
        requestFullRefresh()
        throw error
      }
    }

    public func setSelection(
      anchorColumn: UInt16,
      anchorRow: UInt16,
      focusColumn: UInt16,
      focusRow: UInt16
    ) {
      let offset = retainedState.scrollbar?.offset ?? 0
      setSelection(
        GhostteaTerminalSelection(
          anchor: GhostteaTerminalCellPoint(
            column: anchorColumn,
            row: UInt32(min(UInt64(UInt32.max), offset + UInt64(anchorRow)))
          ),
          focus: GhostteaTerminalCellPoint(
            column: focusColumn,
            row: UInt32(min(UInt64(UInt32.max), offset + UInt64(focusRow)))
          )
        )
      )
    }

    public func clearSelection() {
      absoluteSelection = nil
      terminalSelection = nil
      onSelectionChange?(nil)
      requestEventDrivenDraw()
    }

    public var selection: GhostteaTerminalSelection? { absoluteSelection }

    public func setSelection(_ selection: GhostteaTerminalSelection?) {
      absoluteSelection = selection
      updateRenderedSelection()
      onSelectionChange?(selection)
    }

    public func setTerminalFocused(_ focused: Bool) {
      guard terminalFocused != focused else { return }
      terminalFocused = focused
      cursorBlinkController.setFocused(focused)
      requestEventDrivenDraw()
    }

    public func setTerminalVisible(_ visible: Bool) {
      guard terminalVisible != visible else { return }
      terminalVisible = visible
      updateCursorBlinkSurfaceVisibility()
      if visible { requestEventDrivenDraw() }
    }

    public func noteCursorActivity() {
      cursorBlinkController.noteCursorActivity()
    }

    private func handleHardwarePresses(
      _ presses: Set<UIPress>,
      ending: Bool
    ) -> Set<UIPress> {
      var unhandled: Set<UIPress> = []
      for press in presses {
        guard let key = press.key else {
          unhandled.insert(press)
          continue
        }
        let usage = UInt16(key.keyCode.rawValue)
        let action: GhostteaHardwareKeyAction
        if ending {
          action = .up
        } else if pressedHardwareKeys[usage] == nil {
          action = .down
        } else {
          action = .repeated
        }
        guard
          let hardwareEvent = GhostteaHardwareKeyEvent(
            hidUsage: usage,
            characters: key.characters,
            charactersIgnoringModifiers: key.charactersIgnoringModifiers,
            modifiers: GhostteaInputModifiers(key.modifierFlags),
            action: action
          )
        else {
          unhandled.insert(press)
          continue
        }
        let pressed = pressedHardwareKeys[usage]
        let handled: Bool
        if let pressed {
          handled = pressed.handled
          if handled { _ = onHardwareKeyEvent?(hardwareEvent) }
        } else {
          handled = onHardwareKeyEvent?(hardwareEvent) == true
        }
        if ending {
          pressedHardwareKeys[usage] = nil
        } else if pressed == nil {
          pressedHardwareKeys[usage] = PressedHardwareKey(event: hardwareEvent, handled: handled)
        }
        guard handled else {
          unhandled.insert(press)
          continue
        }
        noteCursorActivity()
      }
      return unhandled
    }

    private func releaseHandledHardwareKeys() {
      let handled = pressedHardwareKeys.values.filter(\.handled)
      pressedHardwareKeys.removeAll(keepingCapacity: true)
      for pressed in handled {
        _ = onHardwareKeyEvent?(pressed.event.replacingAction(.up))
      }
    }

    @objc private func handlePointerPan(_ recognizer: UIPanGestureRecognizer) {
      if recognizer.numberOfTouches == 0, case .none = pointerInteraction {
        handleScrollPan(recognizer)
        return
      }
      let location = recognizer.location(in: self)
      let modifiers = currentPointerModifiers
      switch recognizer.state {
      case .began:
        _ = focusTerminalInput()
        if pointerOwner(
          forceLocalSelection: forceLocalSelection || modifiers.contains(.shift)
        ) == .remoteApplication {
          pointerInteraction = .remote
          emitMouse(action: .press, button: .left, at: location, modifiers: modifiers)
        } else {
          let anchor = terminalCell(at: location)
          pointerInteraction = .selection(anchor: anchor)
          updateLocalSelection(anchor: anchor, focus: anchor)
        }
      case .changed:
        switch pointerInteraction {
        case .remote:
          emitMouse(action: .motion, button: .left, at: location, modifiers: modifiers)
        case .selection(let anchor):
          updateLocalSelection(anchor: anchor, focus: terminalCell(at: location))
        case .none:
          break
        }
      case .ended, .cancelled, .failed:
        finishPointerInteraction(at: location, modifiers: modifiers)
      default:
        break
      }
    }

    @objc private func handleTouchSelection(_ recognizer: UILongPressGestureRecognizer) {
      let location = recognizer.location(in: self)
      switch recognizer.state {
      case .began:
        _ = focusTerminalInput()
        let anchor = terminalCell(at: location)
        pointerInteraction = .selection(anchor: anchor)
        updateLocalSelection(anchor: anchor, focus: anchor)
      case .changed:
        guard case .selection(let anchor) = pointerInteraction else { return }
        updateLocalSelection(anchor: anchor, focus: terminalCell(at: location))
      case .ended, .cancelled, .failed:
        finishPointerInteraction(at: location, modifiers: [])
      default:
        break
      }
    }

    @objc private func handlePointerHover(_ recognizer: UIHoverGestureRecognizer) {
      guard terminalMouseTrackingEnabled, !forceLocalSelection else { return }
      switch recognizer.state {
      case .began, .changed:
        emitMouse(
          action: .motion,
          button: .none,
          at: recognizer.location(in: self),
          modifiers: currentPointerModifiers
        )
      default:
        break
      }
    }

    private func handleScrollPan(_ recognizer: UIPanGestureRecognizer) {
      let translation = recognizer.translation(in: self).y
      if recognizer.state == .began { previousScrollTranslation = 0 }
      let delta = translation - previousScrollTranslation
      previousScrollTranslation = translation
      let rows = wheelAccumulator.consume(
        deltaPoints: Double(delta),
        lineHeight: Double(GhostteaTerminalLayout.lineHeight)
      )
      guard rows != 0 else { return }
      let modifiers = currentPointerModifiers
      if terminalMouseTrackingEnabled && !(forceLocalSelection || modifiers.contains(.shift)) {
        let button: GhostteaMouseButton = rows < 0 ? .scrollUp : .scrollDown
        for _ in 0..<min(12, abs(rows)) {
          emitMouse(
            action: .press,
            button: button,
            at: recognizer.location(in: self),
            modifiers: modifiers
          )
        }
      } else {
        onScrollRows?(rows)
      }
      if recognizer.state == .ended || recognizer.state == .cancelled {
        previousScrollTranslation = 0
      }
    }

    private var currentPointerModifiers: GhostteaInputModifiers {
      pressedHardwareKeys.values.reduce(into: GhostteaInputModifiers()) { result, pressed in
        result.formUnion(pressed.event.modifiers)
      }
    }

    private func terminalCell(at location: CGPoint) -> GhostteaTerminalCellPoint {
      let viewport = viewportCell(at: location)
      let offset = retainedState.scrollbar?.offset ?? 0
      let row = UInt32(min(UInt64(UInt32.max), offset + UInt64(viewport.row)))
      return GhostteaTerminalCellPoint(column: viewport.column, row: row)
    }

    private func updateLocalSelection(
      anchor: GhostteaTerminalCellPoint,
      focus: GhostteaTerminalCellPoint
    ) {
      let selection = GhostteaTerminalSelection(anchor: anchor, focus: focus)
      absoluteSelection = selection
      updateRenderedSelection()
      onSelectionChange?(selection)
    }

    private func finishPointerInteraction(
      at location: CGPoint,
      modifiers: GhostteaInputModifiers
    ) {
      switch pointerInteraction {
      case .remote:
        emitMouse(action: .release, button: .left, at: location, modifiers: modifiers)
      case .selection(let anchor):
        let selection = GhostteaTerminalSelection(anchor: anchor, focus: terminalCell(at: location))
        if selection.anchor == selection.focus {
          absoluteSelection = nil
          updateRenderedSelection()
          onSelectionChange?(nil)
        } else {
          absoluteSelection = selection
          updateRenderedSelection()
          onSelectionChange?(selection)
          onSelectionCommit?(selection)
        }
      case .none:
        break
      }
      pointerInteraction = .none
    }

    private func emitMouse(
      action: GhostteaMouseAction,
      button: GhostteaMouseButton,
      at location: CGPoint,
      modifiers: GhostteaInputModifiers
    ) {
      onMouseInputEvent?(
        terminalMouseEvent(
          action: action,
          button: button,
          at: location,
          modifiers: modifiers
        )
      )
      noteCursorActivity()
    }

    private func updateRenderedSelection() {
      guard let absoluteSelection,
        let viewport = absoluteSelection.viewportSelection(
          offset: retainedState.scrollbar?.offset ?? 0,
          columns: currentGridSize?.columns ?? retainedState.columns,
          rows: currentGridSize?.rows ?? UInt16(retainedState.rows.count)
        )
      else {
        terminalSelection = nil
        requestEventDrivenDraw()
        return
      }
      terminalSelection = GhostteaMetalSelection(
        anchor: GhostteaMetalCellPoint(
          column: viewport.anchor.column,
          row: viewport.anchor.row
        ),
        focus: GhostteaMetalCellPoint(
          column: viewport.focus.column,
          row: viewport.focus.row
        )
      )
      requestEventDrivenDraw()
    }

    private func applyCursorBlinkVisibility(_ visible: Bool) {
      guard cursorBlinkVisible != visible else { return }
      cursorBlinkVisible = visible
      requestEventDrivenDraw()
    }

    public func prepareGPUResources() throws {
      guard !gpuSuspended else { return }
      _ = try renderer()
    }

    public func bindResizeCoordinator(_ coordinator: GhostteaResizeCoordinator) {
      onGridSizeChange = { size in
        Task { await coordinator.request(size) }
      }
    }

    public func suspendGPU() {
      guard !gpuSuspended else { return }
      gpuSuspended = true
      updateCursorBlinkSurfaceVisibility()
      evictRendererResources()
    }

    public func resumeGPU() {
      guard gpuSuspended else { return }
      gpuSuspended = false
      updateCursorBlinkSurfaceVisibility()
      requestEventDrivenDraw()
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
      guard size.width > 0, size.height > 0 else { return }
      geometryDidChange()
    }

    public func draw(in view: MTKView) {
      guard !gpuSuspended, retainedState.sessionHandle != 0, let drawable = currentDrawable else {
        return
      }
      do {
        let renderer = try renderer()
        let draw = try renderer.render(
          state: retainedState,
          target: drawable.texture,
          scale: Float(contentScaleFactor),
          contentInsets: effectiveContentInsets(),
          selection: terminalSelection,
          focused: terminalFocused,
          cursorBlinkVisible: cursorBlinkVisible,
          presenting: drawable
        )
        updateDiagnostics(
          renderedFrames: diagnostics.renderedFrames + 1,
          residentAtlasBytes: renderer.atlases.residentBytes,
          clearError: true
        )
        _ = draw
      } catch {
        updateDiagnostics(lastError: String(describing: error))
      }
    }

    private func renderer() throws -> GhostteaMetalRenderer {
      if let terminalRenderer { return terminalRenderer }
      let renderer = try GhostteaMetalRenderer(runtime: metalRuntime)
      terminalRenderer = renderer
      updateDiagnostics(
        resourceRebuilds: diagnostics.resourceRebuilds + 1,
        residentAtlasBytes: renderer.atlases.residentBytes
      )
      return renderer
    }

    private func requestEventDrivenDraw() {
      guard !gpuSuspended else { return }
      setNeedsDisplay()
    }

    private func updateCursorBlinkSurfaceVisibility() {
      cursorBlinkController.setSurfaceVisible(
        terminalVisible && window != nil && !isHidden && !gpuSuspended)
    }

    private func geometryDidChange() {
      updateGridSize()
      updateMarkedTextOverlay()
      requestEventDrivenDraw()
    }

    private func updateGridSize(notifyUnchanged: Bool = false) {
      guard bounds.width > 0, bounds.height > 0 else { return }
      let next = GhostteaTerminalLayout.gridSize(
        width: Float(bounds.width),
        height: Float(bounds.height),
        contentInsets: effectiveContentInsets()
      )
      guard next != currentGridSize else {
        if notifyUnchanged { onGridSizeChange?(next) }
        return
      }
      currentGridSize = next
      onGridSizeChange?(next)
    }

    private func effectiveContentInsets() -> GhostteaTerminalContentInsets {
      let safeArea = includesSafeAreaInsets ? safeAreaInsets : .zero
      return GhostteaTerminalContentInsets(
        top: Float(safeArea.top + terminalContentInsets.top),
        left: Float(safeArea.left + terminalContentInsets.left),
        bottom: Float(safeArea.bottom + terminalContentInsets.bottom),
        right: Float(safeArea.right + terminalContentInsets.right)
      )
    }

    private func requestFullRefresh() {
      updateDiagnostics(fullRefreshRequests: diagnostics.fullRefreshRequests + 1)
      onNeedsFullRefresh?()
    }

    private func evictRendererResources() {
      guard terminalRenderer != nil else { return }
      terminalRenderer = nil
      updateDiagnostics(
        resourceEvictions: diagnostics.resourceEvictions + 1,
        residentAtlasBytes: 0
      )
    }

    private func updateDiagnostics(
      acceptedFrames: Int? = nil,
      renderedFrames: Int? = nil,
      staleFrames: Int? = nil,
      fullRefreshRequests: Int? = nil,
      resourceEvictions: Int? = nil,
      resourceRebuilds: Int? = nil,
      residentAtlasBytes: Int? = nil,
      lastError: String? = nil,
      clearError: Bool = false
    ) {
      diagnostics = GhostteaTerminalMetalDiagnostics(
        acceptedFrames: acceptedFrames ?? diagnostics.acceptedFrames,
        renderedFrames: renderedFrames ?? diagnostics.renderedFrames,
        staleFrames: staleFrames ?? diagnostics.staleFrames,
        fullRefreshRequests: fullRefreshRequests ?? diagnostics.fullRefreshRequests,
        resourceEvictions: resourceEvictions ?? diagnostics.resourceEvictions,
        resourceRebuilds: resourceRebuilds ?? diagnostics.resourceRebuilds,
        residentAtlasBytes: residentAtlasBytes ?? diagnostics.residentAtlasBytes,
        lastError: clearError ? nil : (lastError ?? diagnostics.lastError)
      )
    }

    @objc private func applicationDidEnterBackground() {
      suspendGPU()
    }

    @objc private func applicationWillEnterForeground() {
      resumeGPU()
    }

    @objc private func applicationDidReceiveMemoryWarning() {
      evictRendererResources()
      requestEventDrivenDraw()
    }
  }

  private final class GhostteaTextPosition: UITextPosition {
    let offset: Int

    init(_ offset: Int) {
      self.offset = offset
    }
  }

  private final class GhostteaTextRange: UITextRange {
    let lower: GhostteaTextPosition
    let upper: GhostteaTextPosition

    init(_ first: Int, _ second: Int) {
      lower = GhostteaTextPosition(min(first, second))
      upper = GhostteaTextPosition(max(first, second))
    }

    override var start: UITextPosition { lower }
    override var end: UITextPosition { upper }
    override var isEmpty: Bool { lower.offset == upper.offset }

    var nsRange: NSRange {
      NSRange(location: lower.offset, length: upper.offset - lower.offset)
    }
  }

  extension GhostteaTerminalMetalView: UITextInput {
    public var hasText: Bool { true }

    public var selectedTextRange: UITextRange? {
      get {
        GhostteaTextRange(
          compositionBuffer.selection.location,
          compositionBuffer.selection.location + compositionBuffer.selection.length
        )
      }
      set {
        guard let range = newValue as? GhostteaTextRange else { return }
        inputDelegate?.selectionWillChange(self)
        compositionBuffer.setSelectedRange(range.nsRange)
        inputDelegate?.selectionDidChange(self)
        updateMarkedTextOverlay()
      }
    }

    public var markedTextRange: UITextRange? {
      compositionBuffer.isMarked ? GhostteaTextRange(0, compositionBuffer.utf16Count) : nil
    }

    public var beginningOfDocument: UITextPosition { GhostteaTextPosition(0) }
    public var endOfDocument: UITextPosition { GhostteaTextPosition(compositionBuffer.utf16Count) }
    public var tokenizer: UITextInputTokenizer { textInputTokenizer }

    public func text(in range: UITextRange) -> String? {
      guard let range = range as? GhostteaTextRange else { return nil }
      return compositionBuffer.text(in: range.nsRange)
    }

    public func replace(_ range: UITextRange, withText text: String) {
      guard let range = range as? GhostteaTextRange else { return }
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.replace(range.nsRange, with: text)
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
      if let markedText, !markedText.isEmpty { clearAccessoryModifiers() }
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.setMarkedText(markedText, selectedRange: selectedRange)
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func unmarkText() {
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.unmarkText()
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func insertText(_ text: String) {
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.insertText(text)
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func deleteBackward() {
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.deleteBackward()
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func textRange(
      from fromPosition: UITextPosition,
      to toPosition: UITextPosition
    ) -> UITextRange? {
      guard let from = fromPosition as? GhostteaTextPosition,
        let to = toPosition as? GhostteaTextPosition
      else { return nil }
      return GhostteaTextRange(clampTextOffset(from.offset), clampTextOffset(to.offset))
    }

    public func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
      guard let position = position as? GhostteaTextPosition else { return nil }
      let target = position.offset + offset
      guard target >= 0, target <= compositionBuffer.utf16Count else { return nil }
      return GhostteaTextPosition(target)
    }

    public func position(
      from position: UITextPosition,
      in direction: UITextLayoutDirection,
      offset: Int
    ) -> UITextPosition? {
      let signedOffset = direction == .left || direction == .up ? -offset : offset
      return self.position(from: position, offset: signedOffset)
    }

    public func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
      guard let first = position as? GhostteaTextPosition,
        let second = other as? GhostteaTextPosition
      else { return .orderedSame }
      if first.offset < second.offset { return .orderedAscending }
      if first.offset > second.offset { return .orderedDescending }
      return .orderedSame
    }

    public func offset(from: UITextPosition, to: UITextPosition) -> Int {
      guard let from = from as? GhostteaTextPosition, let to = to as? GhostteaTextPosition else {
        return 0
      }
      return to.offset - from.offset
    }

    public func position(
      within range: UITextRange,
      farthestIn direction: UITextLayoutDirection
    ) -> UITextPosition? {
      guard let range = range as? GhostteaTextRange else { return nil }
      return direction == .left || direction == .up ? range.start : range.end
    }

    public func characterRange(
      byExtending position: UITextPosition,
      in direction: UITextLayoutDirection
    ) -> UITextRange? {
      guard let position = position as? GhostteaTextPosition else { return nil }
      let offset = clampTextOffset(position.offset)
      let range = compositionBuffer.composedCharacterRange(
        adjoining: offset,
        towardStart: direction == .left || direction == .up
      )
      return GhostteaTextRange(range.location, range.location + range.length)
    }

    public func baseWritingDirection(
      for position: UITextPosition,
      in direction: UITextStorageDirection
    ) -> NSWritingDirection {
      .leftToRight
    }

    public func setBaseWritingDirection(
      _ writingDirection: NSWritingDirection,
      for range: UITextRange
    ) {}

    public func firstRect(for range: UITextRange) -> CGRect { terminalInputCaretRect() }

    public func caretRect(for position: UITextPosition) -> CGRect {
      guard let position = position as? GhostteaTextPosition else {
        return terminalInputCaretRect()
      }
      return terminalInputCaretRect(at: position.offset)
    }

    public func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }

    public func closestPosition(to point: CGPoint) -> UITextPosition? {
      GhostteaTextPosition(compositionBuffer.selection.location)
    }

    public func closestPosition(
      to point: CGPoint,
      within range: UITextRange
    ) -> UITextPosition? {
      guard let range = range as? GhostteaTextRange else { return nil }
      return range.start
    }

    public func characterRange(at point: CGPoint) -> UITextRange? {
      let offset = compositionBuffer.selection.location
      return GhostteaTextRange(offset, offset)
    }

    private func clampTextOffset(_ offset: Int) -> Int {
      max(0, min(compositionBuffer.utf16Count, offset))
    }

    private func commitMarkedTextIfNeeded() {
      guard compositionBuffer.isMarked else { return }
      unmarkText()
    }

    private func emitSoftwareInputEvents(_ events: [GhostteaSoftwareInputEvent]) {
      guard !events.isEmpty else { return }
      for event in events { onSoftwareInputEvent?(accessoryInputState.consume(event)) }
      updateAccessoryModifierPresentation()
      noteCursorActivity()
    }

    private func clearAccessoryModifiers() {
      guard !accessoryInputState.modifiers.isEmpty else { return }
      accessoryInputState.clear()
      updateAccessoryModifierPresentation()
    }

    private func updateAccessoryModifierPresentation() {
      terminalAccessoryInputView.updateModifiers(accessoryInputState.modifiers)
    }

    private func publishCompositionChange() {
      onMarkedTextChange?(compositionBuffer.markedState)
      updateMarkedTextOverlay()
    }

    private func updateMarkedTextOverlay() {
      guard let marked = compositionBuffer.markedState, !marked.text.isEmpty else {
        markedTextLabel.isHidden = true
        markedTextLabel.attributedText = nil
        return
      }
      let attributes =
        markedTextStyle ?? [
          .underlineStyle: NSUnderlineStyle.single.rawValue,
          .foregroundColor: markedTextLabel.textColor as Any,
        ]
      markedTextLabel.attributedText = NSAttributedString(
        string: marked.text, attributes: attributes)
      markedTextLabel.isHidden = false
      let origin = terminalInputCaretRect().origin
      let availableWidth = max(
        CGFloat(GhostteaTerminalLayout.cellWidth),
        bounds.width - origin.x - CGFloat(effectiveContentInsets().right)
      )
      let measured = markedTextLabel.sizeThatFits(
        CGSize(width: availableWidth, height: CGFloat(GhostteaTerminalLayout.lineHeight)))
      markedTextLabel.frame = CGRect(
        x: origin.x,
        y: origin.y,
        width: min(availableWidth, max(CGFloat(GhostteaTerminalLayout.cellWidth), measured.width)),
        height: CGFloat(GhostteaTerminalLayout.lineHeight)
      )
    }

    private func terminalInputCaretRect(at textOffset: Int? = nil) -> CGRect {
      let insets = effectiveContentInsets()
      let cursor = retainedState.cursor
      var x =
        CGFloat(insets.left + GhostteaTerminalLayout.horizontalPadding)
        + CGFloat(cursor?.x ?? 0) * CGFloat(GhostteaTerminalLayout.cellWidth)
      let y =
        CGFloat(insets.top + GhostteaTerminalLayout.verticalPadding)
        + CGFloat(cursor?.y ?? 0) * CGFloat(GhostteaTerminalLayout.lineHeight)
      if let textOffset, textOffset > 0, !compositionBuffer.text.isEmpty {
        let prefix = compositionBuffer.text(
          in: NSRange(location: 0, length: clampTextOffset(textOffset)))
        x += (prefix as NSString).size(withAttributes: [.font: markedTextLabel.font as Any]).width
      }
      return CGRect(
        x: x,
        y: y,
        width: max(1, CGFloat(GhostteaTerminalLayout.cellWidth)),
        height: CGFloat(GhostteaTerminalLayout.lineHeight)
      )
    }
  }
#endif
