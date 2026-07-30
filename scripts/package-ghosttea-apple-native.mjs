// Packages the composed Apple native xcframework as the release asset that
// GhostteaKit's URL binary target resolves.
//
// The archive is written by hand rather than by `ditto` or `zip` so its framing
// is fixed: sorted entries, a constant timestamp, and normalised modes. Two runs
// over the same artifact tree on the same Node then produce the same bytes, and
// the SHA-256 recorded here is the checksum SwiftPM will enforce.
//
// Reproducibility is best effort at the compression layer — DEFLATE output is a
// property of zlib, not of the format — so the published bytes stay
// authoritative, exactly as they are for the non-reproducible Windows native
// build in .github/workflows/ghostty-vt-artifact.yml. `contentDigest` is the
// part that is reproducible anywhere, and the drift check leans on it.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  archiveName,
  binaryTargetName,
  bundleName,
  collectEntries,
  contentDigest,
  nativeSourceDigest,
  downloadUrl,
  outputDirectory,
  releaseTag,
  sha256,
  sliceDigests,
  sourceArtifact,
  stableJson,
} from "./ghosttea-apple-native-artifact.mjs";

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

// zlib.crc32 landed in Node 22.2, and package.json only requires >=22.
const crc32 =
  typeof zlib.crc32 === "function"
    ? (contents) => zlib.crc32(contents) >>> 0
    : (contents) => {
        let crc = 0xffffffff;
        for (const byte of contents) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
      };

// 1980-01-01 00:00:00, the earliest the DOS timestamp in a zip can express.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const MADE_BY_UNIX = (3 << 8) | 20;
const EXTRACT_VERSION = 20;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

if (!existsSync(sourceArtifact)) {
  throw new Error(
    `Missing ${sourceArtifact}. Build it first: \`npm run build:ghosttea-core:apple\` then the compose step in \`npm run test:ghostty-vt:apple\`.`,
  );
}

const entries = collectEntries();
const digest = contentDigest(entries);
const tag = releaseTag(digest);

const localChunks = [];
const centralChunks = [];
let offset = 0;
let entryCount = 0;

for (const entry of entries) {
  const name = Buffer.from(entry.path, "utf8");
  const isDirectory = entry.kind === "directory";
  const raw = isDirectory ? Buffer.alloc(0) : entry.contents;

  // Storing is only a win when deflate cannot shrink the entry; keeping the
  // smaller of the two also keeps already-compressed payloads from growing.
  const deflated = isDirectory ? Buffer.alloc(0) : zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = !isDirectory && deflated.length < raw.length;
  const payload = useDeflate ? deflated : raw;
  const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
  const crc = isDirectory ? 0 : crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(EXTRACT_VERSION, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  localChunks.push(local, name, payload);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(MADE_BY_UNIX, 4);
  central.writeUInt16LE(EXTRACT_VERSION, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  const unixMode = (isDirectory ? 0o040000 : 0o100000) | entry.mode;
  // The `>>>` has to come last: `|` is an int32 operator, so coercing before it
  // lets the high mode bit sign-extend straight back into a negative number.
  central.writeUInt32LE(((unixMode << 16) | (isDirectory ? 0x10 : 0)) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  centralChunks.push(central, name);

  offset += local.length + name.length + payload.length;
  entryCount += 1;
}

const centralDirectory = Buffer.concat(centralChunks);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entryCount, 8);
end.writeUInt16LE(entryCount, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const archive = Buffer.concat([...localChunks, centralDirectory, end]);
if (offset > 0xffffffff || archive.length > 0xffffffff || entryCount > 0xffff) {
  throw new Error("The artifact outgrew zip32; the writer needs ZIP64 records.");
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, archiveName), archive);

const result = {
  schemaVersion: 1,
  binaryTarget: binaryTargetName,
  bundleName,
  tag,
  filename: archiveName,
  url: downloadUrl(tag),
  // SwiftPM's `swift package compute-checksum` is the SHA-256 of the archive
  // file, so this one value is both the integrity record and the manifest pin.
  checksum: sha256(archive),
  size: archive.length,
  contentDigest: digest,
  // What the artifact was built *from*. The digests above cannot establish this:
  // computed from a stale build they agree with a lock written from that same
  // stale build. Recording it lets the check ask whether the published artifact
  // predates the sources being shipped.
  sourceDigest: nativeSourceDigest(),
  entries: entryCount,
  slices: sliceDigests(entries),
};
writeFileSync(join(outputDirectory, `${archiveName}.json`), stableJson(result));
console.log(stableJson(result));
