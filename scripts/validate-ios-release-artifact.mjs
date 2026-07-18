import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };
const archive = resolve(argument("--archive") ?? "native/build/ios-app/archive/Ghosttea.xcarchive");
const ipaArgument = argument("--ipa");
const ipa = ipaArgument ? resolve(ipaArgument) : undefined;
const requireEligible = process.argv.includes("--release");
const output = resolve(argument("--output") ?? "native/build/ios-app/archive/Ghosttea.release-evidence.json");
const archiveInfo = join(archive, "Info.plist");
const applicationPath = plist(archiveInfo, "ApplicationProperties:ApplicationPath");
if (applicationPath !== "Applications/Ghosttea.app") {
  throw new Error(`Unexpected archive application path ${applicationPath}.`);
}
const archiveApp = join(archive, "Products", applicationPath);
const archiveDSYM = join(archive, "dSYMs/Ghosttea.app.dSYM");
requirePath(archive, "archive");
requirePath(archiveInfo, "archive metadata");
requirePath(archiveApp, "archived application");
requirePath(archiveDSYM, "application dSYM");

const source = sourceIdentity();
const resourceLock = readJSON("apple/GhostteaKit/Compatibility/ios-release-resources.lock.json");
const sshLock = readJSON("native/ssh.lock.json");
const archiveEvidence = inspectArchive(archiveApp, archiveDSYM);
let ipaEvidence;
if (ipa) ipaEvidence = inspectIPA(ipa);
if (ipaEvidence) {
  for (const key of ["bundleIdentifier", "version", "build", "minimumOSVersion"]) {
    if (ipaEvidence.application[key] !== archiveEvidence.application[key]) {
      throw new Error(
        `IPA ${key} does not match archive: ${ipaEvidence.application[key]} != ${archiveEvidence.application[key]}.`,
      );
    }
  }
  if (
    ipaEvidence.application.resources.cycloneDXSha256 !== archiveEvidence.application.resources.cycloneDXSha256 ||
    ipaEvidence.application.resources.noticesSha256 !== archiveEvidence.application.resources.noticesSha256
  ) {
    throw new Error("IPA release resources do not match the archive.");
  }
  if (
    JSON.stringify(ipaEvidence.application.architectures) !==
      JSON.stringify(archiveEvidence.application.architectures) ||
    JSON.stringify(ipaEvidence.application.executable.uuids) !==
      JSON.stringify(archiveEvidence.application.executable.uuids)
  ) {
    throw new Error("IPA executable architecture or UUID does not match the archive.");
  }
}

