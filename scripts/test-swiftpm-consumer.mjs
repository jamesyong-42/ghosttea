import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const repository = "https://github.com/vibecook-dev/ghosttea.git";
const args = process.argv.slice(2);
const localArtifact = args.length === 1 && args[0] === "--local-artifact";
const version = args.length === 2 && args[0] === "--version" ? args[1] : undefined;

if (args.length > 0 && !localArtifact && !version) {
  throw new Error(`Unknown argument. Usage: ${process.argv[1]} [--local-artifact | --version X.Y.Z]`);
}
if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`--version must be a stable semantic version, received ${JSON.stringify(version)}.`);
}

const temporary = mkdtempSync(join(tmpdir(), "ghosttea-swiftpm-consumer-"));
const sourceDirectory = join(temporary, "Sources/GhostteaConsumer");
const moduleCache = join(temporary, "module-cache");
const environment = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: moduleCache,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
  GIT_TERMINAL_PROMPT: "0",
  SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
};
mkdirSync(sourceDirectory, { recursive: true });
mkdirSync(moduleCache, { recursive: true });

try {
  const manifestPath = localArtifact ? join(root, "apple/GhostteaKit") : root;
  const manifest = JSON.parse(
    executeSwift(["package", "--disable-sandbox", "--package-path", manifestPath, "dump-package"], {
      capture: true,
    }),
  );
  const libraryProducts = manifest.products.filter((product) => product.type?.library);
  if (libraryProducts.length === 0) throw new Error("The Ghosttea package exposes no library products.");
  const products = libraryProducts.map((product) => product.name);
  const modules = [...new Set(libraryProducts.flatMap((product) => product.targets))].sort();
  const dependency = version
    ? `.package(url: ${JSON.stringify(repository)}, exact: ${JSON.stringify(version)})`
    : `.package(name: "ghosttea", path: ${JSON.stringify(manifestPath)})`;

  writeFileSync(
    join(temporary, "Package.swift"),
    [
      "// swift-tools-version: 6.1",
      "import PackageDescription",
      "",
      "let package = Package(",
      '  name: "GhostteaConsumer",',
      "  platforms: [.macOS(.v14)],",
      `  dependencies: [${dependency}],`,
      "  targets: [",
      "    .executableTarget(",
      '      name: "GhostteaConsumer",',
      "      dependencies: [",
      ...products.map((product) => `        .product(name: "${product}", package: "ghosttea"),`),
      "      ]",
      "    )",
      "  ]",
      ")",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(sourceDirectory, "main.swift"),
    [
      ...modules.map((module) => `import ${module}`),
      "",
      'print("Ghosttea SwiftPM all-products consumer linked successfully.")',
      "",
    ].join("\n"),
  );

  executeSwift([
    "build",
    "--disable-sandbox",
    "--package-path",
    temporary,
    "--scratch-path",
    join(temporary, ".build"),
  ]);
  console.log(
    version
      ? `Exact remote SwiftPM release ${version} linked all ${products.length} public library products.`
      : `${localArtifact ? "Local-artifact" : "root-manifest"} SwiftPM consumer linked all ${
          products.length
        } public library products.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function executeSwift(swiftArguments, options = {}) {
  const result = spawnSync("swift", swiftArguments, {
    cwd: root,
    env: environment,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      options.capture
        ? `swift ${swiftArguments.join(" ")} failed:\n${result.stdout}${result.stderr}`
        : `swift ${swiftArguments.join(" ")} failed with status ${result.status ?? 1}.`,
    );
  }
  return options.capture ? result.stdout : "";
}
