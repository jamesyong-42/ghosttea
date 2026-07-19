import { useEffect, useState } from "react";
import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import {
  DEFAULT_THEME,
  TerminalSurface,
  useGhostteaRuntime,
  type TerminalRenderPerformanceSnapshot,
} from "@vibecook/ghosttea-react";
import type { ElectronCaseSamples, RenderBenchmarkCase, RenderBenchmarkConfig } from "../../benchmark/types";

interface MeasuredIteration {
  iteration: number;
  payloadBytes: number;
  endToIdleMs: number;
  worker: TerminalRenderPerformanceSnapshot;
  electron: ElectronCaseSamples;
}

let suiteStarted = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
}

function waitForSessionExits(
  runtime: ReturnType<typeof useGhostteaRuntime>,
  sessionIds: readonly string[],
): Promise<void> {
  const remaining = new Set(sessionIds);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      runtime.removeEventListener("session-exited", onExit);
      reject(new Error(`Timed out waiting for benchmark sessions: ${[...remaining].join(", ")}`));
    }, 120_000);
    const onExit = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      remaining.delete(detail.sessionId);
      if (remaining.size !== 0) return;
      window.clearTimeout(timeout);
      runtime.removeEventListener("session-exited", onExit);
      resolve();
    };
    runtime.addEventListener("session-exited", onExit);
  });
}

