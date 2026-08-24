import type { LabConfig, ViewRole, WorkerCounters } from "./model";

export interface SlotLayout {
  viewId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

export interface ViewMountSpec extends ViewRole {
  width: number;
  height: number;
  dpr: number;
  bitmap: boolean;
}

export type HostToWorker =
  | { type: "configure"; config: LabConfig }
  | { type: "mount-stage"; canvas: OffscreenCanvas; width: number; height: number; dpr: number }
  | { type: "mount-views"; views: ViewMountSpec[]; canvases: OffscreenCanvas[] }
  | { type: "layout"; slots: SlotLayout[]; stageWidth: number; stageHeight: number; stageDpr: number }
  | { type: "resize-view"; viewId: string; width: number; height: number; dpr: number }
  | { type: "measure-start"; requestId: number }
  | { type: "measure-stop"; requestId: number };

export type WorkerToHost =
  | { type: "ready"; adapter: string }
  | { type: "error"; message: string }
  | { type: "status"; running: boolean; views: number; sessions: number }
  | { type: "measure-result"; requestId: number; durationMs: number; counters: WorkerCounters };
