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
    public var onNeedsFullRefresh: (() -> Void)?
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
    private var cursorBlinkVisible = true
    private var gpuSuspended = false

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

    @discardableResult
    public func apply(frame data: Data) throws -> Bool {
      do {
        switch try retainedState.apply(data) {
        case .applied:
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
      terminalSelection = GhostteaMetalSelection(
        anchor: GhostteaMetalCellPoint(column: anchorColumn, row: anchorRow),
        focus: GhostteaMetalCellPoint(column: focusColumn, row: focusRow)
      )
      requestEventDrivenDraw()
    }

    public func clearSelection() {
      terminalSelection = nil
      requestEventDrivenDraw()
    }

    public func setTerminalFocused(_ focused: Bool) {
      guard terminalFocused != focused else { return }
      terminalFocused = focused
      requestEventDrivenDraw()
    }

    public func setCursorBlinkVisible(_ visible: Bool) {
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
      evictRendererResources()
    }

    public func resumeGPU() {
      guard gpuSuspended else { return }
      gpuSuspended = false
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

    private func geometryDidChange() {
      updateGridSize()
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
#endif
