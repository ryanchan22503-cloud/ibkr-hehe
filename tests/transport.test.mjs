import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { requestJson } from "../lib/transport.mjs";
import { makeIbkrClient } from "../lib/ibkr.mjs";
import { OPENAI_ERROR_METADATA } from "../lib/openai-errors.mjs";

async function fixture(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(new URL(`http://127.0.0.1:${server.address().port}/`)); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test("login HTML is never accepted as authenticated JSON", async () => {
  await fixture((req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<form>Login</form>"); }, async url => {
    await assert.rejects(requestJson(url), { code: "NON_JSON_RESPONSE" });
  });
});
test("authentication failures are not retried", async () => {
  let calls = 0;
  await fixture((req, res) => { calls++; res.writeHead(401); res.end(); }, async url => {
    await assert.rejects(requestJson(url)); assert.equal(calls, 1);
  });
});

test("CSV mode is explicit and still rejects HTML, oversized bodies and redirects", async () => {
  await fixture((req, res) => { res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.end("symbol,reportDate\nXLP,2026-10-10\n"); }, async url => {
    assert.match(await requestJson(url, { textResponse: true }), /^symbol,/);
    await assert.rejects(requestJson(url), { code: "NON_JSON_RESPONSE" });
    await assert.rejects(requestJson(url, { textResponse: true, maxBytes: 10 }), { code: "RESPONSE_TOO_LARGE" });
  });
  await fixture((req, res) => { res.setHeader("Content-Type", "text/html"); res.end("Login"); }, async url => {
    await assert.rejects(requestJson(url, { textResponse: true }), { code: "NON_JSON_RESPONSE" });
  });
  await fixture((req, res) => { res.setHeader("Content-Type", "application/x-download"); res.end("symbol,reportDate\n"); }, async url => {
    assert.equal(await requestJson(url, { textResponse: true }), "symbol,reportDate\n");
    await assert.rejects(requestJson(url), { code: "NON_JSON_RESPONSE" });
  });
  await fixture((req, res) => { res.writeHead(302, { Location: "https://example.com" }); res.end(); }, async url => {
    await assert.rejects(requestJson(url, { textResponse: true }), { code: "UPSTREAM_HTTP" });
  });
});
test("POST model calls are not retried on rate limits", async () => {
  let calls = 0;
  await fixture((req, res) => { calls++; res.writeHead(429); res.end(); }, async url => {
    await assert.rejects(requestJson(url, { method: "POST", body: {} })); assert.equal(calls, 1);
  });
});
test("upstream errors retain only opted-in, allowlisted codes and never private bodies", async () => {
  for (const code of ["project_spend_limit_exceeded", "PRIVATE ACCOUNT"]) {
    let calls = 0;
    await fixture((req, res) => {
      calls++;
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "17" });
      res.end(JSON.stringify({ error: { code, type: "insufficient_quota", message: "PRIVATE KEY", param: "PRIVATE PROMPT" } }));
    }, async url => {
      await assert.rejects(requestJson(url, { method: "POST", body: {}, errorMetadata: OPENAI_ERROR_METADATA }), e => {
        assert.equal(e.upstreamCode, code.startsWith("PRIVATE") ? undefined : code);
        assert.equal(e.upstreamType, "insufficient_quota");
        assert.equal(e.retryAfter, 17);
        assert(!JSON.stringify(e).includes("PRIVATE"));
        return true;
      });
      assert.equal(calls, 1);
      await assert.rejects(requestJson(url, { method: "POST", body: {} }), e => {
        assert.equal(e.upstreamCode, undefined); assert.equal(e.upstreamType, undefined); return true;
      });
    });
  }
  await fixture((req, res) => { res.writeHead(429, { "Content-Type": "application/json" }); res.end("PRIVATE malformed"); }, async url => {
    await assert.rejects(requestJson(url, { method: "POST", errorMetadata: OPENAI_ERROR_METADATA }), { code: "UPSTREAM_HTTP" });
  });
});
test("long Retry-After dates do not trigger an early retry", async () => {
  let calls = 0;
  await fixture((req, res) => { calls++; res.writeHead(429, { "Retry-After": new Date(Date.now() + 60_000).toUTCString() }); res.end(); }, async url => {
    await assert.rejects(requestJson(url)); assert.equal(calls, 1);
  });
});
test("absolute timeout stops trickling upstream responses", async () => {
  await fixture((req, res) => {
    res.setHeader("Content-Type", "application/json"); res.write("[");
    const timer = setInterval(() => res.write(" "), 5); res.on("close", () => clearInterval(timer));
  }, async url => {
    const started = Date.now();
    await assert.rejects(requestJson(url, { timeoutMs: 100 }), { code: "UPSTREAM_TIMEOUT" });
    assert(Date.now() - started < 1500);
  });
});
test("response size and caller cancellation are bounded", async () => {
  await fixture((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify("x".repeat(10000))); }, async url => {
    await assert.rejects(requestJson(url, { maxBytes: 100 }), { code: "RESPONSE_TOO_LARGE" });
  });
  await fixture(() => {}, async url => {
    await assert.rejects(requestJson(url, { signal: AbortSignal.timeout(50) }), { name: "AbortError" });
  });
});
test("Gateway/OAuth mismatch and foreign endpoints fail before transmitting secrets", async () => {
  for (const input of [
    { ibkr_base_url: "https://localhost:5000/v1/api", ibkr_bearer_token: "secret" },
    { ibkr_base_url: "https://api.ibkr.com/v1/api" },
    { ibkr_base_url: "https://api.ibkr.com.evil.test/v1/api", ibkr_bearer_token: "secret" },
    { ibkr_base_url: "http://localhost:5000/v1/api" },
    { ibkr_base_url: "https://user:password@localhost:5000/v1/api" }
  ]) await assert.rejects(makeIbkrClient(input));
  const client = await makeIbkrClient({ ibkr_base_url: "http://127.0.0.1:1/v1/api" }, { allowTests: true });
  await assert.rejects(client.request("POST", "iserver/account/U123/orders"), { code: "READ_ONLY_BOUNDARY" });
  await assert.rejects(client.request("POST", "iserver/auth/ssodh/init", {}, { publish: true, compete: true }), { code: "SESSION_TAKEOVER_BLOCKED" });
});
