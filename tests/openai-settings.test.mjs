import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenAiSettingsStore, resolveOpenAiSettings, validateOpenAiSettings } from "../lib/openai-settings.mjs";

const dummy = { openai_api_key: "sk-test-not-a-real-key", openai_model: "test-model" };
async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ibkr-ai-settings-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith("ibkr-ai-settings-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, filename: path.join(directory, "openai-settings.v1.dpapi"), store: createOpenAiSettingsStore({ directory }) };
}

test("local-only and legacy blank-key requests never load saved credentials", async () => {
  const store = { read: () => { throw new Error("must not read"); } };
  for (const input of [{}, { openai_api_key: "" }, { ...dummy, use_ai: false }]) assert.equal(await resolveOpenAiSettings(input, store), null);
  assert.deepEqual(await resolveOpenAiSettings(dummy, store), dummy);
  await assert.rejects(resolveOpenAiSettings({ use_ai: "true" }, store), { code: "INVALID_SETTINGS" });
});

test("AI opt-in resolves a saved key without requiring it in the browser payload", async () => {
  const store = { read: async () => dummy };
  assert.deepEqual(await resolveOpenAiSettings({ use_ai: true }, store), dummy);
  assert.equal((await resolveOpenAiSettings({ use_ai: true, openai_model: "other-model" }, store)).openai_model, "other-model");
  await assert.rejects(resolveOpenAiSettings({ use_ai: true }, { read: async () => null }), { code: "OPENAI_KEY_REQUIRED" });
});

test("invalid credentials and accidental keys in model field are rejected", () => {
  for (const openai_api_key of [null, {}, "", "a\nb", "x".repeat(513)]) assert.throws(() => validateOpenAiSettings({ ...dummy, openai_api_key }));
  for (const openai_model of [null, "", "<script>", dummy.openai_api_key, "sk-another-secret", "x".repeat(129)]) assert.throws(() => validateOpenAiSettings({ ...dummy, openai_model }));
});

test("Windows-protected settings persist, update and forget without plaintext on disk", { skip: process.platform !== "win32" }, async t => {
  const { directory, filename, store } = await temporaryStore(t);
  assert.equal((await store.metadata()).saved, false);
  const saved = await store.save(dummy);
  assert.deepEqual(saved, { saved: true, model: dummy.openai_model, storage: "windows-current-user" });
  assert(!JSON.stringify(saved).includes(dummy.openai_api_key));
  const bytes = await fs.readFile(filename);
  assert(!bytes.includes(Buffer.from(dummy.openai_api_key)));
  assert(!bytes.includes(Buffer.from(dummy.openai_model)));
  const reopened = createOpenAiSettingsStore({ directory });
  assert.deepEqual(await reopened.read(), dummy);
  await reopened.save({ openai_api_key: "", openai_model: "updated-model" });
  assert.deepEqual(await reopened.read(), { ...dummy, openai_model: "updated-model" });
  await reopened.save({ ...dummy, openai_api_key: "replacement-test-secret" });
  assert.equal((await reopened.read()).openai_api_key, "replacement-test-secret");
  assert.deepEqual(await fs.readdir(directory), ["openai-settings.v1.dpapi"]);
  await reopened.forget();
  await reopened.forget();
  assert.equal(await reopened.read(), null);
});

test("corrupt settings fail closed but can be replaced or forgotten", { skip: process.platform !== "win32" }, async t => {
  const { store, filename } = await temporaryStore(t);
  await fs.writeFile(filename, "corrupted protected file");
  await assert.rejects(store.read(), { code: "OPENAI_SETTINGS_UNAVAILABLE" });
  await store.save(dummy);
  assert.deepEqual(await store.read(), dummy);
  await store.forget();
});

test("protection failure never writes a plaintext fallback or replaces existing settings", async t => {
  const { directory, filename } = await temporaryStore(t);
  await fs.writeFile(filename, "existing-ciphertext");
  const store = createOpenAiSettingsStore({ directory, protect: async () => { throw new Error(dummy.openai_api_key); } });
  await assert.rejects(store.save(dummy), error => error.code === "OPENAI_SETTINGS_UNAVAILABLE" && !error.message.includes(dummy.openai_api_key));
  assert.equal(await fs.readFile(filename, "utf8"), "existing-ciphertext");
  assert.deepEqual(await fs.readdir(directory), ["openai-settings.v1.dpapi"]);
  await assert.rejects(store.save({ ...dummy, path: "elsewhere" }), { code: "INVALID_SETTINGS" });
});
