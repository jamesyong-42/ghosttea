#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_ROUTED_PROTOCOL_LIMITS,
  ROUTED_MESSAGE_TYPES,
  canonicalRoutedJson,
  decodeRoutedMessage,
  decodeRoutedPresentationEnvelope,
  encodeRoutedMessage,
  encodeRoutedPresentationEnvelope,
  isRoutedCellTransportGrant,
  isRoutedProtocolLimits,
  isRoutedSessionAttachGrant,
  isRoutedTerminalOpenTicket,
  routedGrantSigningInput,
} from "../dist/index.js";

const fixtureDirectory = process.argv[2];
if (!fixtureDirectory) {
  throw new Error("usage: node scripts/verify-vibefield-vectors.mjs <@vibefield/contracts/fixtures>");
}

const bodyTypes = new Map([
  ["tp-attach-control-leg.valid.json", "AttachControlLeg"],
  ["tp-attach-frames-leg.resume.json", "AttachFramesLeg"],
  ["tp-attach-refused.grant-invalid.json", "AttachRefused"],
  ["tp-cell-activation-status.lagging.json", "CellActivationStatus"],
  ["tp-cell-activation-status.presenting-allowed.json", "CellActivationStatus"],
  ["tp-cell-activation-status.revoked.json", "CellActivationStatus"],
  ["tp-claim-geometry.valid.json", "ClaimGeometry"],
  ["tp-connection-accepted.frames.json", "ConnectionAccepted"],
  ["tp-connection-hello.frames.json", "ConnectionHello"],
  ["tp-connection-refused.valid.json", "ConnectionRefused"],
  ["tp-control-leg-attached.valid.json", "ControlLegAttached"],
  ["tp-declare-demand.release.json", "DeclareDemand"],
  ["tp-frames-leg-attached.resume.json", "FramesLegAttached"],
  ["tp-frames-leg-attached.seed.json", "FramesLegAttached"],
  ["tp-geometry-committed.valid.json", "GeometryCommitted"],
  ["tp-scene-applied.valid.json", "SceneApplied"],
  ["tp-transfer-geometry.valid.json", "TransferGeometry"],
  ["tp-transport-credit.valid.json", "TransportCredit"],
]);

const envelopeHeaders = new Set([
  "tp-envelope-header.chunk.json",
  "tp-envelope-header.seed-begin.json",
  "tp-envelope-header.trf1.json",
]);
const ticketVectors = new Set([
  "tp-create-open.s1.json",
  "tp-open-ticket.s1-no-endpoints.json",
  "tp-open-ticket.s1.json",
]);
const structuralVectors = new Set([
  "tp-machines.vector.json",
  "tp-presentation-status.valid.json",
  "tp-renew-attach-params.valid.json",
  "tp-roster-item.valid.json",
]);

let wireCodecs = 0;
let structural = 0;
const files = readdirSync(fixtureDirectory)
  .filter((name) => /^tp-.*\.json$/.test(name))
  .sort();

for (const name of files) {
  const value = JSON.parse(readFileSync(path.join(fixtureDirectory, name), "utf8"));
  const bodyType = bodyTypes.get(name);
  if (bodyType) {
    const wire = encodeRoutedMessage(bodyType, value);
    const decoded = decodeRoutedMessage(wire, ROUTED_MESSAGE_TYPES);
    assert.equal(decoded.ok, true, `${name}: body did not decode`);
    assert.deepEqual(decoded.message, { type: bodyType, ...value }, `${name}: body round-trip changed`);
    wireCodecs += 1;
    continue;
  }
  if (name.startsWith("tp-tagged-message.")) {
    const decoded = decodeRoutedMessage(JSON.stringify(value), ROUTED_MESSAGE_TYPES);
    assert.equal(decoded.ok, true, `${name}: tagged message did not decode`);
    assert.deepEqual(decoded.message, value, `${name}: tagged message round-trip changed`);
    wireCodecs += 1;
    continue;
  }
  if (envelopeHeaders.has(name)) {
    const encoded = encodeRoutedPresentationEnvelope(value, new Uint8Array());
    const decoded = decodeRoutedPresentationEnvelope(encoded);
    assert.equal(decoded.ok, true, `${name}: envelope header did not decode`);
    assert.deepEqual(decoded.envelope.header, value, `${name}: envelope header round-trip changed`);
    wireCodecs += 1;
    continue;
  }
  if (name === "tp-envelope.vector.json") {
    const wire = Uint8Array.from(Buffer.from(value.wireBase64, "base64"));
    const decoded = decodeRoutedPresentationEnvelope(wire);
    assert.equal(decoded.ok, true, `${name}: golden wire did not decode`);
    assert.deepEqual(decoded.envelope.header, value.header);
    assert.equal(Buffer.from(decoded.envelope.payload).toString("hex"), value.payloadHex);
    assert.deepEqual(encodeRoutedPresentationEnvelope(value.header, decoded.envelope.payload), wire);
    wireCodecs += 1;
    continue;
  }
  if (name === "tp-jcs.vector.json") {
    assert.equal(canonicalRoutedJson(value.input), value.canonical);
    structural += 1;
    continue;
  }
  if (name === "tp-grant-mac.vector.json") {
    for (const grant of [value.transport, value.attach]) {
      assert.equal(routedGrantSigningInput(grant.protected, grant.claims), grant.signingInput);
      assert.equal(
        createHmac("sha256", Buffer.from(value.keyHex, "hex")).update(grant.signingInput).digest("base64url"),
        grant.mac,
      );
    }
    structural += 1;
    continue;
  }
  if (name === "tp-transport-grant.valid.json") {
    assert.equal(isRoutedCellTransportGrant(value), true);
    structural += 1;
    continue;
  }
  if (name === "tp-attach-grant.valid.json") {
    assert.equal(isRoutedSessionAttachGrant(value), true);
    structural += 1;
    continue;
  }
  if (ticketVectors.has(name)) {
    assert.equal(isRoutedTerminalOpenTicket(value), true, `${name}: ticket guard refused the vector`);
    structural += 1;
    continue;
  }
  if (name === "tp-protocol-limits.defaults.json") {
    assert.equal(isRoutedProtocolLimits(value), true);
    assert.deepEqual(value, DEFAULT_ROUTED_PROTOCOL_LIMITS);
    structural += 1;
    continue;
  }
  if (structuralVectors.has(name)) {
    assert.deepEqual(JSON.parse(canonicalRoutedJson(value)), value, `${name}: tolerant JSON round-trip changed`);
    structural += 1;
    continue;
  }
  throw new Error(`unclassified VibeField terminal-pipeline vector: ${name}`);
}

console.log(`verified ${files.length} TP vectors (${wireCodecs} wire codecs, ${structural} structural vectors)`);
