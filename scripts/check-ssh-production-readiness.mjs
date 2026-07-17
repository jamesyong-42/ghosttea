import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(resolve(root, "native/ssh.lock.json"), "utf8"));
const status = lock.candidateStatus;
const review = lock.securityReview;

function parseLibssh2Version(tag) {
  const match = /^libssh2-(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? "");
  return match?.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const failures = [];
if (!status?.productionApproved) {
  failures.push("candidateStatus.productionApproved is false");
}
if (!review?.reviewedAt || !review?.blockedReason) {
  failures.push("the dependency lock has no dated security review");
}
const pinnedVersion = parseLibssh2Version(lock.libssh2?.tag);
const affectedThrough = parseLibssh2Version(review?.affectedThrough);
if (!pinnedVersion || !affectedThrough) {
  failures.push("the libssh2 affected range cannot be verified from the pinned tags");
} else if (compareVersions(pinnedVersion, affectedThrough) <= 0) {
  failures.push(`the pinned ${lock.libssh2.tag} release is affected through ${review.affectedThrough}`);
}
if (review?.minimumOpenSSLTag !== lock.openssl?.tag) {
  failures.push(
    `the pinned ${lock.openssl?.tag ?? "OpenSSL version"} does not match the reviewed ${review?.minimumOpenSSLTag ?? "security floor"}`,
  );
}

const requiredFixes = new Set(review?.requiredFixCommits ?? []);
const incorporatedFixes = new Set(review?.incorporatedFixCommits ?? []);
if (requiredFixes.size === 0) failures.push("the security review records no required fixes");
const missingFixes = [...requiredFixes].filter((commit) => !incorporatedFixes.has(commit));
if (missingFixes.length > 0) {
  failures.push(`security fixes are not incorporated: ${missingFixes.join(", ")}`);
}

const requiredRevalidation = new Set(review?.requiredRevalidation ?? []);
const completedRevalidation = new Set(review?.completedRevalidation ?? []);
if (requiredRevalidation.size === 0) {
  failures.push("the security review records no upgrade revalidation gates");
}
const missingRevalidation = [...requiredRevalidation].filter((gate) => !completedRevalidation.has(gate));
if (missingRevalidation.length > 0) {
  failures.push(`upgrade gates are not rerun: ${missingRevalidation.join(", ")}`);
}

if (failures.length > 0) {
  console.error("SSH production-readiness gate: BLOCKED");
  for (const failure of failures) console.error(`- ${failure}`);
  if (review?.blockedReason) console.error(`- ${review.blockedReason}`);
  process.exit(1);
}

console.log(`SSH production-readiness gate: PASSED (${lock.libssh2.tag} ${lock.libssh2.commit})`);
