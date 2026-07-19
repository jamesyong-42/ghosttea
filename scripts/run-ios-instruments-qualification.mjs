import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };
const project = join(root, "apple/GhostteaHarness/GhostteaHarness.xcodeproj");
const derivedData = join(root, "native/build/ios-instruments/DerivedData");
const outputDirectory = join(root, "native/build/ios-instruments");
const evidencePath = join(outputDirectory, "evidence.json");
const app = join(derivedData, "Build/Products/Release-iphoneos/GhostteaHarness.app");
const bundleIdentifier = "com.vibecook.GhostteaHarness";
const release = process.argv.includes("--release");
const quick = process.argv.includes("--quick") || !release;
const expectedTemplates = ["Time Profiler"];
const expectedInstruments = ["Metal Application", "Points of Interest", "Power Profiler", "Thermal State"];
const scenarios = [
  { id: "idle", workload: "idle", durationSeconds: quick ? 5 : 60 },
  { id: "rendered-output-1", workload: "output1", durationSeconds: quick ? 10 : 120 },
  { id: "rendered-output-4", workload: "output4", durationSeconds: quick ? 10 : 120 },
  { id: "rendered-output-8", workload: "output8", durationSeconds: quick ? 10 : 120 },
];

mkdirSync(outputDirectory, { recursive: true });
const sourceRevision = capture("git", ["rev-parse", "HEAD"]);
const sourceClean = capture("git", ["status", "--porcelain"]) === "";
const xcode = capture("xcodebuild", ["-version"]);
const sdkVersion = capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]);
const xctraceVersion = capture("xcrun", ["xctrace", "version"]);
const templateOutput = capture("xcrun", ["xctrace", "list", "templates"]);
const instrumentOutput = capture("xcrun", ["xctrace", "list", "instruments"]);
const device = findDevice();

const evidence = {
  schemaVersion: 1,
  status: "blocked",
  sourceRevision,
  sourceClean,
  releaseMode: release,
  quickMode: quick,
  appBundleSha256: null,
  recordedAt: null,
  toolchain: {
    xcodeVersion: firstMatch(xcode, /^Xcode (.+)$/m),
    xcodeBuild: firstMatch(xcode, /^Build version (.+)$/m),
    iphoneOSSDKVersion: sdkVersion,
    xctraceVersion: firstMatch(xctraceVersion, /xctrace version (.+)$/m),
  },
  device: {
    modelIdentifier: device.hardwareProperties.productType,
    systemVersion: device.deviceProperties.osVersionNumber,
    developerModeEnabled: device.deviceProperties.developerModeStatus === "enabled",
    ddiServicesAvailable: device.deviceProperties.ddiServicesAvailable === true,
  },
  protocol: {
    template: expectedTemplates[0],
    instruments: expectedInstruments,
    scenarios: scenarios.map(({ id, durationSeconds }) => ({ id, durationSeconds })),
  },
  review: {
    cpu: "pending",
    energy: "pending",
  },
  traces: [],
  blockers: [],
};

for (const template of expectedTemplates) {
  if (!listed(templateOutput, template)) evidence.blockers.push(`missing xctrace template: ${template}`);
}
for (const instrument of expectedInstruments) {
  if (!listed(instrumentOutput, instrument)) evidence.blockers.push(`missing xctrace instrument: ${instrument}`);
}
if (!evidence.device.developerModeEnabled) evidence.blockers.push("physical device Developer Mode is disabled");
if (compareMajorMinor(sdkVersion, evidence.device.systemVersion) < 0) {
  evidence.blockers.push(
    `locked iPhoneOS SDK ${sdkVersion} does not support device OS ${evidence.device.systemVersion}`,
  );
}
if (release && !sourceClean) evidence.blockers.push("release trace capture requires a clean source worktree");

if (evidence.blockers.length > 0) {
  writeEvidence(evidence);
  console.error("iOS Instruments qualification blocked before capture:");
  for (const blocker of evidence.blockers) console.error(`- ${blocker}`);
  process.exitCode = 1;
} else {
  try {
    await captureTraces(evidence, device);
  } catch {
    evidence.blockers.push("capture setup failed");
    evidence.status = "blocked";
    writeEvidence(evidence);
    console.error("iOS Instruments qualification failed during capture setup.");
    process.exitCode = 1;
  }
}

