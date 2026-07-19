export interface TerminalRenderMetrics {
  queueSubmits: number;
  fullRenders: number;
  partialRenders: number;
  damagedRows: number;
  canvasPixels: number;
  renderPasses: number;
  drawCalls: number;
  rectangleVertices: number;
  monoGlyphVertices: number;
  colorGlyphVertices: number;
  fallbackGlyphVertices: number;
  vertexUploadBytes: number;
  atlasUploadBytes: number;
  atlasUploadCalls: number;
}

export interface TerminalRenderPerformanceSnapshot {
  backend: string;
  durationMs: number;
  timedOutWaitingForIdle: boolean;
  gpuQueueDrainMs: number | null;
  frames: {
    received: number;
    bytes: number;
    full: number;
    incremental: number;
    stale: number;
    resyncRequested: number;
    rowsDecoded: number;
    glyphDefinitions: number;
  };
  scheduling: {
    flushes: number;
    renderCalls: number;
    maximumDirtyPanes: number;
    panesPerFlush: number[];
  };
  renderer: {
    queueSubmits: number;
    fullRenders: number;
    partialRenders: number;
    damagedRows: number;
    canvasPixelFrames: number;
    renderPasses: number;
    drawCalls: number;
    rectangleVertices: number;
    monoGlyphVertices: number;
    colorGlyphVertices: number;
    fallbackGlyphVertices: number;
    vertexUploadBytes: number;
    atlasUploadBytes: number;
    atlasUploadCalls: number;
  };
  samples: {
    frameApplyMs: number[];
    renderCpuMs: number[];
    dirtyToRenderMs: number[];
    frameArrivalToRenderMs: number[];
  };
}

export function emptyRenderMetrics(): TerminalRenderMetrics {
  return {
    queueSubmits: 0,
    fullRenders: 0,
    partialRenders: 0,
    damagedRows: 0,
    canvasPixels: 0,
    renderPasses: 0,
    drawCalls: 0,
    rectangleVertices: 0,
    monoGlyphVertices: 0,
    colorGlyphVertices: 0,
    fallbackGlyphVertices: 0,
    vertexUploadBytes: 0,
    atlasUploadBytes: 0,
    atlasUploadCalls: 0,
  };
}
