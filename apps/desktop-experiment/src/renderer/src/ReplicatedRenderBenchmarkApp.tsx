import { useEffect, useState } from "react";
import type { SessionSummary, SharedSessionSummary } from "@vibecook/ghosttea-protocol";
import {
  DEFAULT_THEME,
  TerminalSurface,
  useGhostteaRuntime,
  type TerminalRenderPerformanceSnapshot,
} from "@vibecook/ghosttea-react";
import type { ElectronCaseSamples, RenderBenchmarkCase, RenderBenchmarkConfig } from "../../benchmark/types";

interface ProducerCompletion {
  schemaVersion: 1;
  payloadBytes: number;
  chunks: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  stdoutBackpressureMs: number;
}

interface MeasuredIteration {
  iteration: number;
  payloadBytes: number;
  endToIdleMs: number;
  producer: ProducerCompletion;
  worker: TerminalRenderPerformanceSnapshot;
  electron: ElectronCaseSamples;
  pixelCheck?: { partialHash: string; fullHash: string };
}

interface ViewAttachment {
  viewId: string;
  readWrite: boolean;
}

let replicatedSuiteStarted = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
}

function completionKey(benchmarkCase: RenderBenchmarkCase, measured: boolean, iteration: number): string {
  return `${benchmarkCase.name}-${measured ? "measure" : "warmup"}-${iteration}`;
}

function completionPath(config: RenderBenchmarkConfig, key: string): string {
  return `${config.replication!.completionDirectory}/${key}.json`;
}

function workloadArguments(config: RenderBenchmarkConfig, benchmarkCase: RenderBenchmarkCase, key: string): string[] {
  if (benchmarkCase.kind !== "payload" || !benchmarkCase.payloadPath) {
    throw new Error(`Replicated rendering only supports payload cases; received ${benchmarkCase.name}`);
  }
  return [
    config.workloadScript,
    benchmarkCase.payloadPath,
    String(benchmarkCase.chunkBytes ?? 8192),
    String(benchmarkCase.intervalMs ?? 8),
    benchmarkCase.chunkBytesSequence?.join(",") ?? "",
    completionPath(config, key),
  ];
}

function waitForSessionExit(
  runtime: ReturnType<typeof useGhostteaRuntime>,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      runtime.removeEventListener("session-exited", onExit);
      reject(new Error(`Timed out waiting for host session ${sessionId} to exit`));
    }, timeoutMs);
    const onExit = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      window.clearTimeout(timeout);
      runtime.removeEventListener("session-exited", onExit);
      resolve();
    };
    runtime.addEventListener("session-exited", onExit);
  });
}

function producerCompletion(value: unknown): ProducerCompletion {
  if (!value || typeof value !== "object") throw new Error("Host workload returned no completion metrics");
  const candidate = value as Partial<ProducerCompletion>;
  for (const key of [
    "payloadBytes",
    "chunks",
    "startedAt",
    "completedAt",
    "durationMs",
    "stdoutBackpressureMs",
  ] as const) {
    if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key])) {
      throw new Error(`Host workload returned an invalid ${key}`);
    }
  }
  if (candidate.schemaVersion !== 1) throw new Error("Host workload completion schema is unsupported");
  return candidate as ProducerCompletion;
}