async function captureTraces(result, selectedDevice) {
  const team = developmentTeam();
  requireUnlocked(selectedDevice);
  execute("xcodebuild", [
    "-project",
    project,
    "-scheme",
    "GhostteaHarness",
    "-allowProvisioningUpdates",
    "-configuration",
    "Release",
    "-quiet",
    "-destination",
    `id=${selectedDevice.hardwareProperties.udid}`,
    "-derivedDataPath",
    derivedData,
    `DEVELOPMENT_TEAM=${team}`,
    "CODE_SIGN_STYLE=Automatic",
    "build",
  ]);
  requireUnlocked(selectedDevice);
  execute("xcrun", ["devicectl", "device", "install", "app", "--device", selectedDevice.identifier, app]);
  result.appBundleSha256 = hashTree(app);

  for (const scenario of scenarios) {
    const traceName = `${scenario.id}.trace`;
    const tracePath = join(outputDirectory, traceName);
    const tocPath = join(outputDirectory, `${scenario.id}.toc.xml`);
    rmSync(tracePath, { recursive: true, force: true });
    rmSync(tocPath, { force: true });
    requireUnlocked(selectedDevice);
    let recording;
    try {
      recording = execute(
        "xcrun",
        [
          "xctrace",
          "record",
          "--template",
          expectedTemplates[0],
          ...expectedInstruments.flatMap((instrument) => ["--instrument", instrument]),
          "--device",
          selectedDevice.hardwareProperties.udid,
          "--time-limit",
          `${scenario.durationSeconds + 30}s`,
          "--output",
          tracePath,
          "--no-prompt",
          "--target-stdout",
          "-",
          "--env",
          `GHOSTTEA_PERFORMANCE_TRACE_SCENARIO=${scenario.workload}`,
          "--env",
          `GHOSTTEA_PERFORMANCE_TRACE_DURATION_SECONDS=${scenario.durationSeconds}`,
          "--env",
          "GHOSTTEA_PERFORMANCE_RECORDING=1",
          "--launch",
          "--",
          bundleIdentifier,
        ],
        { capture: true, allowFailure: true, timeout: (scenario.durationSeconds + 90) * 1_000 },
      );
    } catch {
      result.blockers.push(`${scenario.id} xctrace recording failed with status -1`);
      continue;
    } finally {
      terminateHarness(selectedDevice);
    }
    if (recording.status !== 0) {
      result.blockers.push(`${scenario.id} xctrace recording failed with status ${recording.status ?? -1}`);
      continue;
    }
    const completionMarker = `GHOSTTEA_PERFORMANCE_TRACE_COMPLETE ${scenario.workload} ${scenario.durationSeconds}`;
    if (!recording.stdout.includes(completionMarker)) {
      result.blockers.push(`${scenario.id} workload did not report completion`);
      continue;
    }
    if (!existsSync(tracePath)) {
      result.blockers.push(`${scenario.id} did not produce a trace bundle`);
      continue;
    }
    const exported = execute("xcrun", ["xctrace", "export", "--input", tracePath, "--toc", "--output", tocPath], {
      capture: true,
      allowFailure: true,
    });
    if (exported.status !== 0 || !existsSync(tocPath)) {
      result.blockers.push(`${scenario.id} trace table-of-contents export failed`);
      continue;
    }
    const toc = readFileSync(tocPath, "utf8");
    const traceDurationSeconds = Number(firstMatch(toc, /<duration>([0-9.]+)<\/duration>/));
    if (!/<device\b[^>]*platform="iOS"/.test(toc)) {
      result.blockers.push(`${scenario.id} trace did not target a physical iOS device`);
      continue;
    }
    if (!Number.isFinite(traceDurationSeconds) || traceDurationSeconds < scenario.durationSeconds) {
      result.blockers.push(`${scenario.id} trace duration is shorter than its workload`);
      continue;
    }
    result.traces.push({
      id: scenario.id,
      durationSeconds: traceDurationSeconds,
      traceBundleSha256: hashTree(tracePath),
      tocSha256: sha256(readFileSync(tocPath)),
    });
    writeEvidence(result);
  }

  if (result.traces.length !== scenarios.length) {
    result.blockers.push(`captured ${result.traces.length} of ${scenarios.length} required traces`);
  }
  result.status = result.blockers.length === 0 ? "captured" : "blocked";
  result.recordedAt = result.status === "captured" ? new Date().toISOString() : null;
  writeEvidence(result);
  if (result.blockers.length > 0) {
    console.error("iOS Instruments trace capture failed:");
    for (const blocker of result.blockers) console.error(`- ${blocker}`);
    process.exitCode = 1;
  } else {
    console.log(`Captured and validated ${result.traces.length} iOS Instruments traces in ${outputDirectory}.`);
    console.log("CPU/Energy baseline comparison remains a required review of the retained trace bundle.");
  }
}

