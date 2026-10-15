import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createQuestionSettingsStore, validateQuestion, MAX_QUESTION_LENGTH } from "../lib/question-settings.mjs";
import { createOpenAiSettingsStore } from "../lib/openai-settings.mjs";

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ibkr-question-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert(path.basename(directory).startsWith("ibkr-question-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, filename: path.join(directory, "question.v1.dpapi"), store: createQuestionSettingsStore({ directory }) };
}

test("question validation preserves full text and rejects invalid or oversized values", () => {
  const text = "  Review\r\n\n" + "details ".repeat(5000) + "\u4e2d\u6587 </textarea><script>ignored</script>\n";
  assert.equal(validateQuestion(text), text);
  assert.equal(validateQuestion("x".repeat(MAX_QUESTION_LENGTH)).length, MAX_QUESTION_LENGTH);
  assert.equal(validateQuestion("", { allowEmpty: true }), "");
  for (const value of [undefined, null, 123, {}, [], "", " \n", "x".repeat(MAX_QUESTION_LENGTH + 1)]) {
    assert.throws(() => validateQuestion(value), { code: "INVALID_QUESTION" });
  }
});

test("long questions persist encrypted, update, and forget independently of credentials", { skip: process.platform !== "win32" }, async t => {
  const { directory, filename, store } = await temporaryStore(t);
  const ai = createOpenAiSettingsStore({ directory });
  const credentials = { openai_api_key: "sk-test-question-only", openai_model: "test-model" };
  await ai.save(credentials);
  const credentialBytes = await fs.readFile(path.join(directory, "openai-settings.v1.dpapi"));
  assert.equal((await store.read()).saved, false);
  const question = "Full review\r\n" + "Keep every paragraph.\n".repeat(2000) + "END OF PROMPT";
  assert.equal((await store.save({ question })).question, question);
  const encrypted = await fs.readFile(filename);
  assert(!encrypted.includes(Buffer.from("Full review")));
  assert(!encrypted.includes(Buffer.from("END OF PROMPT")));
  const reopened = createQuestionSettingsStore({ directory });
  assert.equal((await reopened.read()).question, question);
  // Exercise the longest JSON-escaped text as well as multibyte UTF-8.
  for (const text of ["\u0001".repeat(MAX_QUESTION_LENGTH), "\u4e2d".repeat(MAX_QUESTION_LENGTH)]) {
    await reopened.save({ question: text });
    assert.equal((await reopened.read()).question, text);
  }
  await reopened.save({ question: "Review whenever I ask." });
  assert.equal((await store.read()).question, "Review whenever I ask.");
  await reopened.forget();
  await reopened.forget();
  assert.equal((await reopened.read()).saved, false);
  assert.deepEqual(await fs.readFile(path.join(directory, "openai-settings.v1.dpapi")), credentialBytes);
  assert.deepEqual(await ai.read(), credentials);
  assert.deepEqual(await fs.readdir(directory), ["openai-settings.v1.dpapi"]);
});

test("corrupt saved questions fail closed and can be replaced or forgotten", { skip: process.platform !== "win32" }, async t => {
  const { filename, store } = await temporaryStore(t);
  await fs.writeFile(filename, "corrupt");
  await assert.rejects(store.read(), { code: "QUESTION_SETTINGS_UNAVAILABLE" });
  await store.save({ question: "Replacement" });
  assert.equal((await store.read()).question, "Replacement");
  await fs.writeFile(filename, "corrupt again");
  await store.forget();
  assert.equal((await store.read()).saved, false);
});

test("failed question encryption never overwrites a saved value or writes plaintext", async t => {
  const { directory, filename } = await temporaryStore(t);
  await fs.writeFile(filename, "existing-ciphertext");
  const store = createQuestionSettingsStore({ directory, protect: async () => { throw new Error("private prompt text"); } });
  await assert.rejects(store.save({ question: "private prompt text" }), error => error.code === "QUESTION_SETTINGS_UNAVAILABLE" && !error.message.includes("private prompt text"));
  assert.equal(await fs.readFile(filename, "utf8"), "existing-ciphertext");
  assert.deepEqual(await fs.readdir(directory), ["question.v1.dpapi"]);
  await assert.rejects(store.save({ question: "text", openai_api_key: "not-allowed" }), { code: "INVALID_SETTINGS" });
  await assert.rejects(store.save([]), { code: "INVALID_SETTINGS" });
});

test("concurrent question saves are serialized without partial files", { skip: process.platform !== "win32" }, async t => {
  const { directory, store } = await temporaryStore(t);
  const first = store.save({ question: "First" });
  const second = store.save({ question: "Second" });
  await first; await second;
  assert.equal((await store.read()).question, "Second");
  assert.deepEqual(await fs.readdir(directory), ["question.v1.dpapi"]);
});
