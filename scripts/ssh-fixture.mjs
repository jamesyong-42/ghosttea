import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const fixtureRoot = join(root, "tests/fixtures/ssh");
const stateRoot = join(root, "native/build/ssh-fixture");
const privateKey = join(stateRoot, "client_ed25519");
const publicKey = `${privateKey}.pub`;
const encryptedPrivateKey = join(stateRoot, "client_encrypted_ed25519");
const encryptedPublicKey = `${encryptedPrivateKey}.pub`;
const wrongPrivateKey = join(stateRoot, "wrong_client_ed25519");
const wrongPublicKey = `${wrongPrivateKey}.pub`;
const authorizedKeys = join(stateRoot, "authorized_keys");
const knownHosts = join(stateRoot, "known_hosts");
const unknownKnownHosts = join(stateRoot, "unknown_known_hosts");
const changedKnownHosts = join(stateRoot, "changed_known_hosts");
const candidateProbe = join(stateRoot, "libssh2-candidate-probe");
const swiftPackage = join(root, "apple/GhostteaKit");
const swiftModuleCache = join(swiftPackage, ".build/module-cache");
const composeFile = join(fixtureRoot, "docker-compose.yml");
const projectName = "ghosttea-ssh-fixture";
const command = process.argv[2] ?? "test";
const keepRunning = process.argv.includes("--keep");
const ports = {
  password: process.env.GHOSTTEA_SSH_PASSWORD_PORT ?? "22022",
  keyboard: process.env.GHOSTTEA_SSH_KEYBOARD_PORT ?? "22023",
  partial: process.env.GHOSTTEA_SSH_PARTIAL_PORT ?? "22024",
  publicKey: process.env.GHOSTTEA_SSH_PUBLIC_KEY_PORT ?? "22025",
  blackhole: process.env.GHOSTTEA_SSH_BLACKHOLE_PORT ?? "22026",
  ecdsaAesGcm: process.env.GHOSTTEA_SSH_ECDSA_AESGCM_PORT ?? "22027",
};
const commandEnvironment = {
  ...process.env,
  GHOSTTEA_SSH_FIXTURE_PUBLIC_KEY: authorizedKeys,
  GHOSTTEA_SSH_PASSWORD_PORT: ports.password,
  GHOSTTEA_SSH_KEYBOARD_PORT: ports.keyboard,
  GHOSTTEA_SSH_PARTIAL_PORT: ports.partial,
  GHOSTTEA_SSH_PUBLIC_KEY_PORT: ports.publicKey,
  GHOSTTEA_SSH_BLACKHOLE_PORT: ports.blackhole,
  GHOSTTEA_SSH_ECDSA_AESGCM_PORT: ports.ecdsaAesGcm,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
  CLANG_MODULE_CACHE_PATH: swiftModuleCache,
  SWIFTPM_MODULECACHE_OVERRIDE: swiftModuleCache,
};

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? root,
    env: commandEnvironment,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : undefined,
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  return result;
}

