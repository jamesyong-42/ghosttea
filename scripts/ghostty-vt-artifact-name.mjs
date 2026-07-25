/**
 * Print what a build of the requested target produces, for workflow steps that
 * have to locate a bundle before its manifest entry is locked.
 *
 * `--release` prints the release tag instead of the bundle filename.
 */
import { artifactNames, resolveTarget } from "./ghostty-vt-target.mjs";

const names = artifactNames(resolveTarget());
process.stdout.write(process.argv.includes("--release") ? names.release : names.filename);
