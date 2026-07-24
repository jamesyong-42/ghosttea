import { execFileSync } from "node:child_process";

import { TerminaldHarness } from "../../bench/lib/terminald-client.mjs";

const sessionsPerRound = positiveInteger("GHOSTTEA_SOAK_SESSIONS", 256);
const rounds = positiveInteger("GHOSTTEA_SOAK_ROUNDS", 1);
const warmupSessions = positiveInteger("GHOSTTEA_SOAK_WARMUP_SESSIONS", 16);
const maximumRssGrowthMiB = positiveNumber("GHOSTTEA_SOAK_MAX_RSS_GROWTH_MIB", 32);
const maximumThreadGrowth = positiveInteger("GHOSTTEA_SOAK_MAX_THREAD_GROWTH", 4);

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processSample(pid) {
  const rssOutput = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
  const rssKiB = Number(rssOutput);
  const threads =
    process.platform === "darwin"
      ? execFileSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" })
          .trim()
          .split("\n").length - 1
      : Number(
          execFileSync("ps", ["-o", "nlwp=", "-p", String(pid)], {
            encoding: "utf8",
          }).trim(),
        );
  if (!Number.isFinite(rssKiB) || !Number.isFinite(threads)) {
    throw new Error(`Unable to sample process ${pid}`);
  }
  return { rssKiB, threads };
}

async function stableProcessSample(pid) {
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    samples.push(processSample(pid));
    await delay(100);
  }
  return {
    rssKiB: Math.min(...samples.map((sample) => sample.rssKiB)),
    threads: Math.min(...samples.map((sample) => sample.threads)),
  };
}

async function waitForSessionExit(harness, sessionId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await harness.request("list-sessions");
    if (response.type !== "sessions") throw new Error("terminald returned an unexpected session list");
    if (!response.sessions.some((session) => session.id === sessionId)) return;
    await delay(10);
  }
  throw new Error(`session ${sessionId} did not leave the registry after natural exit`);
}

async function churnSession(harness, label) {
  const marker = `ghosttea-lifecycle-${label}`;
  const ownerId = `ghosttea-lifecycle-owner-${label}`;
  const created = await harness.request("create-session", {
    options: {
      executable: "/bin/sh",
      args: ["-c", `printf '${marker}\\n'; sleep 0.08`],
      environment: {
        mode: "clean",
        variables: { PATH: "/usr/bin:/bin", LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "xterm-256color" },
      },
      cols: 80,
      rows: 24,
      persistence: "keep-until-exit",
      programKind: "application",
      ownerId,
    },
  });
  if (created.type !== "session-created") throw new Error("terminald returned an unexpected create-session response");

  harness.setFrameSubscriptions([created.session.handle]);
  const viewId = `lifecycle-view-${label}`;
  const attached = await harness.request("attach-session", { sessionId: created.session.id, viewId });
  if (attached.type !== "view-attached") throw new Error("terminald returned an unexpected attach-session response");
  await harness.waitForMarker(created.session.handle, marker);
  await waitForSessionExit(harness, created.session.id);
  harness.setFrameSubscriptions([]);

  const closed = await harness.request("close-session-owner", { ownerId });
  if (closed.type !== "ok") throw new Error("terminald rejected lifecycle-owner closure");
}

async function churn(harness, count, prefix) {
  for (let index = 0; index < count; index += 1) {
    await churnSession(harness, `${prefix}-${index}`);
  }
}

if (process.platform !== "darwin" && process.platform !== "linux") {
  throw new Error(`terminald lifecycle soak does not support ${process.platform}`);
}

const harness = await TerminaldHarness.start();
try {
  if (!harness.pid) throw new Error("terminald lifecycle soak requires a directly spawned ghosttead process");
  await churn(harness, warmupSessions, "warmup");
  await delay(500);
  const baseline = await stableProcessSample(harness.pid);
  const maximumRssGrowthKiB = maximumRssGrowthMiB * 1024;

  for (let round = 0; round < rounds; round += 1) {
    await churn(harness, sessionsPerRound, `round-${round}`);
    await delay(750);
    const current = await stableProcessSample(harness.pid);
    const rssGrowthKiB = current.rssKiB - baseline.rssKiB;
    const threadGrowth = current.threads - baseline.threads;
    console.log(
      JSON.stringify({
        round: round + 1,
        sessions: sessionsPerRound,
        baseline,
        current,
        rssGrowthMiB: Number((rssGrowthKiB / 1024).toFixed(2)),
        threadGrowth,
      }),
    );
    if (threadGrowth > maximumThreadGrowth) {
      throw new Error(
        `ghosttead retained ${threadGrowth} threads after lifecycle churn; allowed growth is ${maximumThreadGrowth}`,
      );
    }
    if (rssGrowthKiB > maximumRssGrowthKiB) {
      throw new Error(
        `ghosttead RSS grew ${(rssGrowthKiB / 1024).toFixed(2)} MiB after lifecycle churn; allowed growth is ${maximumRssGrowthMiB} MiB`,
      );
    }
  }

  console.log(`ghosttead lifecycle soak passed (${rounds * sessionsPerRound} measured sessions)`);
} finally {
  harness.dispose();
}
