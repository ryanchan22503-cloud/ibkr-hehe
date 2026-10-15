import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("full dashboard regression: auth, data gates, model boundary, cancellation and responsiveness", async t => {
  let auth = true;
  let brokerage = true;
  let malformed = false;
  let missingBasis = false;
  let modelInvalid = false;
  let modelManual = false;
  let modelError = null;
  let shortPut = false;
  let holdModel = false;
  let releaseModel;
  let notifyModel;
  let modelCalls = 0;
  let lastModelRequest;
  let lastModelAuthorization;
  const ibkrCalls = [];
  const capturedModel = () => new Promise(resolve => { notifyModel = resolve; });
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
  const ibkr = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    ibkrCalls.push(url.pathname);
    let body;
    if (url.pathname.endsWith("/iserver/auth/status")) { res.statusCode = auth ? 200 : 401; body = { authenticated: auth && brokerage, connected: true, competing: false }; }
    else if (url.pathname.endsWith("/iserver/auth/ssodh/init")) { res.statusCode = brokerage ? 200 : 401; body = { authenticated: brokerage }; }
    else if (url.pathname.endsWith("/iserver/accounts")) body = { accounts: ["U123"] };
    else if (url.pathname.endsWith("/portfolio/accounts")) { res.statusCode = auth ? 200 : 401; body = [{ accountId: "U123", accountTitle: "PRIVATE NAME" }]; }
    else if (url.pathname.endsWith("/portfolio/U123/summary")) body = { accountId: "U123", netliquidation: { amount: 10000, currency: "USD" }, privateNote: "PRIVATE NAME" };
    else if (url.pathname.endsWith("/portfolio/U123/positions/0")) body = malformed ? { unexpected: true } : [
      { accountId: "U123", assetClass: "STK", conid: 1, ticker: "TEST", position: 250, avgCost: missingBasis ? null : 50, currency: "USD", accountAlias: "PRIVATE NAME" },
      { accountId: "U123", assetClass: "OPT", conid: 2, ticker: "TEST", position: -1, multiplier: 100, strike: 55, expiry: future, undConid: 1, putOrCall: shortPut ? "P" : "C", currency: "USD" }
    ];
    else if (/positions\/\d+$/.test(url.pathname)) body = [];
    else if (url.pathname.endsWith("/iserver/account/orders")) body = { orders: [], snapshot: true };
    else if (url.pathname.endsWith("/iserver/account/trades")) body = [];
    else if (url.pathname.endsWith("/iserver/marketdata/snapshot")) body = [
      { conid: 1, 84: "52", 86: "52.10", 6509: "RpB", _updated: Date.now() },
      { conid: 2, 84: "2", 86: "2.10", 6509: "RpB", _updated: Date.now(), 7308: shortPut ? "-0.4" : "0.4" }
    ];
    else { res.statusCode = 404; body = { error: "unhandled mock" }; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body));
  });
  await listen(ibkr);
  const openai = http.createServer(async (req, res) => {
    lastModelAuthorization = req.headers.authorization;
    lastModelRequest = JSON.parse(await streamText(req));
    modelCalls++;
    notifyModel?.();
    if (holdModel) await new Promise(resolve => {
      releaseModel = resolve;
      res.on("close", resolve);
    });
    if (res.destroyed) return;
    const reviews = [{ ref: "position_2", action: modelManual ? "MANUAL_REVIEW" : "MONITOR", topics: ["COVERAGE", "OPENING_RECORDS"], ...(modelInvalid ? { guessed_yield: 999999 } : {}) }];
    res.setHeader("Content-Type", "application/json");
    if (modelError) {
      res.writeHead(429, { "Retry-After": "30" });
      return res.end(JSON.stringify({ error: { code: modelError, message: "PRIVATE PROVIDER ERROR" } }));
    }
    res.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ reviews }) }] }] }));
  });
  await listen(openai);
  const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ibkr-ai-integration-test-"));
  const start = () => spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root, env: { ...process.env, PORT: "0", ALLOW_TEST_ENDPOINTS: "1", IBKR_CONNECTION: "gateway",
      OPENAI_BASE_URL: `http://127.0.0.1:${openai.address().port}/v1`, OPENAI_SETTINGS_TEST_DIR: settingsDirectory,
      IBKR_BASE_URL: `http://127.0.0.1:${ibkr.address().port}/v1/api` }, stdio: ["ignore", "pipe", "pipe"]
  });
  let child = start();
  t.after(async () => {
    releaseModel?.(); child.kill();
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(2000)]);
    for (const server of [ibkr, openai]) { server.closeAllConnections(); server.close(); }
    assert.equal(path.dirname(path.resolve(settingsDirectory)), path.resolve(os.tmpdir()));
    assert(path.basename(settingsDirectory).startsWith("ibkr-ai-integration-test-"));
    await fs.rm(settingsDirectory, { recursive: true, force: true });
  });
  let origin = await ready(child);
  const payload = { openai_api_key: "test-secret", openai_model: "test-model", question: "Review U123 and test-secret" };
  const post = (endpoint, body = {}, options = {}) => fetch(origin + endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify(body), signal: options.signal
  });
  await t.test("status distinguishes unauthenticated session from account access", async () => {
    auth = false;
    let response = await post("/api/status");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "IBKR_LOGIN_REQUIRED");
    auth = true;
    response = await post("/api/status");
    const status = await response.json();
    assert.equal(status.authenticated, true); assert.equal(status.account_count, 1);
  });
  await t.test("cross-origin requests and malformed JSON shapes are rejected", async () => {
    assert.equal((await post("/api/analyze", payload, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await post("/api/status", [])).status, 400);
    assert.equal((await post("/api/orders", {})).status, 404);
    assert.equal((await post("/api/settings/openai", payload)).status, 403);
    assert.equal((await post("/api/settings/openai", payload, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await post("/api/settings/openai/forget", {}, { headers: { Origin: "null" } })).status, 403);
    assert.equal((await post("/api/settings/question", { question: "review" })).status, 403);
    assert.equal((await post("/api/settings/question", { question: "review" }, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await post("/api/settings/question/forget", {}, { headers: { Origin: "null" } })).status, 403);
    assert.equal((await fetch(origin + "/api/settings/question", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  });
  await t.test("TWS settings select the isolated connector without sending Gateway requests", async () => {
    const before = ibkrCalls.length;
    const response = await post("/api/status", { broker_mode: "tws", tws_port: 5000 });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_TWS_INPUT");
    assert.equal(ibkrCalls.length, before);
    const page = await fetch(origin + "/").then(r => r.text());
    assert(page.includes('id="brokerMode"'));
    assert(page.includes('id="twsPort"'));
    assert(page.includes('id="tradierKey"'));
    assert(page.includes('id="alpha_vantageKey"'));
  });
  await t.test("provider settings require same-origin access and stay separate from AI settings", async () => {
    const data = { provider: "tradier", key: "test-provider-token", enabled: false, mode: "sandbox" };
    assert.equal((await post("/api/settings/data", data)).status, 403);
    assert.equal((await post("/api/settings/data/reset", {})).status, 403);
    assert.equal((await post("/api/settings/data/test", { provider: "tradier" }, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await post("/api/settings/data", data, { headers: { Origin: origin } })).status, 200);
    const meta = await fetch(origin + "/api/settings/data").then(r => r.json());
    assert.equal(meta.tradier.saved, true);
    assert.equal(meta.tradier.enabled, false);
    assert(!JSON.stringify(meta).includes(data.key));
    const checked = await post("/api/settings/data/test", { provider: "tradier" }, { headers: { Origin: origin } }).then(r => r.json());
    assert.equal(checked.status, "DISABLED");
    assert.equal((await fetch(origin + "/api/settings/openai").then(r => r.json())).saved, false);
    await post("/api/settings/data/forget", { provider: "tradier" }, { headers: { Origin: origin } });
    assert.equal((await fetch(origin + "/api/settings/data").then(r => r.json())).tradier.saved, false);
  });
  await t.test("portfolio-only login is reported separately and never sent to OpenAI", async () => {
    brokerage = false;
    const status = await post("/api/status").then(r => r.json());
    assert.equal(status.state, "portfolio_only");
    assert.equal(status.portfolio_authenticated, true);
    assert.equal(status.authenticated, false);
    const before = modelCalls;
    const data = await post("/api/analyze").then(r => r.json());
    assert.equal(data.state, "portfolio_only");
    assert.equal(data.data_sent_to_openai, null);
    assert.equal(data.verified_data.options[0].quote, null);
    assert.equal(modelCalls, before);
    brokerage = true;
  });
  await t.test("local figures do not require an OpenAI key", async () => {
    await delay(5100);
    const before = modelCalls;
    const data = await post("/api/analyze").then(r => r.json());
    assert.equal(data.state, "limited_review");
    assert.equal(data.data_sent_to_openai, null);
    assert.match(data.advice, /210.0000/);
    assert.equal(modelCalls, before);
  });
  await t.test("slow model calls leave health and static UI responsive; duplicates are blocked", async () => {
    await delay(5100);
    holdModel = true;
    const modelStarted = capturedModel();
    const pending = post("/api/analyze", payload);
    await modelStarted;
    const started = performance.now();
    const health = await fetch(origin + "/api/health").then(r => r.json());
    const page = await fetch(origin + "/").then(r => r.text());
    const latency = performance.now() - started;
    assert.equal(health.analyzing, true); assert(page.includes('id="cancel"'));
    assert(latency < 750, `UI health latency was ${latency} ms`);
    assert.equal((await post("/api/analyze", payload)).status, 409);
    releaseModel(); holdModel = false;
    const response = await pending;
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.state, "limited_review");
    assert.match(data.advice, /210.0000/);
    assert.equal(data.verified_data.stocks[0].remainder_shares, "50");
    assert(!JSON.stringify(lastModelRequest).includes("U123"));
    assert(!JSON.stringify(lastModelRequest).includes("PRIVATE NAME"));
    assert(!JSON.stringify(lastModelRequest).includes("test-secret"));
    assert.equal(lastModelRequest.store, false);
    assert.equal(lastModelRequest.text.format.strict, true);
    assert.equal(lastModelRequest.tools, undefined);
    assert(ibkrCalls.indexOf("/v1/api/portfolio/accounts") < ibkrCalls.indexOf("/v1/api/portfolio/U123/positions/0"));
    t.diagnostic(`Health + page while OpenAI was stalled: ${latency.toFixed(1)} ms`);
  });
  await t.test("missing opening history does not suppress the requested AI review or conditional rules", async () => {
    await delay(5100);
    shortPut = true;
    modelManual = true;
    const before = modelCalls;
    try {
      const data = await post("/api/analyze", payload).then(r => r.json());
      assert.equal(data.state, "manual_review_required");
      assert.notEqual(data.data_sent_to_openai, null);
      assert.equal(data.model, "test-model");
      assert.equal(modelCalls, before + 1);
      assert.equal(data.verified_data.options[0].coverage, null);
      assert.match(data.advice, /Missing opening credit does not block/);
      assert.match(data.advice, /delta reassessment threshold is met/);
      assert.match(data.advice, /Short-put risk review/);
      assert.equal(data.verified_data.options[0].short_put.assignment_cash_assuming_standard, "5500.0000");
      assert.match(data.advice, /210.0000/);
    } finally { shortPut = false; modelManual = false; }
  });
  await t.test("a completed model call returning manual review is not labeled a complete assessment", async () => {
    await delay(5100);
    modelManual = true;
    try {
      const data = await post("/api/analyze", payload).then(r => r.json());
      assert.equal(data.state, "manual_review_required");
      assert.equal(data.model, "test-model");
      assert.notEqual(data.data_sent_to_openai, null);
    } finally { modelManual = false; }
  });
  await t.test("missing basis blocks transmission to OpenAI", async () => {
    await delay(5100); missingBasis = true;
    const before = modelCalls;
    const data = await post("/api/analyze", payload).then(r => r.json());
    assert.equal(data.state, "validation_blocked"); assert.equal(data.data_sent_to_openai, null); assert.equal(modelCalls, before);
    missingBasis = false;
  });
  await t.test("malformed position pages cannot become an empty portfolio", async () => {
    await delay(5100); malformed = true;
    const response = await post("/api/analyze", payload);
    assert.equal(response.status, 502); assert.equal((await response.json()).code, "INVALID_POSITIONS");
    malformed = false;
  });
  await t.test("invented model numbers are blocked while local figures survive", async () => {
    await delay(5100); modelInvalid = true;
    const data = await post("/api/analyze", payload).then(r => r.json());
    assert.equal(data.state, "ai_unavailable"); assert(!data.advice.includes("999999")); assert.match(data.advice, /210.0000/);
    modelInvalid = false;
  });
  await t.test("rate and credit limits keep local figures, distinguish causes and never retry", async () => {
    for (const [reason, code, text] of [["rate_limit_exceeded", "OPENAI_RATE_LIMIT", /Wait at least 30 seconds/],
      ["credit_balance_exhausted", "OPENAI_CREDIT_EXHAUSTED", /exhausted its prepaid/]]) {
      await delay(5100);
      modelError = reason;
      const before = modelCalls;
      try {
        const response = await post("/api/analyze", payload);
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.equal(data.state, "ai_unavailable");
        assert.equal(data.ai_error_code, code);
        assert.match(data.advice, text);
        assert.match(data.advice, /210.0000/);
        assert(!data.advice.includes("PRIVATE"));
        assert.equal(modelCalls, before + 1);
      } finally { modelError = null; }
    }
  });
  await t.test("cancelling a browser request aborts the model request and releases the analysis lock", async () => {
    await delay(5100); holdModel = true;
    const controller = new AbortController();
    const started = capturedModel();
    const request = post("/api/analyze", payload, { signal: controller.signal }).catch(error => error);
    await started; controller.abort();
    const error = await request;
    assert.equal(error.name, "AbortError");
    let health;
    for (let i = 0; i < 20; i++) {
      health = await fetch(origin + "/api/health").then(r => r.json());
      if (!health.analyzing) break;
      await delay(50);
    }
    assert.equal(health.analyzing, false);
    holdModel = false;
  });
  await t.test("saved settings survive server restart, stay private and preserve local-only mode", { skip: process.platform !== "win32" }, async () => {
    const credentials = { openai_api_key: "saved-test-secret", openai_model: "saved-test-model" };
    const question = "Review saved-test-secret and U123\n" + "Keep all review preferences.\n".repeat(1600) + "END OF SAVED QUESTION";
    const beforeSave = modelCalls;
    assert.equal((await post("/api/settings/question", { question: "" }, { headers: { Origin: origin } })).status, 400);
    assert.equal((await post("/api/settings/question", { question: "x".repeat(64001) }, { headers: { Origin: origin } })).status, 400);
    assert.equal((await post("/api/settings/question", { question }, { headers: { Origin: origin } })).status, 200);
    assert.equal(modelCalls, beforeSave);
    const save = await post("/api/settings/openai", credentials, { headers: { Origin: origin } });
    assert.equal(save.status, 200);
    assert(!JSON.stringify(await save.json()).includes(credentials.openai_api_key));
    const stopped = new Promise(resolve => child.once("exit", resolve));
    child.kill(); await stopped;
    child = start(); origin = await ready(child);
    const metaResponse = await fetch(origin + "/api/settings/openai");
    assert.equal(metaResponse.headers.get("cache-control"), "no-store");
    const metaText = await metaResponse.text();
    assert.equal(JSON.parse(metaText).model, credentials.openai_model);
    assert(!metaText.includes(credentials.openai_api_key));
    const savedQuestionResponse = await fetch(origin + "/api/settings/question");
    assert.equal(savedQuestionResponse.headers.get("cache-control"), "no-store");
    assert.equal((await savedQuestionResponse.json()).question, question);
    let before = modelCalls;
    let data = await post("/api/analyze", { use_ai: false }, { headers: { Origin: origin } }).then(r => r.json());
    assert.equal(data.state, "limited_review"); assert.equal(modelCalls, before);
    await delay(5100);
    data = await post("/api/analyze", { use_ai: true, question }, { headers: { Origin: origin } }).then(r => r.json());
    assert.equal(data.state, "limited_review");
    assert.equal(modelCalls, before + 1);
    assert.equal(lastModelAuthorization, `Bearer ${credentials.openai_api_key}`);
    assert.equal(lastModelRequest.model, credentials.openai_model);
    assert(!JSON.stringify(data).includes(credentials.openai_api_key));
    assert(!JSON.stringify(lastModelRequest).includes(credentials.openai_api_key));
    assert.equal(JSON.parse(lastModelRequest.input).question, question.replaceAll(credentials.openai_api_key, "[removed]").replaceAll("U123", "[removed]"));
    assert.equal(lastModelRequest.tools, undefined);
    await post("/api/settings/question/forget", {}, { headers: { Origin: origin } });
    assert.equal((await fetch(origin + "/api/settings/question").then(r => r.json())).saved, false);
    assert.equal((await fetch(origin + "/api/settings/openai").then(r => r.json())).saved, true);
    await post("/api/settings/openai/forget", {}, { headers: { Origin: origin } });
    assert.equal((await fetch(origin + "/api/settings/openai").then(r => r.json())).saved, false);
    await delay(5100);
    const failed = await post("/api/analyze", { use_ai: true }, { headers: { Origin: origin } }).then(r => r.json());
    assert.equal(failed.code, "OPENAI_KEY_REQUIRED");
    assert.equal(modelCalls, before + 1);
  });
});
function listen(server) { return new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); }
async function streamText(stream) { const chunks=[]; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
function ready(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("App startup timed out")), 10_000);
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.stderr.on("data", chunk => { clearTimeout(timer); reject(new Error(String(chunk))); });
    child.once("exit", code => { clearTimeout(timer); if (!output) reject(new Error(`App exited: ${code}`)); });
  });
}
