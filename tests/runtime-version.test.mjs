import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { sourceVersion } from "../lib/runtime-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("mixed deployment is detected before any broker or AI call and health stays responsive", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-runtime-test-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
    assert.equal(path.dirname(directory), os.tmpdir());
    assert(path.basename(directory).startsWith("advisor-runtime-test-"));
    await fs.rm(directory, { force: true, recursive: true });
  });
  await fs.copyFile(path.join(root, "server.mjs"), path.join(directory, "server.mjs"));
  for (const folder of ["lib", "bridge", "public", "vendor"]) await fs.cp(path.join(root, folder), path.join(directory, folder), { recursive: true });
  child = spawn(process.execPath, [path.join(directory, "server.mjs")], { cwd: directory,
    env: { ...process.env, PORT: "0", ALLOW_TEST_ENDPOINTS: "1", OPENAI_SETTINGS_TEST_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Startup timeout")), 10000);
    child.stdout.on("data", chunk => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(chunk));
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.stderr.on("data", chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
  });
  let health = await fetch(origin + "/api/health").then(r => r.json());
  assert.equal(health.restart_required, false);
  assert.equal(health.version, await sourceVersion(directory));
  await fs.appendFile(path.join(directory, "bridge/tws_bridge.py"), "\n# Deployment changed\n");
  health = await fetch(origin + "/api/health").then(r => r.json());
  assert.equal(health.restart_required, true);
  for (const endpoint of ["/api/status", "/api/analyze"]) {
    const response = await fetch(origin + endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "ADVISOR_RESTART_REQUIRED");
  }
  assert.equal((await fetch(origin + "/api/health").then(r => r.json())).analyzing, false);
});
