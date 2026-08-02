#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(scriptDirectory, "../packages/ghosttea-react/src/renderers/shader-effects.ts"),
  "utf8",
);
const match = source.match(/SHADER_EFFECT_WGSL(?:\s*:\s*string)?\s*=\s*\/\* wgsl \*\/\s*`([\s\S]*?)`;\s*$/u);
if (!match) throw new Error("could not extract SHADER_EFFECT_WGSL");
const shader = match[1];

app.commandLine.appendSwitch("enable-unsafe-webgpu");

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await window.loadFile(resolve(scriptDirectory, "fixtures/webgpu-validation.html"));
    const result = await window.webContents.executeJavaScript(`(async () => {
      if (!navigator.gpu) return { unavailable: true, messages: [] };
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { unavailable: true, messages: [] };
      const device = await adapter.requestDevice();
      const module = device.createShaderModule({ code: ${JSON.stringify(shader)} });
      const info = await module.getCompilationInfo();
      device.pushErrorScope("validation");
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vertex_main" },
        fragment: {
          module,
          entryPoint: "fragment_main",
          targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
        },
        primitive: { topology: "triangle-list" },
      });
      const pipelineError = await device.popErrorScope();
      device.destroy();
      return {
        unavailable: false,
        messages: [
          ...info.messages.map((message) => ({
            type: message.type,
            lineNum: message.lineNum,
            linePos: message.linePos,
            message: message.message,
          })),
          ...(pipelineError
            ? [{ type: "error", lineNum: 0, linePos: 0, message: pipelineError.message }]
            : []),
        ],
      };
    })()`);
    if (result.unavailable) {
      console.error("WebGPU is unavailable in this Electron runtime");
      app.exit(2);
      return;
    }
    for (const message of result.messages) {
      console.error(`${message.type} ${message.lineNum}:${message.linePos} ${message.message}`);
    }
    const errors = result.messages.filter((message) => message.type === "error");
    if (errors.length === 0) console.log("WebGPU shader registry compiled without errors");
    app.exit(errors.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
