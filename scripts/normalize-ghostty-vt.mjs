import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const library = resolve(process.argv[2] ?? `${root}/native/build/ghostty/install/lib/libghostty-vt.a`);

if (process.platform !== "darwin") {
  throw new Error("Ghostty VT release archives must be normalized on macOS with Apple strip.");
}
if (!existsSync(library)) throw new Error(`Ghostty VT archive does not exist: ${library}`);

const strip = spawnSync("/usr/bin/strip", ["-S", library], { stdio: "inherit" });
if (strip.error) throw strip.error;
if (strip.status !== 0) process.exit(strip.status ?? 1);

const archive = readFileSync(library);
if (archive.subarray(0, 8).toString("ascii") !== "!<arch>\n") {
  throw new Error(`Ghostty VT output is not a static archive: ${library}`);
}

function replaceField(headerOffset, fieldOffset, length, value) {
  archive.fill(0x20, headerOffset + fieldOffset, headerOffset + fieldOffset + length);
  archive.write(value, headerOffset + fieldOffset, length, "ascii");
}

let offset = 8;
while (offset < archive.length) {
  const headerEnd = offset + 60;
  if (headerEnd > archive.length || archive.subarray(offset + 58, headerEnd).toString("ascii") !== "`\n") {
    throw new Error(`Malformed static archive member at byte ${offset}: ${library}`);
  }

  const size = Number.parseInt(
    archive
      .subarray(offset + 48, offset + 58)
      .toString("ascii")
      .trim(),
    10,
  );
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Invalid static archive member size at byte ${offset}: ${library}`);
  }

  replaceField(offset, 16, 12, "0");
  replaceField(offset, 28, 6, "0");
  replaceField(offset, 34, 6, "0");
  replaceField(offset, 40, 8, "100644");
  offset = headerEnd + size + (size % 2);
}

if (offset !== archive.length) throw new Error(`Malformed static archive length: ${library}`);
writeFileSync(library, archive);
console.log(`${createHash("sha256").update(archive).digest("hex")}  ${library}`);
