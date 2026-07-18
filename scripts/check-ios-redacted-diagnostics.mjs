import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const diagnosticsPath = "apple/GhostteaKit/Sources/GhostteaDiagnostics/GhostteaDiagnostics.swift";
const diagnosticsTestsPath = "apple/GhostteaKit/Tests/GhostteaDiagnosticsTests/GhostteaDiagnosticsTests.swift";
const packagePath = "apple/GhostteaKit/Package.swift";
const projectPath = "apple/GhostteaApp/GhostteaApp.xcodeproj/project.pbxproj";
const appDirectory = resolve(root, "apple/GhostteaApp/App");
const terminalDirectory = resolve(root, "apple/GhostteaKit/Sources/GhostteaTerminal");

const diagnostics = read(diagnosticsPath);
const tests = read(diagnosticsTestsPath);
const packageManifest = read(packagePath);
const project = read(projectPath);

for (const contract of [
  "public enum GhostteaDiagnosticCode: String",
  "public let timestamp: Date",
  "public let code: GhostteaDiagnosticCode",
  "public let severity: GhostteaDiagnosticSeverity",
  "options: .atomic",
  "try handle.synchronize()",
  "FileProtectionType.complete",
  "values.isExcludedFromBackup = true",
]) {
  requireText(diagnostics, contract, diagnosticsPath);
}

const eventDefinition = between(
  diagnostics,
  "public struct GhostteaDiagnosticEvent",
  "public struct GhostteaDiagnosticSnapshot",
);
for (const forbidden of ["String", "Data", "URL", "Error", "[String"]) {
  if (eventDefinition.includes(forbidden)) {
    throw new Error(`Persisted diagnostic events must not accept ${forbidden} values.`);
  }
}

const codeDefinition = between(
  diagnostics,
  "public enum GhostteaDiagnosticCode",
  "public enum GhostteaDiagnosticSeverity",
);
if (/^\s*case\s+\w+\s*\(/m.test(codeDefinition)) {
  throw new Error("Diagnostic event codes must not carry associated values.");
}

for (const secretFixture of ["hunter2", "BEGIN OPENSSH PRIVATE KEY", "terminal output"]) {
  requireText(tests, secretFixture, diagnosticsTestsPath);
}

for (const contract of [
  '.library(name: "GhostteaDiagnostics", targets: ["GhostteaDiagnostics"])',
  '.target(name: "GhostteaDiagnostics")',
  'name: "GhostteaDiagnosticsTests"',
]) {
  requireText(packageManifest, contract, packagePath);
}
for (const contract of [
  "GhostteaDiagnostics in Frameworks",
  "GhostteaDiagnostics */",
  "productName = GhostteaDiagnostics;",
]) {
  requireText(project, contract, projectPath);
}

const forbiddenErrorText = [
  { pattern: /String\(describing:\s*error\)/, description: "String(describing: error)" },
  { pattern: /localizedDescription/, description: "localizedDescription" },
  { pattern: /\\\(error\)/, description: "raw error interpolation" },
];
for (const file of [...swiftFiles(appDirectory), ...swiftFiles(terminalDirectory)]) {
  const source = readFileSync(file, "utf8");
  for (const forbidden of forbiddenErrorText) {
    if (forbidden.pattern.test(source)) {
      throw new Error(`${file} contains ${forbidden.description}; use an audited diagnostic code.`);
    }
  }
}

console.log("Verified bounded, typed, redacted iOS diagnostics and production error surfaces.");

function swiftFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.isFile() && extname(entry.name) === ".swift" ? [path] : [];
  });
}

function between(value, start, end) {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Could not locate ${start}…${end}.`);
  return value.slice(startIndex, endIndex);
}

function requireText(value, expected, path) {
  if (!value.includes(expected)) throw new Error(`${path} omitted ${expected}.`);
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}
