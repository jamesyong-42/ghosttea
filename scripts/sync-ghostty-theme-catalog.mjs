#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [sourceDirectory, outputFile] = process.argv.slice(2);
if (!sourceDirectory || !outputFile) {
  throw new Error("usage: sync-ghostty-theme-catalog.mjs <iTerm2-Color-Schemes/ghostty> <output.json>");
}
const revision = execFileSync("git", ["-C", resolve(sourceDirectory, ".."), "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

function normalizedColor(value) {
  const color = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(color)) throw new Error(`unsupported catalog color: ${value}`);
  return `#${color}`;
}

function parseTheme(path) {
  const values = new Map();
  const palette = new Map();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "palette") {
      const paletteSeparator = value.indexOf("=");
      if (paletteSeparator < 0) continue;
      palette.set(Number(value.slice(0, paletteSeparator).trim()), normalizedColor(value.slice(paletteSeparator + 1)));
    } else {
      values.set(key, normalizedColor(value));
    }
  }
  const foreground = values.get("foreground");
  const background = values.get("background");
  if (!foreground || !background || palette.size < 16) return null;
  return {
    name: basename(path),
    background,
    foreground,
    cursor: values.get("cursor-color") ?? foreground,
    cursorText: values.get("cursor-text") ?? background,
    selection: values.get("selection-background") ?? foreground,
    selectionForeground: values.get("selection-foreground") ?? background,
    palette: Array.from({ length: 16 }, (_, index) => palette.get(index) ?? "#000000"),
  };
}

const catalog = readdirSync(resolve(sourceDirectory), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name !== "AGENTS.md")
  .map((entry) => parseTheme(resolve(sourceDirectory, entry.name)))
  .filter(Boolean)
  .sort((left, right) => left.name.localeCompare(right.name));

writeFileSync(
  resolve(outputFile),
  `${JSON.stringify(
    {
      source: `https://github.com/mbadolato/iTerm2-Color-Schemes/tree/${revision}/ghostty`,
      revision,
      themes: catalog,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${catalog.length} Ghostty themes to ${outputFile}`);
