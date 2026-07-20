#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareReports, validateComparableReports } from "./lib/compare.mjs";

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (positional.length !== 2) {
  console.error("Usage: node bench/truffle/compare.mjs baseline.json candidate.json [--noise=3] [--json=path]");
  process.exit(1);
}

const baselinePath = resolve(positional[0]);
const candidatePath = resolve(positional[1]);
const noise = Number(option("noise", "3"));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
const issues = validateComparableReports(baseline, candidate);
if (issues.length > 0) {
  console.error("Reports are not a trustworthy head-to-head comparison:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

const comparisons = compareReports(baseline, candidate, noise);
console.log(`Truffle replication comparison (${noise}% practical threshold)`);
console.log(`baseline:  ${baselinePath}`);
console.log(`candidate: ${candidatePath}\n`);
for (const caseName of [...new Set(comparisons.map((comparison) => comparison.caseName))]) {
  console.log(caseName);
  for (const comparison of comparisons.filter((value) => value.caseName === caseName)) {
    const delta =
      comparison.deltaPercent == null
        ? "n/a"
        : `${comparison.deltaPercent >= 0 ? "+" : ""}${comparison.deltaPercent.toFixed(1)}%`;
    const interval = comparison.confidenceInterval95.every((value) => value != null)
      ? `[${comparison.confidenceInterval95[0].toFixed(1)}%, ${comparison.confidenceInterval95[1].toFixed(1)}%]`
      : "[n/a]";
    console.log(
      `  ${comparison.assessment.padEnd(12)} ${comparison.label.padEnd(24)} ${comparison.baselineMedian.toFixed(2).padStart(10)} → ${comparison.candidateMedian.toFixed(2).padStart(10)}  ${delta.padStart(8)}  95% ${interval}`,
    );
  }
  console.log("");
}

const output = option("json", "");
if (output) {
  writeFileSync(
    resolve(output),
    `${JSON.stringify({ baseline: baselinePath, candidate: candidatePath, noiseThresholdPercent: noise, comparisons }, null, 2)}\n`,
  );
}
