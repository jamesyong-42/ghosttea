import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SlotLayout } from "../../shared/messages";
import {
  ARCHITECTURE_SPECS,
  DEFAULT_LAB_CONFIG,
  RECIPES,
  WORKLOADS,
  clampConfig,
  expandViews,
  formatBytes,
  formatMs,
  mean,
  percentile,
  sessionHue,
  usesDomCanvases,
  type LabConfig,
  type LabRun,
  type LayoutId,
  type WorkloadId,
} from "../../shared/model";
import { PipelineHost } from "./host";

const host = new PipelineHost();

const WARMUP_MS = 700;
const MEASURE_MS = 2500;

function classNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export function App() {
  const [config, setConfig] = useState<LabConfig>(DEFAULT_LAB_CONFIG);
  const [adapter, setAdapter] = useState("requesting adapter");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [mountKey, setMountKey] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const stageCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const applied = useRef(0);

  const views = useMemo(
    () => expandViews(config.sessions, config.viewsPerSession),
    [config.sessions, config.viewsPerSession],
  );
  const spec = ARCHITECTURE_SPECS.find((candidate) => candidate.id === config.architecture) ?? ARCHITECTURE_SPECS[0]!;

  const patch = useCallback((partial: Partial<LabConfig>) => {
    setConfig((current) => clampConfig({ ...current, ...partial }));
    setMountKey((value) => value + 1);
  }, []);

  useEffect(() => {
    host.onError = (message) => setError(message);
    return () => {
      host.onError = undefined;
    };
  }, []);

  const publishLayout = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const origin = stageCanvasRef.current ?? stage;
    const stageBox = origin.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const slots: SlotLayout[] = [];
    for (const node of stage.querySelectorAll<HTMLElement>("[data-view-id]")) {
      const box = node.getBoundingClientRect();
      const viewId = node.dataset.viewId;
      if (!viewId) continue;
      slots.push({
        viewId,
        x: box.left - stageBox.left,
        y: box.top - stageBox.top,
        width: box.width,
        height: box.height,
        dpr,
      });
    }
    host.layout(slots, stageBox.width, stageBox.height, dpr);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = ++applied.current;
    const boot = async (): Promise<void> => {
      setError(null);
      const name = await host.configure(config);
      if (cancelled || generation !== applied.current) return;
      setAdapter(name);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (cancelled || generation !== applied.current) return;
      const dpr = window.devicePixelRatio;
      if (!usesDomCanvases(config.architecture)) {
        const canvas = stageCanvasRef.current;
        const stage = stageRef.current;
        if (!canvas || !stage) return;
        const box = stage.getBoundingClientRect();
        host.mountStage(canvas.transferControlToOffscreen(), box.width, box.height, dpr);
        publishLayout();
        return;
      }
      const canvases = new Map<string, OffscreenCanvas>();
      const sizes = new Map<string, { width: number; height: number; dpr: number }>();
      for (const view of views) {
        const node = viewCanvases.current.get(view.viewId);
        if (!node) continue;
        const box = node.getBoundingClientRect();
        canvases.set(view.viewId, node.transferControlToOffscreen());
        sizes.set(view.viewId, { width: Math.max(1, box.width), height: Math.max(1, box.height), dpr });
      }
      host.mountViews(config, canvases, sizes);
      publishLayout();
    };
    void boot().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
    };
  }, [config, mountKey, publishLayout, views]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => {
      publishLayout();
      if (!usesDomCanvases(config.architecture)) return;
      const dpr = window.devicePixelRatio;
      for (const [viewId, canvas] of viewCanvases.current) {
        const box = canvas.getBoundingClientRect();
        host.resizeView(viewId, box.width, box.height, dpr);
      }
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [config.architecture, publishLayout, mountKey, config.layout]);

  const arm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const processSamples: Array<{ cpuPercent: number; workingSetBytes: number }> = [];
    const timer = window.setInterval(() => {
      void window.pipelineLab.sampleProcess().then((sample) => {
        processSamples.push({ cpuPercent: sample.cpuPercent, workingSetBytes: sample.workingSetBytes });
      });
    }, 200);
    try {
      await new Promise((resolve) => window.setTimeout(resolve, WARMUP_MS));
      const measured = await host.measure(MEASURE_MS);
      const cpu = mean(processSamples.map((sample) => sample.cpuPercent)) ?? 0;
      const rss = mean(processSamples.map((sample) => sample.workingSetBytes)) ?? 0;
      setRuns((current) =>
        [
          {
            id: `${Date.now().toString(36)}-${current.length}`,
            at: Date.now(),
            config,
            durationMs: measured.durationMs,
            counters: measured.counters,
            process: { cpuPercent: cpu, workingSetBytes: rss, samples: processSamples.length },
          },
          ...current,
        ].slice(0, 12),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      window.clearInterval(timer);
      setBusy(false);
    }
  };

  return (
    <div className="lab">
      <header className="mast">
        <div className="mast-mark">
          <span className="sprocket" aria-hidden="true" />
          <div>
            <p className="eyebrow">Ghosttea · Electron end</p>
            <h1>Pipeline Lab</h1>
          </div>
        </div>
        <p className="mast-claim">
          Same synthetic grid. Different GPU topologies. The counters below are the argument, not the screenshots.
        </p>
        <div className="mast-meta">
          <span>{adapter}</span>
          <span>
            {views.length} views · {config.sessions} session{config.sessions === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      <aside className="gates" aria-label="Architecture candidates">
        {ARCHITECTURE_SPECS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={classNames("gate", config.architecture === candidate.id && "is-live")}
            onClick={() => patch({ architecture: candidate.id })}
          >
            <span className="gate-name">{candidate.gate}</span>
            <span className="gate-title">{candidate.title}</span>
            <span className="gate-cost">
              scene {candidate.scenePasses} · present {candidate.presents}
            </span>
          </button>
        ))}
      </aside>

      <section className="brief">
        <h2>{spec.title}</h2>
        <p>{spec.claim}</p>
        <dl>
          <div>
            <dt>Wins when</dt>
            <dd>{spec.winsWhen}</dd>
          </div>
          <div>
            <dt>Loses when</dt>
            <dd>{spec.losesWhen}</dd>
          </div>
        </dl>
        <div className="recipes">
          {RECIPES.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className="recipe"
              onClick={() => patch({ architecture: config.architecture, ...recipe.patch })}
              title={recipe.question}
            >
              {recipe.title}
            </button>
          ))}
        </div>
        <form className="dials" onSubmit={(event) => event.preventDefault()}>
          <label>
            Sessions
            <input
              type="number"
              min={1}
              max={32}
              value={config.sessions}
              onChange={(event) => patch({ sessions: Number(event.target.value) })}
            />
          </label>
          <label>
            Views / session
            <input
              type="number"
              min={1}
              max={16}
              value={config.viewsPerSession}
              onChange={(event) => patch({ viewsPerSession: Number(event.target.value) })}
            />
          </label>
          <label>
            Grid
            <span className="pair">
              <input
                type="number"
                min={20}
                max={240}
                value={config.cols}
                onChange={(event) => patch({ cols: Number(event.target.value) })}
              />
              <input
                type="number"
                min={6}
                max={80}
                value={config.rows}
                onChange={(event) => patch({ rows: Number(event.target.value) })}
              />
            </span>
          </label>
          <label>
            Workload
            <select value={config.workload} onChange={(event) => patch({ workload: event.target.value as WorkloadId })}>
              {WORKLOADS.map((workload) => (
                <option key={workload} value={workload}>
                  {workload}
                </option>
              ))}
            </select>
          </label>
          <label>
            Layout
            <select value={config.layout} onChange={(event) => patch({ layout: event.target.value as LayoutId })}>
              <option value="grid">equal grid</option>
              <option value="stage-and-tiles">stage + tiles</option>
              <option value="thumbnails">thumbnails</option>
            </select>
          </label>
          <label>
            Scene size
            <select
              value={config.sceneResolution}
              onChange={(event) => patch({ sceneResolution: event.target.value as LabConfig["sceneResolution"] })}
            >
              <option value="view">per view</option>
              <option value="authority">authority</option>
              <option value="grid-native">grid-native</option>
            </select>
          </label>
          <label>
            Effects
            <select
              value={config.effectScope}
              onChange={(event) => patch({ effectScope: event.target.value as LabConfig["effectScope"] })}
            >
              <option value="off">off</option>
              <option value="scene">on scene</option>
              <option value="view">on each view</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={config.devicePerView}
              disabled={config.architecture !== "per-view-scene"}
              onChange={(event) => patch({ devicePerView: event.target.checked })}
            />
            GPUDevice per view
          </label>
        </form>
        <button type="button" className="arm" disabled={busy} onClick={() => void arm()}>
          {busy ? "Measuring…" : "Arm 2.5s"}
        </button>
        {error ? <p className="fault">{error}</p> : null}
      </section>

      <section className="sheet" ref={stageRef} data-layout={config.layout}>
        {config.architecture === "window-composite" ? (
          <canvas key={`stage-${mountKey}`} ref={stageCanvasRef} className="stage-canvas" />
        ) : null}
        {views.map((view) => (
          <article
            key={`${mountKey}-${view.viewId}`}
            className={classNames("frame", view.role === "authority" && "is-authority")}
            data-view-id={view.viewId}
            style={{ "--session": `${sessionHue(view.sessionIndex)}` } as CSSProperties}
          >
            {usesDomCanvases(config.architecture) ? (
              <canvas
                ref={(node) => {
                  if (node) viewCanvases.current.set(view.viewId, node);
                  else viewCanvases.current.delete(view.viewId);
                }}
              />
            ) : (
              <div className="frame-ghost" />
            )}
            <span className="frame-tag">
              {view.sessionId} {view.role === "authority" ? "AUTH" : "MIRROR"}
            </span>
          </article>
        ))}
      </section>

      <section className="densitometer" aria-label="Run log">
        <table>
          <thead>
            <tr>
              <th>gate</th>
              <th>topology</th>
              <th>load</th>
              <th>scene</th>
              <th>blit</th>
              <th>present</th>
              <th>submit</th>
              <th>cpu p95</th>
              <th>upload</th>
              <th>bitmap</th>
              <th>rss</th>
              <th>proc cpu</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td colSpan={12}>Arm a run. Warmup is discarded. Compare rows, not feelings.</td>
              </tr>
            ) : (
              runs.map((run) => (
                <tr key={run.id}>
                  <td>{run.config.architecture}</td>
                  <td>
                    {run.config.sessions}×{run.config.viewsPerSession} {run.config.layout}
                  </td>
                  <td>{run.config.workload}</td>
                  <td>{run.counters.scenePasses}</td>
                  <td>{run.counters.blitPasses}</td>
                  <td>{run.counters.swapchainAcquires}</td>
                  <td>{run.counters.queueSubmits}</td>
                  <td>{formatMs(percentile(run.counters.renderCpuMs, 95))}</td>
                  <td>{formatBytes(run.counters.uploadBytes)}</td>
                  <td>{run.counters.bitmapTransfers}</td>
                  <td>{formatBytes(run.process.workingSetBytes)}</td>
                  <td>{run.process.cpuPercent.toFixed(1)}%</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