function findDevice() {
  const devices = withDeviceJSON((output) => {
    execute("xcrun", ["devicectl", "list", "devices", "--json-output", output, "--quiet"]);
  }).result.devices.filter(
    (candidate) =>
      candidate.hardwareProperties?.platform === "iOS" &&
      candidate.hardwareProperties?.reality === "physical" &&
      candidate.connectionProperties?.pairingState === "paired",
  );
  const requested = process.env.GHOSTTEA_IOS_DEVICE_ID;
  if (requested) {
    const match = devices.find((item) => item.identifier === requested || item.hardwareProperties?.udid === requested);
    if (!match) throw new Error(`Connected iOS device ${requested} was not found`);
    return match;
  }
  if (devices.length !== 1) throw new Error(`Expected one connected physical iOS device, found ${devices.length}`);
  return devices[0];
}

function terminateHarness(selectedDevice) {
  const processes = withDeviceJSON((output) => {
    execute("xcrun", [
      "devicectl",
      "device",
      "info",
      "processes",
      "--device",
      selectedDevice.identifier,
      "--json-output",
      output,
      "--quiet",
    ]);
  }).result.runningProcesses;
  for (const process of processes) {
    if (!process.executable?.includes("/GhostteaHarness.app/GhostteaHarness")) continue;
    execute(
      "xcrun",
      [
        "devicectl",
        "device",
        "process",
        "terminate",
        "--device",
        selectedDevice.identifier,
        "--pid",
        String(process.processIdentifier),
      ],
      { allowFailure: true },
    );
  }
}

function requireUnlocked(selectedDevice) {
  const state = withDeviceJSON((output) => {
    execute("xcrun", [
      "devicectl",
      "device",
      "info",
      "lockState",
      "--device",
      selectedDevice.identifier,
      "--json-output",
      output,
      "--quiet",
    ]);
  }).result;
  if (state.passcodeRequired) throw new Error("Unlock the selected iOS device before Instruments capture");
}

function developmentTeam() {
  if (process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM) return process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM;
  const result = execute("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"], {
    capture: true,
    allowFailure: true,
  });
  const teams = [...new Set([...result.stdout.matchAll(/teamID = "?([A-Z0-9]+)"?;/g)].map((match) => match[1]))];
  if (teams.length !== 1) throw new Error(`Could not choose one Xcode development team (found ${teams.length})`);
  return teams[0];
}

function withDeviceJSON(operation) {
  const directory = mkdtempSync(join(tmpdir(), "ghosttea-ios-instruments-"));
  const output = join(directory, "result.json");
  try {
    operation(output);
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeEvidence(value) {
  writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hashTree(directory) {
  const entries = [];
  visit(directory);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return sha256(Buffer.from(entries.map((entry) => `${entry.path}\0${entry.hash}\n`).join("")));

  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const relativePath = relative(directory, child);
      const stat = lstatSync(child);
      if (stat.isDirectory()) visit(child);
      else if (stat.isFile()) entries.push({ path: relativePath, hash: `file:${sha256(readFileSync(child))}` });
      else if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, hash: `link:${sha256(Buffer.from(readlinkSync(child)))}` });
      } else {
        throw new Error(`Cannot hash unsupported filesystem entry ${relativePath}`);
      }
    }
  }
}

function compareMajorMinor(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)(?:\.|$)/);
    if (!match) throw new Error(`Could not parse major/minor version ${value}`);
    return [Number(match[1]), Number(match[2])];
  };
  const [leftMajor, leftMinor] = parse(left);
  const [rightMajor, rightMinor] = parse(right);
  return leftMajor === rightMajor ? leftMinor - rightMinor : leftMajor - rightMajor;
}

function listed(output, name) {
  return output.split(/\r?\n/).some((line) => line.trim() === name);
}

function firstMatch(value, pattern) {
  const match = value.match(pattern)?.[1];
  if (!match) throw new Error(`Could not parse required value with ${pattern}`);
  return match.trim();
}

function capture(program, args) {
  return execute(program, args, { capture: true }).stdout.trim();
}

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${program} ${args.join(" ")} failed with status ${result.status}${
        options.capture ? `\n${result.stdout}${result.stderr}` : ""
      }`,
    );
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