function run(program, args, options = {}) {
  const result = execute(program, args, options);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${program} failed`);
  }
  return result.stdout?.trim() ?? "";
}

function compose(args, options = {}) {
  return run("docker", ["compose", "--project-name", projectName, "--file", composeFile, ...args], options);
}

function ensureClientKey() {
  mkdirSync(stateRoot, { recursive: true });
  for (const [keyPath, comment, passphrase] of [
    [privateKey, "ghosttea-ssh-fixture-only", ""],
    [encryptedPrivateKey, "ghosttea-ssh-fixture-encrypted", "ghosttea-key-passphrase"],
    [wrongPrivateKey, "ghosttea-ssh-fixture-wrong-key", ""],
  ]) {
    if (existsSync(keyPath) && existsSync(`${keyPath}.pub`)) continue;
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", comment, "-f", keyPath]);
  }
  chmodSync(privateKey, 0o600);
  chmodSync(publicKey, 0o644);
  chmodSync(encryptedPrivateKey, 0o600);
  chmodSync(encryptedPublicKey, 0o644);
  chmodSync(wrongPrivateKey, 0o600);
  chmodSync(wrongPublicKey, 0o644);
  writeFileSync(
    authorizedKeys,
    `${readFileSync(publicKey, "utf8").trim()}\n${readFileSync(encryptedPublicKey, "utf8").trim()}\n`,
    { mode: 0o600 },
  );
  chmodSync(authorizedKeys, 0o600);
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitUntilHealthy() {
  const container = compose(["ps", "--quiet", "sshd"]);
  if (!container) throw new Error("SSH fixture container was not created.");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = execute("docker", ["inspect", "--format", "{{.State.Health.Status}}", container]);
    if (status.status === 0 && status.stdout.trim() === "healthy") return;
    if (status.status === 0 && status.stdout.trim() === "unhealthy") {
      throw new Error("SSH fixture container reported unhealthy.");
    }
    pause(250);
  }
  throw new Error("SSH fixture did not become healthy within 15 seconds.");
}

function scanKnownHosts() {
  const entries = [ports.password, ports.keyboard, ports.partial, ports.publicKey, ports.ecdsaAesGcm].map((port) => {
    const result = execute("ssh-keyscan", ["-T", "5", "-p", port, "127.0.0.1"]);
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`Could not scan fixture host key on port ${port}: ${result.stderr}`);
    }
    return result.stdout.trim();
  });
  writeFileSync(knownHosts, `${entries.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(unknownKnownHosts, "", { mode: 0o600 });

  const replacementKey = entries.find((entry) => entry.includes(`]:${ports.publicKey} `));
  if (!replacementKey) {
    throw new Error("Could not prepare the changed-host-key negative fixture.");
  }
  writeFileSync(changedKnownHosts, `${replacementKey.replace(`]:${ports.publicKey} `, `]:${ports.password} `)}\n`, {
    mode: 0o600,
  });
}

function probe(mode) {
  run("/usr/bin/expect", [join(fixtureRoot, "probe.exp"), mode, "127.0.0.1", ports[mode], knownHosts, privateKey], {
    inherit: true,
  });
}

function publicKeyArguments(remoteCommand) {
  return [
    "-F",
    "/dev/null",
    "-p",
    ports.publicKey,
    "-i",
    privateKey,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "ghosttea@127.0.0.1",
    remoteCommand,
  ];
}