async function findRemoteSession(
  runtime: ReturnType<typeof useGhostteaRuntime>,
  timeoutMs: number,
): Promise<{ deviceId: string; session: SharedSessionSummary }> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  let lastHosts: Awaited<ReturnType<typeof runtime.listRemoteHosts>> = [];
  while (performance.now() < deadline) {
    try {
      const hosts = await runtime.listRemoteHosts();
      lastHosts = hosts;
      for (const host of hosts.filter((candidate) => candidate.online)) {
        try {
          const sessions = await runtime.listRemoteSessions(host.deviceId);
          const session = sessions.find((candidate) => candidate.running && candidate.attachable);
          if (session) return { deviceId: host.deviceId, session };
        } catch (error) {
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const hostDetail = lastHosts
    .map(
      (host) =>
        `${host.deviceName} (${host.online ? "online" : "offline"}, ${host.sessions.length} advertised sessions)`,
    )
    .join(", ");
  const errorDetail = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(
    `Timed out discovering the replicated host session; last hosts: ${hostDetail || "none"}${errorDetail}`,
  );
}

export function ReplicatedRenderBenchmarkApp({ config }: { config: RenderBenchmarkConfig }) {
  const runtime = useGhostteaRuntime();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState(`Preparing replicated ${config.replication!.role}…`);

  useEffect(() => {
    if (replicatedSuiteStarted) return;
    replicatedSuiteStarted = true;
    const replication = config.replication!;
    const views = new Map<string, ViewAttachment>();
    const waiters = new Map<string, (attachment: ViewAttachment) => void>();
    const onAttached = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId: string; viewId: string; readWrite: boolean }>).detail;
      const attachment = { viewId: detail.viewId, readWrite: detail.readWrite };
      views.set(detail.sessionId, attachment);
      waiters.get(detail.sessionId)?.(attachment);
      waiters.delete(detail.sessionId);
    };
    runtime.addEventListener("view-attached", onAttached);

    const waitForView = (sessionId: string): Promise<ViewAttachment> => {
      const existing = views.get(sessionId);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.set(sessionId, resolve));
    };

    const mountSession = async (session: SessionSummary): Promise<ViewAttachment> => {
      setSessions([session]);
      await nextPaint();
      const attachment = await waitForView(session.id);
      await delay(400);
      return attachment;
    };

    const unmountSession = async (session: SessionSummary): Promise<void> => {
      runtime.terminate(session.id, "application");
      setSessions([]);
      views.delete(session.id);
      await nextPaint();
    };

    const iterations = function* () {
      for (const benchmarkCase of config.cases) {
        for (let iteration = 0; iteration < config.warmupIterations; iteration += 1) {
          yield { benchmarkCase, iteration, measured: false };
        }
        for (let iteration = 0; iteration < config.measuredIterations; iteration += 1) {
          yield { benchmarkCase, iteration, measured: true };
        }
      }
    };

    const runHost = async (): Promise<void> => {
      await runtime.connect();
      for (const { benchmarkCase, iteration, measured } of iterations()) {
        const phase = measured ? "measure" : "warmup";
        setStatus(`Host ready: ${benchmarkCase.name} ${phase} ${iteration + 1}`);
        const key = completionKey(benchmarkCase, measured, iteration);
        const session = await runtime.createSession({
          executable: config.workloadExecutable,
          args: workloadArguments(config, benchmarkCase, key),
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
        });
        const exited = waitForSessionExit(runtime, session.id, replication.workloadTimeoutMs);
        await mountSession(session);
        await exited;
        await unmountSession(session);
        await delay(config.cooldownMs);
      }
      setStatus("Host suite complete; waiting for viewer…");
    };

    const runViewerIteration = async (
      benchmarkCase: RenderBenchmarkCase,
      iteration: number,
      measured: boolean,
    ): Promise<MeasuredIteration | undefined> => {
      const phase = measured ? "measure" : "warmup";
      setStatus(`Discovering ${benchmarkCase.name} ${phase} ${iteration + 1}…`);
      const remote = await findRemoteSession(runtime, replication.discoveryTimeoutMs);
      const session = await runtime.openRemoteSession(
        remote.deviceId,
        remote.session.sessionId,
        config.cols,
        config.rows,
      );
      const attachment = await mountSession(session);
      if (!attachment.readWrite) {
        throw new Error("Replicated benchmark requires a writable remote view to release the workload gate");
      }
      setStatus(`${measured ? "Measuring" : "Warming"} remote ${benchmarkCase.name} ${iteration + 1}`);
      if (config.startDelayMs) await delay(config.startDelayMs);
      const key = completionKey(benchmarkCase, measured, iteration);
      const completion = window.desktop.waitForRenderBenchmarkCompletion(key, replication.workloadTimeoutMs);
      await runtime.startPerformanceMeasurement();
      if (measured) await window.desktop.startRenderBenchmarkCase(benchmarkCase.name, iteration);
      const startedAt = performance.now();
      runtime.sendText(session.id, attachment.viewId, "\n");
      const producer = producerCompletion(await completion);
      const worker = await runtime.finishPerformanceMeasurement({
        quietMs: config.quietMs,
        timeoutMs: replication.workloadTimeoutMs,
      });
      const endToIdleMs = performance.now() - startedAt;
      const electron = measured
        ? ((await window.desktop.finishRenderBenchmarkCase()) as ElectronCaseSamples)
        : { caseName: benchmarkCase.name, iteration, samples: [] };
      let pixelCheck: MeasuredIteration["pixelCheck"];
      if (measured && config.verifyPixels) {
        const partialHash = await window.desktop.renderBenchmarkFrameHash();
        await runtime.startPerformanceMeasurement();
        runtime.forceFullRedraw(session.handle);
        const verification = await runtime.finishPerformanceMeasurement({ quietMs: config.quietMs, timeoutMs: 20_000 });
        if (verification.renderer.fullRenders !== 1) {
          throw new Error(`Expected one forced full redraw; observed ${verification.renderer.fullRenders}`);
        }
        const fullHash = await window.desktop.renderBenchmarkFrameHash();
        pixelCheck = { partialHash, fullHash };
        if (partialHash !== fullHash) throw new Error(`Remote partial rendering differs for ${benchmarkCase.name}`);
      }
      await unmountSession(session);
      await delay(config.cooldownMs);
      if (worker.backend !== "webgpu") {
        throw new Error(`Replicated rendering benchmark requires WebGPU; worker selected ${worker.backend}`);
      }
      if (worker.frames.received === 0) throw new Error(`No replicated frames arrived for ${benchmarkCase.name}`);
      if (!measured) return undefined;
      return {
        iteration,
        payloadBytes: producer.payloadBytes,
        endToIdleMs,
        producer,
        worker,
        electron,
        ...(pixelCheck ? { pixelCheck } : {}),
      };
    };

    const runViewer = async (): Promise<void> => {
      await runtime.connect();
      const results: Record<string, MeasuredIteration[]> = {};
      for (const benchmarkCase of config.cases) {
        for (let iteration = 0; iteration < config.warmupIterations; iteration += 1) {
          await runViewerIteration(benchmarkCase, iteration, false);
        }
        const measurements: MeasuredIteration[] = [];
        for (let iteration = 0; iteration < config.measuredIterations; iteration += 1) {
          const result = await runViewerIteration(benchmarkCase, iteration, true);
          if (result) measurements.push(result);
        }
        results[benchmarkCase.name] = measurements;
      }
      setStatus("Replicated rendering benchmark complete");
      await window.desktop.completeRenderBenchmark({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        config,
        results: { cases: results },
      });
    };

    const run = replication.role === "host" ? runHost : runViewer;
    void run().catch(async (error) => {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      setStatus(`Replicated benchmark failed: ${message}`);
      await window.desktop.failRenderBenchmark(message);
    });
    return () => runtime.removeEventListener("view-attached", onAttached);
  }, [config, runtime]);

  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        background: "black",
      }}
    >
      {sessions.map((session) => (
        <TerminalSurface
          key={session.id}
          session={session}
          theme={DEFAULT_THEME}
          active={false}
          visible
          controlsResize={false}
        />
      ))}
      <output
        style={{
          position: "fixed",
          zIndex: 10,
          left: 8,
          top: 8,
          color: config.replication!.role === "host" ? "#ffd580" : "#8ee6a8",
          background: "rgb(0 0 0 / 78%)",
          padding: "4px 6px",
          font: "12px ui-monospace, monospace",
          pointerEvents: "none",
        }}
      >
        {config.replication!.role.toUpperCase()} · {status}
      </output>
    </main>
  );
}