const policyBlockers = [];
if (!source.clean) policyBlockers.push("source worktree is not clean");
if (!ipaEvidence) policyBlockers.push("exported IPA was not supplied");
if (ipaEvidence && ipaEvidence.application.signature.signingClass !== "apple-distribution") {
  policyBlockers.push("IPA is not signed with an Apple Distribution certificate");
}
if (ipaEvidence?.application.signature.entitlements.getTaskAllow) {
  policyBlockers.push("IPA signature permits debugger attachment");
}
for (const [kind, application] of [
  ["archive", archiveEvidence.application],
  ...(ipaEvidence ? [["IPA", ipaEvidence.application]] : []),
]) {
  if (application.signature.verification !== "valid") {
    policyBlockers.push(`${kind} signature certificate chain is not trusted on this verification host`);
  }
}
if (!sshLock.candidateStatus.productionApproved) {
  policyBlockers.push(sshLock.securityReview.blockedReason);
}
const evidence = {
  schemaVersion: 1,
  subject: {
    bundleIdentifier: archiveEvidence.application.bundleIdentifier,
    version: archiveEvidence.application.version,
    build: archiveEvidence.application.build,
  },
  source,
  locks: {
    cycloneDXSha256: resourceLock.sourceBom.sha256,
    noticesSha256: resourceLock.notices.sha256,
    releaseResourcesSha256: hashFile(resolve(root, "apple/GhostteaKit/Compatibility/ios-release-resources.lock.json")),
    toolchainSha256: hashFile(resolve(root, "apple/GhostteaKit/Compatibility/ios-toolchain.lock.json")),
  },
  archive: archiveEvidence,
  ...(ipaEvidence ? { ipa: ipaEvidence } : {}),
  policy: {
    eligible: policyBlockers.length === 0,
    blockers: policyBlockers,
  },
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Verified iOS release artifact and wrote evidence: ${output}`);
console.log(`Archive ${archiveEvidence.contentTree.sha256} · app ${archiveEvidence.application.executable.sha256}`);
if (ipaEvidence) console.log(`IPA ${ipaEvidence.file.sha256}`);
if (!evidence.policy.eligible) {
  console.log(`Release policy remains blocked: ${policyBlockers.join("; ")}`);
}
if (requireEligible && !evidence.policy.eligible) {
  throw new Error("iOS release artifact is not eligible; see the evidence policy blockers above.");
}

function inspectArchive(app, dSYM) {
  const application = inspectApplication(app);
  execute("node", ["scripts/check-ios-release-resources.mjs", "--app-bundle", app]);
  const executableUUIDs = machoUUIDs(join(app, "Ghosttea"));
  const dSYMUUIDs = machoUUIDs(dSYM);
  if (JSON.stringify(executableUUIDs) !== JSON.stringify(dSYMUUIDs)) {
    throw new Error(
      `dSYM UUIDs do not match executable: app=${executableUUIDs.join(",")}, dSYM=${dSYMUUIDs.join(",")}.`,
    );
  }
  return {
    kind: "xcarchive",
    name: basename(archive),
    contentTree: contentTree(archive),
    metadata: {
      sha256: hashFile(archiveInfo),
      signingIdentity: plist(archiveInfo, "ApplicationProperties:SigningIdentity"),
    },
    application,
    dSYM: {
      uuids: dSYMUUIDs,
      contentTree: contentTree(dSYM),
    },
  };
}

function inspectIPA(path) {
  requirePath(path, "exported IPA");
  const entries = execute("unzip", ["-Z1", path], { capture: true }).stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const segments = entry.split("/");
    if (entry.startsWith("/") || segments.includes("..")) {
      throw new Error(`IPA contains unsafe path ${entry}.`);
    }
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ghosttea-ipa-"));
  try {
    execute("ditto", ["-x", "-k", path, temporaryDirectory]);
    const payload = join(temporaryDirectory, "Payload");
    requirePath(payload, "IPA Payload directory");
    const applications = readdirSync(payload)
      .filter((name) => name.endsWith(".app"))
      .map((name) => join(payload, name));
    if (applications.length !== 1) {
      throw new Error(`Expected one IPA application, found ${applications.length}.`);
    }
    const application = inspectApplication(applications[0]);
    execute("node", ["scripts/check-ios-release-resources.mjs", "--app-bundle", applications[0]]);
    return {
      kind: "ipa",
      name: basename(path),
      file: { size: lstatSync(path).size, sha256: hashFile(path) },
      payloadEntryCount: entries.length,
      application,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function inspectApplication(app) {
  requirePath(app, "application bundle");
  const info = join(app, "Info.plist");
  const executable = join(app, "Ghosttea");
  requirePath(info, "application Info.plist");
  requirePath(executable, "application executable");
  const verification = verifyCodeSignature(app);
  const signatureText = execute("codesign", ["-d", "--verbose=4", app], { capture: true }).combined;
  const entitlementsText = execute("codesign", ["-d", "--entitlements", "-", app], { capture: true }).stdout;
  const signature = {
    identifier: signatureValue(signatureText, "Identifier"),
    teamIdentifier: signatureValue(signatureText, "TeamIdentifier"),
    authorities: signatureValues(signatureText, "Authority"),
    signingClass: signatureSigningClass(signatureText),
    cdHash: signatureValue(signatureText, "CDHash"),
    cdHashFull: signatureValue(signatureText, "CandidateCDHashFull sha256"),
    entitlements: {
      applicationIdentifier: entitlementValue(entitlementsText, "application-identifier", "String"),
      teamIdentifier: entitlementValue(entitlementsText, "com.apple.developer.team-identifier", "String"),
      getTaskAllow: entitlementValue(entitlementsText, "get-task-allow", "Bool") === "true",
      sha256: sha256(entitlementsText),
    },
    verification,
  };
  const bundleIdentifier = plist(info, "CFBundleIdentifier");
  if (bundleIdentifier !== "com.vibecook.Ghosttea" || signature.identifier !== bundleIdentifier) {
    throw new Error(`Application identity mismatch: plist=${bundleIdentifier}, signature=${signature.identifier}.`);
  }
  if (
    signature.entitlements.applicationIdentifier !== `${signature.teamIdentifier}.${bundleIdentifier}` ||
    signature.entitlements.teamIdentifier !== signature.teamIdentifier
  ) {
    throw new Error("Application entitlements do not match the signed team and bundle identity.");
  }
  const architectures = execute("lipo", ["-archs", executable], {
    capture: true,
  })
    .stdout.trim()
    .split(/\s+/)
    .sort();
  if (!architectures.includes("arm64")) {
    throw new Error(`Application does not contain arm64: ${architectures.join(", ")}.`);
  }
  return {
    bundleIdentifier,
    version: plist(info, "CFBundleShortVersionString"),
    build: plist(info, "CFBundleVersion"),
    minimumOSVersion: plist(info, "MinimumOSVersion"),
    architectures,
    contentTree: contentTree(app),
    infoPlistSha256: hashFile(info),
    executable: {
      size: lstatSync(executable).size,
      sha256: hashFile(executable),
      uuids: machoUUIDs(executable),
    },
    signature,
    resources: {
      cycloneDXSha256: hashFile(join(app, "Ghosttea-iOS.cdx.json")),
      noticesSha256: hashFile(join(app, "THIRD-PARTY-NOTICES.txt")),
    },
    provisioningProfileSha256: existsSync(join(app, "embedded.mobileprovision"))
      ? hashFile(join(app, "embedded.mobileprovision"))
      : null,
  };
}

function verifyCodeSignature(app) {
  const result = spawnSync("codesign", ["--verify", "--deep", "--strict", app], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return "valid";
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (combined.includes("CSSMERR_TP_NOT_TRUSTED")) return "certificate-chain-not-trusted";
  throw new Error(`codesign verification failed with status ${result.status}\n${combined}`);
}

function contentTree(directory) {
  const records = [];
  walk(directory, directory, records);
  const serialized = `${records.join("\n")}\n`;
  return {
    entryCount: records.length,
    sha256: sha256(serialized),
  };
}

function walk(base, path, records) {
  for (const name of readdirSync(path).sort()) {
    const entry = join(path, name);
    const relativePath = relative(base, entry).split(sep).join("/");
    const status = lstatSync(entry);
    if (status.isSymbolicLink()) {
      records.push(`link\0${relativePath}\0${readlinkSync(entry)}`);
    } else if (status.isDirectory()) {
      records.push(`dir\0${relativePath}`);
      walk(base, entry, records);
    } else if (status.isFile()) {
      records.push(`file\0${relativePath}\0${status.size}\0${hashFile(entry)}`);
    }
  }
}

function machoUUIDs(path) {
  return [
    ...execute("dwarfdump", ["--uuid", path], { capture: true }).stdout.matchAll(/^UUID: ([0-9A-F-]+) \(([^)]+)\)/gm),
  ]
    .map((match) => `${match[2]}:${match[1]}`)
    .sort();
}

function sourceIdentity() {
  const revision = execute("git", ["rev-parse", "HEAD"], {
    capture: true,
  }).stdout.trim();
  const status = execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], { capture: true }).stdout;
  return {
    repository: "https://github.com/jamesyong-42/ghosttea",
    revision,
    clean: status.length === 0,
  };
}

function signatureValue(output, name) {
  const match = output.match(new RegExp(`^${escapeRegExp(name)}=(.+)$`, "m"));
  if (!match) throw new Error(`Code signature omitted ${name}.`);
  return match[1].trim();
}

function signatureValues(output, name) {
  return [...output.matchAll(new RegExp(`^${escapeRegExp(name)}=(.+)$`, "gm"))].map((match) => match[1].trim());
}

function signatureSigningClass(output) {
  const authorities = signatureValues(output, "Authority");
  if (authorities.includes("(unavailable)")) return "unavailable";
  if (authorities.some((authority) => /^(Apple|iPhone) Distribution:/.test(authority))) {
    return "apple-distribution";
  }
  if (authorities.some((authority) => /^(Apple|iPhone) Development:/.test(authority))) {
    return "apple-development";
  }
  return "other";
}

function entitlementValue(output, key, type) {
  const match = output.match(
    new RegExp(`\\[Key\\] ${escapeRegExp(key)}\\s+\\[Value\\]\\s+\\[${escapeRegExp(type)}\\] ([^\\r\\n]+)`),
  );
  return match?.[1].trim() ?? null;
}

function plist(path, key) {
  return execute("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path], {
    capture: true,
  }).stdout.trim();
}

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed with status ${result.status}${options.capture ? `\n${combined}` : ""}`,
    );
  }
  return { ...result, combined };
}

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`Missing ${description}: ${path}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function readJSON(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function hashFile(path) {
  return sha256(readFileSync(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