function verifyPublicKeyAndExitSemantics() {
  const result = execute("ssh", [
    ...publicKeyArguments("printf 'fixture-stdout\\n'; printf 'fixture-stderr\\n' >&2; exit 37"),
  ]);
  if (result.status !== 37) {
    throw new Error(`Expected remote exit status 37, received ${result.status}: ${result.stderr}`);
  }
  if (result.stdout !== "fixture-stdout\n" || result.stderr !== "fixture-stderr\n") {
    throw new Error(
      `SSH stdout/stderr mismatch: stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    );
  }
  console.log("public-key authentication preserved stdout, stderr, and exit status");
}

function verifyPtyResize() {
  run("/usr/bin/expect", [join(fixtureRoot, "pty-resize.exp"), "127.0.0.1", ports.publicKey, knownHosts, privateKey], {
    inherit: true,
  });
}

async function verifyFloodBackpressure() {
  const expectedBytes = 32 * 1024 * 1024;
  const child = spawn("ssh", publicKeyArguments(`head -c ${expectedBytes} /dev/zero`), {
    cwd: root,
    env: commandEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk));

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  if (child.exitCode !== null) {
    throw new Error("Flood producer exited while its reader was deliberately stalled.");
  }

  const rssResult = execute("ps", ["-o", "rss=", "-p", String(child.pid)]);
  if (rssResult.status !== 0) {
    child.kill();
    throw new Error(`Could not measure stalled SSH client RSS: ${rssResult.stderr}`);
  }
  const stalledRssKiB = Number.parseInt(rssResult.stdout.trim(), 10);
  if (!Number.isFinite(stalledRssKiB) || stalledRssKiB > 64 * 1024) {
    child.kill();
    throw new Error(`Stalled SSH client exceeded its 64 MiB RSS gate: ${stalledRssKiB} KiB`);
  }

  let receivedBytes = 0;
  child.stdout.on("data", (chunk) => {
    receivedBytes += chunk.length;
  });
  child.stdout.resume();

  const exitStatus = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill();
      rejectExit(new Error("Flood probe did not drain within 30 seconds."));
    }, 30_000);
    child.on("error", rejectExit);
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolveExit(status);
    });
  });
  if (exitStatus !== 0 || receivedBytes !== expectedBytes) {
    throw new Error(
      `Flood probe failed: exit=${exitStatus} bytes=${receivedBytes}/${expectedBytes} stderr=${Buffer.concat(errors).toString("utf8")}`,
    );
  }
  console.log(
    `stalled-reader flood resumed losslessly: ${receivedBytes} bytes, stalled client RSS ${stalledRssKiB} KiB`,
  );
}

function verifyPartialSuccessRequiresPublicKey() {
  const result = execute("ssh", [
    "-F",
    "/dev/null",
    "-p",
    ports.partial,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "PubkeyAuthentication=no",
    "ghosttea@127.0.0.1",
    "true",
  ]);
  if (result.status === 0) {
    throw new Error("Partial-success fixture authenticated without the required public-key step.");
  }
  console.log("partial-success fixture rejected a client without public-key authentication");
}

function up() {
  ensureClientKey();
  run("docker", ["version"]);
  compose(["up", "--build", "--detach"], { inherit: true });
  waitUntilHealthy();
  scanKnownHosts();
  console.log(
    `SSH fixtures ready: password=${ports.password}, keyboard-interactive=${ports.keyboard}, partial-success=${ports.partial}, public-key=${ports.publicKey}, banner-blackhole=${ports.blackhole}, ecdsa-aesgcm=${ports.ecdsaAesGcm}`,
  );
}

function down() {
  ensureClientKey();
  compose(["down", "--remove-orphans"], { inherit: true });
}

async function test() {
  up();
  try {
    probe("password");
    probe("keyboard");
    verifyPartialSuccessRequiresPublicKey();
    probe("partial");
    verifyPublicKeyAndExitSemantics();
    verifyPtyResize();
    await verifyFloodBackpressure();
    console.log("SSH fixture authentication and session matrix passed.");
  } finally {
    if (!keepRunning) down();
  }
}

function runCandidateMode(mode, port, candidatePublicKey = publicKey, candidatePrivateKey = privateKey) {
  return execute(candidateProbe, [mode, "127.0.0.1", port, knownHosts, candidatePublicKey, candidatePrivateKey]);
}

function candidate() {
  run("node", [join(root, "scripts/build-ssh-fixture-probe.mjs")], { inherit: true });
  up();
  try {
    for (const [mode, port] of [
      ["password", ports.password],
      ["publickey", ports.publicKey],
      ["keyboard", ports.keyboard],
    ]) {
      const result = runCandidateMode(mode, port);
      if (result.status !== 0) {
        throw new Error(
          `libssh2 ${mode} probe failed: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
        );
      }
      process.stdout.write(result.stdout);
    }

    const partial = runCandidateMode("partial", ports.partial);
    if (partial.status !== 0) {
      throw new Error(
        `libssh2 explicit partial-success sequence failed: status=${partial.status} stderr=${partial.stderr}`,
      );
    }
    if (!partial.stderr.includes("public-key step: status=-19 authenticated=0")) {
      throw new Error(`libssh2 partial-success return behavior changed: ${partial.stderr}`);
    }
    process.stdout.write(partial.stdout);
    process.stderr.write(partial.stderr);

    const wrongKey = runCandidateMode("partial", ports.partial, wrongPublicKey, wrongPrivateKey);
    if (wrongKey.status !== 20) {
      throw new Error(
        `libssh2 partial-success fixture accepted or mishandled a wrong key: status=${wrongKey.status} stderr=${wrongKey.stderr}`,
      );
    }
    console.log(
      "libssh2 chained authentication passed with explicit sequencing and rejected the wrong-key control; the public-key step remains ambiguously reported as -19.",
    );
  } finally {
    if (!keepRunning) down();
  }
}

