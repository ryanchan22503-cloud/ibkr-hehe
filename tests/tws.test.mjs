import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brokerMode, twsSettings, validateTwsReply, readTws } from "../lib/tws.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.join(root, "tests/fixtures/tws_worker.py");
const valid = { ok: true, authenticated: true, complete: true, accounts: ["TEST1"], account_id: "TEST1", positions: [], quotes: [] };

test("TWS accepts only loopback and explicit standard ports, never secrets or arbitrary actions", () => {
  assert.equal(brokerMode({}), "gateway");
  assert.equal(brokerMode({}, "tws"), "tws");
  assert.throws(() => brokerMode({ broker_mode: "anything" }));
  assert.deepEqual(twsSettings({ tws_port: 7497, openai_api_key: "secret", ibkr_bearer_token: "token" }, "status"), { action: "status", port: 7497, account_id: "" });
  for (const port of [5000, "7496", null, true, 0, 65536]) assert.throws(() => twsSettings({ tws_port: port }, "portfolio"));
  assert.throws(() => twsSettings({ tws_host: "example.com" }, "status"));
  assert.throws(() => twsSettings({}, "placeOrder"));
  assert.throws(() => twsSettings({ account_id: [] }, "status"));
});

test("TWS replies require a completed handshake and a whole same-account portfolio", () => {
  assert.deepEqual(validateTwsReply(valid, "portfolio"), valid);
  for (const change of [{ complete: false }, { authenticated: false }, { accounts: [] }, { positions: {} }, { quotes: null },
    { account_id: "OTHER" }, { positions: [{ accountId: "OTHER" }] }]) {
    assert.throws(() => validateTwsReply({ ...valid, ...change }, "portfolio"));
  }
});

test("bounded Python bridge: success, safe errors, cancellation, size and deadline", async t => {
  await t.test("accepts only a complete worker result", async () => {
    const data = await readTws({ account_id: "SUCCESS" }, "portfolio", { worker });
    assert.equal(data.account_id, "SUCCESS");
  });
  await t.test("known errors are translated without echoing worker text", async () => {
    await assert.rejects(readTws({ account_id: "ERROR" }, "status", { worker }), error => error.code === "TWS_NOT_READY" && !error.message.includes("PRIVATE"));
  });
  await t.test("malformed and oversized replies fail closed", async () => {
    await assert.rejects(readTws({ account_id: "MALFORMED" }, "status", { worker }), { code: "TWS_WORKER" });
    await assert.rejects(readTws({ account_id: "OVERSIZE" }, "status", { worker }), { code: "TWS_RESPONSE_LIMIT" });
  });
  await t.test("abort kills the worker, rejects overlapping reads and releases its lock", async () => {
    const controller = new AbortController();
    const pending = readTws({ account_id: "WAIT" }, "status", { worker, signal: controller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(readTws({}, "status", { worker }), { code: "TWS_BUSY" });
    controller.abort();
    await rejected;
    assert.equal((await readTws({ account_id: "SUCCESS" }, "status", { worker })).authenticated, true);
  });
  await t.test("absolute deadline kills stalled workers", async () => {
    await assert.rejects(readTws({ account_id: "WAIT" }, "status", { worker, timeoutMs: 100 }), { code: "TWS_TIMEOUT" });
  });
});