export function RenderBenchmarkApp({ config }: { config: RenderBenchmarkConfig }) {
  const runtime = useGhostteaRuntime();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState("Preparing WebGPU renderer…");
  const [resizeOffset, setResizeOffset] = useState(0);
  const [activeCaseKind, setActiveCaseKind] = useState<RenderBenchmarkCase["kind"] | null>(null);

  useEffect(() => {
    if (suiteStarted) return;
    suiteStarted = true;
    const views = new Map<string, string>();
    const waiters = new Map<string, (viewId: string) => void>();
    const onAttached = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId: string; viewId: string }>).detail;
      views.set(detail.sessionId, detail.viewId);
      waiters.get(detail.sessionId)?.(detail.viewId);
      waiters.delete(detail.sessionId);
    };
    runtime.addEventListener("view-attached", onAttached);

    const waitForView = (sessionId: string): Promise<string> => {
      const existing = views.get(sessionId);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.set(sessionId, resolve));
    };

    const createSessions = async (benchmarkCase: RenderBenchmarkCase): Promise<SessionSummary[]> => {
      const idle = benchmarkCase.kind === "idle" || benchmarkCase.kind === "resize";
      const interactive = benchmarkCase.kind === "interactive";
      const created = await Promise.all(
        Array.from({ length: benchmarkCase.panes }, () =>
          runtime.createSession({
            executable: idle ? "/bin/sh" : interactive ? "/bin/cat" : config.workloadExecutable,
            args: idle
              ? ["-c", "IFS= read -r _"]
              : interactive
                ? []
                : [
                    config.workloadScript,
                    benchmarkCase.payloadPath ?? "",
                    String(benchmarkCase.chunkBytes ?? 8192),
                    String(benchmarkCase.intervalMs ?? 8),
                  ],
            environment: {
              mode: "clean",
              variables: {
                HOME: "/tmp",
                LANG: "en_US.UTF-8",
                PATH: "/usr/bin:/bin",
                TERM: "xterm-256color",
              },
            },
            cols: config.cols,
            rows: config.rows,
            persistence: "terminate-with-app",
          }),
        ),
      );
      setActiveCaseKind(benchmarkCase.kind);
      setSessions(created);
      await nextPaint();
      await Promise.all(created.map((session) => waitForView(session.id)));
      // Keep renderer/device/pipeline creation and the initial full snapshot out
      // of steady-state measurements. Cold start should be a separate suite.
      await delay(400);
      return created;
    };

    const cleanUpSessions = async (created: readonly SessionSummary[]): Promise<void> => {
      for (const session of created) runtime.terminate(session.id, "application");
      setSessions([]);
      setActiveCaseKind(null);
      await nextPaint();
      for (const session of created) views.delete(session.id);
    };

    const runIteration = async (
      benchmarkCase: RenderBenchmarkCase,
      iteration: number,
      measured: boolean,
    ): Promise<MeasuredIteration | undefined> => {
      setStatus(`${measured ? "Measuring" : "Warming"} ${benchmarkCase.name} ${iteration + 1}`);
      const created = await createSessions(benchmarkCase);
      const viewIds = await Promise.all(created.map((session) => waitForView(session.id)));
      const exitPromise =
        benchmarkCase.kind === "payload"
          ? waitForSessionExits(
              runtime,
              created.map((session) => session.id),
            )
          : undefined;

      await runtime.startPerformanceMeasurement();
      if (measured) await window.desktop.startRenderBenchmarkCase(benchmarkCase.name, iteration);
      const startedAt = performance.now();

      if (benchmarkCase.kind === "idle") {
        await delay(benchmarkCase.durationMs ?? 2_500);
      } else if (benchmarkCase.kind === "resize") {
        const frames = benchmarkCase.operations ?? 180;
        for (let frame = 0; frame < frames; frame += 1) {
          setResizeOffset(frame % 2 === 0 ? 0 : 37);
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        setResizeOffset(0);
        await nextPaint();
      } else if (benchmarkCase.kind === "interactive") {
        const operations = benchmarkCase.operations ?? 180;
        for (let operation = 0; operation < operations; operation += 1) {
          runtime.sendText(created[0]!.id, viewIds[0]!, benchmarkCase.inputText ?? `input-${operation}\n`);
          await delay(benchmarkCase.intervalMs ?? 16);
        }
      } else {
        for (let index = 0; index < created.length; index += 1) {
          runtime.sendText(created[index]!.id, viewIds[index]!, "\n");
        }
        await exitPromise;
      }

      const worker = await runtime.finishPerformanceMeasurement({ quietMs: config.quietMs, timeoutMs: 20_000 });
      const endToIdleMs = performance.now() - startedAt;
      const electron = measured
        ? ((await window.desktop.finishRenderBenchmarkCase()) as ElectronCaseSamples)
        : { caseName: benchmarkCase.name, iteration, samples: [] };
      await cleanUpSessions(created);
      await delay(config.cooldownMs);

      if (worker.backend !== "webgpu") {
        throw new Error(`Rendering benchmark requires WebGPU; worker selected ${worker.backend}`);
      }
      if (!measured) return undefined;
      return {
        iteration,
        payloadBytes: (benchmarkCase.payloadBytes ?? 0) * benchmarkCase.panes,
        endToIdleMs,
        worker,
        electron,
      };
    };

    const run = async (): Promise<void> => {
      await runtime.connect();
      const results: Record<string, MeasuredIteration[]> = {};
      for (const benchmarkCase of config.cases) {
        for (let iteration = 0; iteration < config.warmupIterations; iteration += 1) {
          await runIteration(benchmarkCase, iteration, false);
        }
        const measurements: MeasuredIteration[] = [];
        for (let iteration = 0; iteration < config.measuredIterations; iteration += 1) {
          const result = await runIteration(benchmarkCase, iteration, true);
          if (result) measurements.push(result);
        }
        results[benchmarkCase.name] = measurements;
      }
      setStatus("Benchmark complete");
      await window.desktop.completeRenderBenchmark({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        config,
        results: { cases: results },
      });
    };

    void run().catch(async (error) => {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      setStatus(`Benchmark failed: ${message}`);
      await window.desktop.failRenderBenchmark(message);
    });
    return () => runtime.removeEventListener("view-attached", onAttached);
  }, [config, runtime]);

  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, sessions.length))));
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: "minmax(0, 1fr)",
        gap: 1,
        paddingRight: resizeOffset,
        paddingBottom: resizeOffset,
        boxSizing: "border-box",
        background: "black",
      }}
    >
      {sessions.map((session, index) => (
        <TerminalSurface
          key={session.id}
          session={session}
          theme={DEFAULT_THEME}
          active={index === 0 && (activeCaseKind === "idle" || activeCaseKind === "interactive")}
          visible
          controlsResize
        />
      ))}
      <output
        style={{
          position: "fixed",
          zIndex: 10,
          right: 6,
          bottom: 4,
          color: "#8a8f98",
          background: "rgb(0 0 0 / 70%)",
          font: "11px ui-monospace, monospace",
          pointerEvents: "none",
        }}
      >
        {status}
      </output>
    </main>
  );
}
