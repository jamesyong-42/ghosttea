import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const developerDirectory = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const project = join(root, "apple/GhostteaApp/GhostteaApp.xcodeproj");
const outputRoot = join(root, "native/build/ios-app/archive");
const archive = join(outputRoot, "Ghosttea.xcarchive");
const app = join(archive, "Products/Applications/Ghosttea.app");
const executable = join(app, "Ghosttea");
const dSYM = join(archive, "dSYMs/Ghosttea.app.dSYM");
const tailscaleArtifact = resolve(root, "../p008/truffle/apple/Vendor/TailscaleKit.xcframework");
const environment = { ...process.env, DEVELOPER_DIR: developerDirectory };

function execute(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
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

function developmentTeam() {
  if (process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM) return process.env.GHOSTTEA_IOS_DEVELOPMENT_TEAM;
  const result = execute("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"], {
    capture: true,
    allowFailure: true,
  });
  const teams = [...new Set([...result.stdout.matchAll(/teamID = "?([A-Z0-9]+)"?;/g)].map((match) => match[1]))];
  if (teams.length === 1) return teams[0];
  throw new Error(
    `Could not choose one Xcode development team (found ${teams.length}). Set GHOSTTEA_IOS_DEVELOPMENT_TEAM.`,
  );
}

function plist(path, key) {
  return execute("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path], {
    capture: true,
  }).stdout.trim();
}

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`Archive is missing ${description}: ${path}`);
}

function main() {
  if (!existsSync(tailscaleArtifact)) {
    throw new Error(`Missing ${tailscaleArtifact}; run p008/truffle/apple/scripts/materialize-tailscalekit.sh first.`);
  }

  execute("node", ["scripts/check-ios-release-bom.mjs"]);
  execute("node", ["scripts/check-ios-release-resources.mjs"]);
  execute("node", ["scripts/check-ios-release-toolchain.mjs"]);

  const team = developmentTeam();
  rmSync(archive, { recursive: true, force: true });
  execute("xcodebuild", [
    "-project",
    project,
    "-scheme",
    "Ghosttea",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archive,
    "-allowProvisioningUpdates",
    `DEVELOPMENT_TEAM=${team}`,
    "CODE_SIGN_STYLE=Automatic",
    "archive",
  ]);

  requirePath(join(archive, "Info.plist"), "archive metadata");
  requirePath(app, "application");
  requirePath(executable, "application executable");
  requirePath(dSYM, "application dSYM");
  execute("node", ["scripts/check-ios-release-resources.mjs", "--app-bundle", app]);

  const archiveBundleID = plist(join(archive, "Info.plist"), "ApplicationProperties:CFBundleIdentifier");
  const appBundleID = plist(join(app, "Info.plist"), "CFBundleIdentifier");
  const applicationPath = plist(join(archive, "Info.plist"), "ApplicationProperties:ApplicationPath");
  const signingIdentity = plist(join(archive, "Info.plist"), "ApplicationProperties:SigningIdentity");
  const architectures = execute("lipo", ["-archs", executable], { capture: true }).stdout.trim().split(/\s+/);
  const signature = execute("codesign", ["-d", "--verbose=4", app], {
    capture: true,
  });
  const signatureText = `${signature.stdout}\n${signature.stderr}`;

  if (archiveBundleID !== "com.vibecook.Ghosttea" || appBundleID !== archiveBundleID) {
    throw new Error(`Unexpected archive bundle ID: archive=${archiveBundleID}, app=${appBundleID}`);
  }
  if (applicationPath !== "Applications/Ghosttea.app") {
    throw new Error(`Unexpected archive application path: ${applicationPath}`);
  }
  if (!architectures.includes("arm64")) {
    throw new Error(`Archive executable does not contain arm64: ${architectures.join(", ")}`);
  }
  if (!signingIdentity || !signatureText.includes(`TeamIdentifier=${team}`)) {
    throw new Error(`Archive signature does not identify configured team ${team}.`);
  }

  const metadata = readFileSync(join(archive, "Info.plist"));
  if (metadata.length === 0) throw new Error("Archive metadata is empty.");
  console.log(`Verified release archive: ${archive}`);
  console.log(`Bundle ${archiveBundleID} · ${architectures.join("+")} · ${signingIdentity}`);
}

main();
