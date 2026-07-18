import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const lockPath = resolve(root, "apple/GhostteaKit/Compatibility/ios-app-store.lock.json");
const truffleLockPath = resolve(root, "apple/GhostteaKit/Compatibility/truffle-swift.lock.json");
const projectPath = resolve(root, "apple/GhostteaApp/GhostteaApp.xcodeproj/project.pbxproj");
const siblingRoot = resolve(root, "../p008/truffle");
const lock = readJSON(lockPath);
const truffleLock = readJSON(truffleLockPath);
const appManifest = resolve(root, lock.privacy.appManifest.path);
const tailscaleManifest = resolve(root, lock.privacy.tailscaleKitManifest.path);
const project = readFileSync(projectPath, "utf8");

requireHash(appManifest, lock.privacy.appManifest.sha256, "application privacy manifest");
requireHash(tailscaleManifest, lock.privacy.tailscaleKitManifest.sha256, "TailscaleKit privacy manifest");
requireHash(
  tailscaleManifest,
  truffleLock.tailscaleKit.privacyManifest.sha256,
  "TailscaleKit privacy manifest from the Truffle lock",
);
requireTextCount(project, "PrivacyInfo.xcprivacy", 6, "application privacy resource references");
requireTextCount(
  project,
  "INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = YES;",
  2,
  "Debug and Release encryption declarations",
);

verifyLocalTruffleCheckout();

const appBundleArgument = argument("--app-bundle");
if (appBundleArgument) verifyAppBundle(resolve(appBundleArgument));

const blockers = policyBlockers();
console.log(
  `Verified iOS App Store readiness inputs: ${basename(appManifest)}, ${basename(tailscaleManifest)}, ${blockers.length} release blocker(s).`,
);
if (process.argv.includes("--release") && blockers.length > 0) {
  console.error("iOS App Store release blocked:");
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exitCode = 1;
}

function verifyLocalTruffleCheckout() {
  if (!existsSync(join(siblingRoot, ".git"))) return;
  const revision = execute("git", ["-C", siblingRoot, "rev-parse", "HEAD"]).stdout.trim();
  if (revision !== truffleLock.package.revision) {
    throw new Error(`Truffle checkout revision ${revision} does not match lock ${truffleLock.package.revision}.`);
  }
  const siblingManifest = resolve(siblingRoot, truffleLock.tailscaleKit.privacyManifest.path);
  requireHash(
    siblingManifest,
    truffleLock.tailscaleKit.privacyManifest.sha256,
    "sibling TailscaleKit privacy manifest",
  );
  if (!readFileSync(siblingManifest).equals(readFileSync(tailscaleManifest))) {
    throw new Error("Sibling and compatibility-copy TailscaleKit privacy manifests differ.");
  }
  const materializer = readFileSync(resolve(siblingRoot, "apple/scripts/materialize-tailscalekit.sh"), "utf8");
  for (const contract of [
    "TailscaleKit-PrivacyInfo.xcprivacy",
    'cp "$PRIVACY_MANIFEST" "$framework/PrivacyInfo.xcprivacy"',
    '[[ "$framework_count" -ne 2 ]]',
  ]) {
    if (!materializer.includes(contract)) throw new Error(`TailscaleKit materializer omitted ${contract}.`);
  }
}

function verifyAppBundle(appBundle) {
  requirePath(appBundle, "application bundle");
  const bundledAppManifest = join(appBundle, "PrivacyInfo.xcprivacy");
  const bundledTailscaleManifest = join(appBundle, "Frameworks/TailscaleKit.framework/PrivacyInfo.xcprivacy");
  requirePlistIdentity(bundledAppManifest, appManifest, "application privacy manifest");
  requirePlistIdentity(bundledTailscaleManifest, tailscaleManifest, "TailscaleKit privacy manifest");
  if (plist(join(appBundle, "Info.plist"), "ITSAppUsesNonExemptEncryption") !== "true") {
    throw new Error("Application bundle does not declare ITSAppUsesNonExemptEncryption=true.");
  }
  verifyRequiredReasonSymbols(
    join(appBundle, "Ghosttea"),
    lock.privacy.appManifest.requiredReasonSymbols,
    "application executable",
  );
  verifyRequiredReasonSymbols(
    join(appBundle, "Frameworks/TailscaleKit.framework/TailscaleKit"),
    lock.privacy.tailscaleKitManifest.requiredReasonSymbols,
    "TailscaleKit executable",
  );
}

function verifyRequiredReasonSymbols(executable, expected, description) {
  requirePath(executable, description);
  const requiredReasonPattern =
    /^_(?:f?stat|f?statat|lstat|f?statvfs|f?statfs|getattrlist|fgetattrlist|getattrlistat|getattrlistbulk|mach_absolute_time)$/;
  const actual = execute("nm", ["-u", executable])
    .stdout.split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter((symbol) => symbol && requiredReasonPattern.test(symbol))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${description} required-reason symbols changed: ${actual.join(", ")}.`);
  }
}

function policyBlockers() {
  const blockers = [];
  if (!lock.privacy.dataCollectionReview.approved || !lock.privacy.dataCollectionReview.privacyPolicyURL) {
    blockers.push(lock.privacy.dataCollectionReview.blockedReason);
  }
  if (!lock.exportCompliance.approved) blockers.push(lock.exportCompliance.blockedReason);
  if (!lock.appReview.notesApproved || !lock.appReview.reviewAccessPrepared) {
    blockers.push(lock.appReview.blockedReason);
  }
  return blockers;
}

function requireTextCount(value, needle, expected, description) {
  const count = value.split(needle).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} ${description}, found ${count}.`);
}

function requireHash(path, expected, description) {
  requirePath(path, description);
  const actual = sha256(readFileSync(path));
  if (actual !== expected) throw new Error(`${description} hash ${actual} does not match lock ${expected}.`);
}

function requirePlistIdentity(actual, expected, description) {
  requirePath(actual, `bundled ${description}`);
  const canonical = (path) => execute("plutil", ["-convert", "json", "-o", "-", path]).stdout.trim();
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`Bundled ${description} is not semantically equal to the reviewed source.`);
  }
}

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`Missing ${description}: ${path}`);
}

function plist(path, key) {
  return execute("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path]).stdout.trim();
}

function execute(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed with status ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