function swiftCandidate() {
  mkdirSync(swiftModuleCache, { recursive: true });
  up();
  try {
    run("swift", ["build", "--disable-sandbox", "--package-path", swiftPackage, "--product", "GhostteaSSHLiveProbe"], {
      inherit: true,
    });
    const binaryDirectory = run("swift", [
      "build",
      "--disable-sandbox",
      "--package-path",
      swiftPackage,
      "--show-bin-path",
    ]);
    const liveProbe = join(binaryDirectory, "GhostteaSSHLiveProbe");

    for (const [mode, port, probePublicKey = publicKey, probePrivateKey = privateKey] of [
      ["password", ports.password],
      ["keyboard", ports.keyboard],
      ["partial", ports.partial],
      ["publickey", ports.publicKey],
      ["encrypted-key", ports.publicKey, encryptedPublicKey, encryptedPrivateKey],
      ["command", ports.publicKey],
      ["half-close", ports.publicKey],
      ["signal", ports.publicKey],
      ["ecdsa-aesgcm", ports.ecdsaAesGcm],
    ]) {
      const result = execute(liveProbe, [mode, "127.0.0.1", port, knownHosts, probePublicKey, probePrivateKey], {
        timeout: 60_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `Swift libssh2 ${mode} probe failed: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
        );
      }
      process.stdout.write(result.stdout);
    }

    const cancellation = execute(
      liveProbe,
      ["keyboard-cancel", "127.0.0.1", ports.keyboard, knownHosts, publicKey, privateKey],
      { timeout: 30_000 },
    );
    if (cancellation.status !== 0) {
      throw new Error(
        `Swift keyboard-interactive cancellation probe failed: status=${cancellation.status} stdout=${cancellation.stdout} stderr=${cancellation.stderr}`,
      );
    }
    process.stdout.write(cancellation.stdout);

    const wrongPassphrase = execute(
      liveProbe,
      [
        "encrypted-key-wrong-passphrase",
        "127.0.0.1",
        ports.publicKey,
        knownHosts,
        encryptedPublicKey,
        encryptedPrivateKey,
      ],
      { timeout: 30_000 },
    );
    if (wrongPassphrase.status === 0) {
      throw new Error("Swift libssh2 transport accepted an incorrect private-key passphrase.");
    }

    for (const mode of ["handshake-timeout", "handshake-cancel"]) {
      const result = execute(liveProbe, [mode, "127.0.0.1", ports.blackhole, knownHosts, publicKey, privateKey], {
        timeout: 30_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `Swift ${mode} probe failed: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
        );
      }
      process.stdout.write(result.stdout);
    }

    const wrongKey = execute(
      liveProbe,
      ["partial", "127.0.0.1", ports.partial, knownHosts, wrongPublicKey, wrongPrivateKey],
      { timeout: 30_000 },
    );
    if (wrongKey.status === 0) {
      throw new Error("Swift libssh2 partial-success transport accepted the wrong-key control.");
    }
    for (const [name, hostFile] of [
      ["unknown", unknownKnownHosts],
      ["changed", changedKnownHosts],
    ]) {
      const hostKeyResult = execute(
        liveProbe,
        ["password", "127.0.0.1", ports.password, hostFile, publicKey, privateKey],
        { timeout: 30_000 },
      );
      if (hostKeyResult.status === 0) {
        throw new Error(`Swift libssh2 transport accepted the ${name} host-key control.`);
      }
    }
    console.log(
      "Swift nonblocking transport passed authentication including encrypted keys, strict host-key negatives, PTY resize, command streams/exit signal, half-close, lossless stalled-reader flow control, handshake timeout/cancellation, cancellation, wrong-passphrase rejection, and wrong-key rejection.",
    );
  } finally {
    if (!keepRunning) down();
  }
}

if (command === "up") up();
else if (command === "down") down();
else if (command === "test") await test();
else if (command === "candidate") candidate();
else if (command === "swift") swiftCandidate();
else throw new Error(`Unknown SSH fixture command: ${command}`);
