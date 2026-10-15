import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./lib/errors.mjs";
import { OPENAI_ERROR_METADATA, openAiFailure } from "./lib/openai-errors.mjs";
import { buildUrl, requestJson } from "./lib/transport.mjs";
import { makeIbkrClient, inspectConnection, accountIds, readAllPositions, readSnapshots } from "./lib/ibkr.mjs";
import { validatePositions, validateQuote, buildVerifiedSnapshot, decimal } from "./lib/portfolio.mjs";
import { strategyRequest, validateStrategyResponse, renderReview } from "./lib/strategy.mjs";
import { brokerMode, readTws } from "./lib/tws.mjs";
import { createOpenAiSettingsStore, resolveOpenAiSettings } from "./lib/openai-settings.mjs";
import { createQuestionSettingsStore, validateQuestion, QUESTION_BODY_LIMIT } from "./lib/question-settings.mjs";
import { enrichReview } from "./lib/review-data.mjs";
import { enrichTwsMarketData } from "./lib/tws-enrichment.mjs";
import { sourceVersion } from "./lib/runtime-version.mjs";
import { createDataSettingsStore, PROVIDERS } from "./lib/data-settings.mjs";
import { createMarketDataService, createDailyBudget } from "./lib/market-data.mjs";
import { applyMarketData } from "./lib/market-review.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const runningVersion = await sourceVersion(root);
const startedAt = new Date().toISOString();
const host = "127.0.0.1";
const port = Number(process.env.PORT || 3210);
const defaultIbkrBase = process.env.IBKR_BASE_URL || "https://localhost:5000/v1/api";
const openAiBase = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const caFile = process.env.IBKR_CA_FILE || path.join(root, "certs/ibkr-local.pem");
const allowTests = process.env.ALLOW_TEST_ENDPOINTS === "1";
const defaultBrokerMode = process.env.IBKR_CONNECTION || "gateway";
const openAiSettings = createOpenAiSettingsStore(allowTests && process.env.OPENAI_SETTINGS_TEST_DIR
  ? { directory: process.env.OPENAI_SETTINGS_TEST_DIR } : {});
const questionSettings = createQuestionSettingsStore(allowTests && process.env.OPENAI_SETTINGS_TEST_DIR
  ? { directory: process.env.OPENAI_SETTINGS_TEST_DIR } : {});
const dataSettings = createDataSettingsStore(allowTests && process.env.OPENAI_SETTINGS_TEST_DIR
  ? { directory: process.env.OPENAI_SETTINGS_TEST_DIR } : {});
const marketData = createMarketDataService(allowTests && process.env.OPENAI_SETTINGS_TEST_DIR
  ? { reserve: createDailyBudget(process.env.OPENAI_SETTINGS_TEST_DIR) } : {});
let analyzing = false;
let checking = false;
let keepAliveTimer = null;
let keepAliveBase = null;
let keepAliveGeneration = 0;
let lastKeepAliveError = null;
let lastAnalysisAt = 0;
const client = (input, signal) => makeIbkrClient(input, { defaultBase: defaultIbkrBase, caFile, allowTests, signal });

const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 240_000);
  deadline.unref();
  res.on("close", () => controller.abort());
  req.on("aborted", () => controller.abort());
  try {
    setSecurityHeaders(res);
    enforceLocalRequest(req);
    if (req.method === "GET" && req.url === "/") return await sendFile(res, "public/index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && req.url === "/app.js") return await sendFile(res, "public/app.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && req.url === "/styles.css") return await sendFile(res, "public/styles.css", "text/css; charset=utf-8");
    if (req.method === "GET" && req.url === "/api/config") return json(res, 200, { defaultIbkrBase, defaultBrokerMode, authentication: "tws_or_gateway_or_issued_oauth_token" });
    if (req.method === "GET" && req.url === "/api/settings/openai") return json(res, 200, await openAiSettings.metadata());
    if (req.method === "GET" && req.url === "/api/settings/question") return json(res, 200, await questionSettings.read());
    if (req.method === "GET" && req.url === "/api/settings/data") return json(res, 200, await dataSettings.metadata());
    if (req.method === "POST" && ["/api/settings/data", "/api/settings/data/forget", "/api/settings/data/test", "/api/settings/data/reset"].includes(req.url)) {
      requireBrowserOrigin(req);
      if (analyzing) throw new AppError("ANALYSIS_BUSY", "Wait for the review to finish before changing or testing data sources.", 409);
      const input = await readJson(req, 4096);
      if (req.url.endsWith("/reset")) {
        if (Object.keys(input).length) throw new AppError("INVALID_DATA_SETTINGS", "Reset data sources does not accept other settings.");
        return json(res, 200, await dataSettings.reset());
      }
      if (!PROVIDERS.includes(input.provider)) throw new AppError("INVALID_DATA_SETTINGS", "Unknown data source.");
      if (req.url !== "/api/settings/data" && Object.keys(input).some(k => k !== "provider")) throw new AppError("INVALID_DATA_SETTINGS", "Only the data source name is accepted here.");
      if (req.url.endsWith("/forget")) return json(res, 200, await dataSettings.forget(input.provider));
      if (req.url.endsWith("/test")) return json(res, 200, await marketData.test(input.provider, await dataSettings.read(), { signal: controller.signal }));
      return json(res, 200, await dataSettings.save(input));
    }
    if (req.method === "POST" && ["/api/settings/question", "/api/settings/question/forget"].includes(req.url)) {
      requireBrowserOrigin(req);
      const input = await readJson(req, req.url.endsWith("/forget") ? 4096 : QUESTION_BODY_LIMIT);
      if (req.url.endsWith("/forget") && Object.keys(input).length) throw new AppError("INVALID_SETTINGS", "Forget question does not accept other settings.");
      const settings = req.url.endsWith("/forget") ? await questionSettings.forget() : await questionSettings.save(input);
      return json(res, 200, settings);
    }
    if (req.method === "POST" && ["/api/settings/openai", "/api/settings/openai/forget"].includes(req.url)) {
      requireBrowserOrigin(req);
      const input = await readJson(req, 4096);
      if (req.url.endsWith("/forget") && Object.keys(input).length) throw new AppError("INVALID_SETTINGS", "Forget settings does not accept credentials.");
      const settings = req.url.endsWith("/forget") ? await openAiSettings.forget() : await openAiSettings.save(input);
      return json(res, 200, settings);
    }
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true, analyzing, checking,
      version: runningVersion, started_at: startedAt, restart_required: await sourceVersion(root) !== runningVersion,
      keep_alive: Boolean(keepAliveBase), last_keepalive_error: lastKeepAliveError });
    if (req.method === "POST" && ["/api/status", "/api/analyze"].includes(req.url) && await sourceVersion(root) !== runningVersion) {
      throw new AppError("ADVISOR_RESTART_REQUIRED", "The advisor was updated while it was running. Reopen Start Advisor, then refresh this page. Your saved settings are unchanged.", 503);
    }
    if (req.method === "POST" && req.url === "/api/disconnect") {
      await readJson(req);
      stopKeepAlive();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/status") {
      if (checking) throw new AppError("STATUS_BUSY", "A connection check is already running.", 409);
      checking = true;
      try {
        const input = await readJson(req);
        if (brokerMode(input, defaultBrokerMode) === "tws") {
          stopKeepAlive();
          const data = await readTws(input, "status", { signal: controller.signal });
          return json(res, 200, { ok: true, authenticated: true, connected: true, portfolio_authenticated: true,
            state: "connected", account_count: data.accounts.length, auth_mode: "tws", keep_alive: false, app_read_only: true });
        }
        const ibkr = await client(input, controller.signal);
        const session = await inspectConnection(ibkr);
        if (ibkr.local && input.keep_alive === true) startKeepAlive(ibkr.base, session.brokerage);
        else stopKeepAlive();
        return json(res, 200, { ok: true, authenticated: session.brokerage, connected: session.brokerage,
          portfolio_authenticated: true, state: session.brokerage ? "connected" : "portfolio_only", account_count: session.accounts.length,
          brokerage_error: session.brokerage_error || null,
          auth_mode: ibkr.local ? "gateway" : "oauth_token", login_url: ibkr.loginUrl, keep_alive: Boolean(keepAliveBase) });
      } catch (error) { stopKeepAlive(error.code); throw error; }
      finally { checking = false; }
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      if (analyzing) throw new AppError("ANALYSIS_BUSY", "An analysis is already running. Cancel it or wait for it to finish.", 409);
      if (Date.now() - lastAnalysisAt < 5000) throw new AppError("ANALYSIS_COOLDOWN", "Wait a few seconds before refreshing the portfolio.", 429);
      analyzing = true;
      lastAnalysisAt = Date.now();
      try {
        const input = await readJson(req, QUESTION_BODY_LIMIT);
        if (input.use_ai === true) requireBrowserOrigin(req);
        const result = await analyze(input, controller.signal);
        return json(res, 200, result);
      } finally { analyzing = false; }
    }
    json(res, 404, { error: "Not found", code: "NOT_FOUND" });
  } catch (error) {
    const aborted = controller.signal.aborted || error.name === "AbortError";
    json(res, aborted ? 504 : error.status || 500, {
      error: aborted ? "The request was cancelled or exceeded its time limit." : error instanceof AppError ? error.message : "An unexpected local error occurred.",
      code: aborted ? "REQUEST_CANCELLED" : error.code || "INTERNAL_ERROR", ...(error.details || {})
    });
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, host, () => console.log(`IBKR Options Advisor: http://${host}:${server.address().port}`));
server.on("error", error => {
  console.error(error.code === "EADDRINUSE" ? "Advisor port is in use. Stop the existing advisor or select a different PORT." : "Advisor could not start.");
  process.exitCode = 1;
});
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => { stopKeepAlive(); server.close(); server.closeAllConnections(); });

async function analyze(input, signal) {
  if (input.question !== undefined) validateQuestion(input.question, { allowEmpty: true });
  if (input.scan_ideas !== undefined && typeof input.scan_ideas !== "boolean") throw new AppError("INVALID_SETTINGS", "Candidate screening must be on or off.");
  const ai = await resolveOpenAiSettings(input, openAiSettings);
  let sources = {}, sourceSettingsUnavailable = false;
  try { sources = await dataSettings.read(); } catch { sourceSettingsUnavailable = true; }
  const isTws = brokerMode(input, defaultBrokerMode) === "tws";
  if (isTws) stopKeepAlive();
  const tws = isTws ? await readTws(sources.tradier?.enabled ? { ...input, scan_ideas: false } : input, "portfolio", { signal }) : null;
  const ibkr = isTws ? null : await client(input, signal);
  const session = isTws ? { accounts: tws.accounts, brokerage: true, portfolio_initialized: true } : await inspectConnection(ibkr);
  const accounts = session.accounts;
  const accountId = chooseAccount(accounts, input.account_id);
  // IBKR requires this initialization before every portfolio session's first read.
  const portfolioAccounts = session.portfolio_initialized ? accounts : accountIds(await ibkr.request("GET", "portfolio/accounts"));
  if (!portfolioAccounts.includes(accountId)) throw new AppError("PORTFOLIO_ACCESS", "The selected account has no portfolio access in this session.", 403);
  const positions = isTws ? tws.positions : await readAllPositions(ibkr, accountId);
  if (isTws && tws.account_id !== accountId) throw new AppError("ACCOUNT_MISMATCH", "TWS returned another account.", 502);
  const validated = validatePositions(positions);
  if (validated.blocked) {
    return { ok: false, state: "validation_blocked", validation: validated.issues, data_sent_to_openai: null,
      option_position_count: validated.positions.filter(p => p.type === "OPT").length,
      advice: "Analysis stopped before contacting OpenAI.\n" + validated.issues.map(issue => `${issue.ref}: ${issue.message}`).join("\n") };
  }
  if (validated.positions.filter(p => p.type === "OPT").length > 40) throw new AppError("ANALYSIS_LIMIT", "This review supports at most forty option positions. No partial review was sent.", 422);
  const optional = async promise => {
    try { return await promise; }
    catch (error) {
      if (signal.aborted || ["IBKR_LOGIN_REQUIRED", "IBKR_ACCESS_DENIED"].includes(error.code)) throw error;
      return null;
    }
  };
  const [summary, orders, trades] = isTws ? [null, null, null] : await Promise.all([
    optional(ibkr.request("GET", `portfolio/${accountId}/summary`)),
    session.brokerage ? optional(ibkr.request("GET", "iserver/account/orders")) : null,
    session.brokerage ? optional(ibkr.request("GET", "iserver/account/trades", { days: 7 })) : null
  ]);
  let snapshots = isTws ? tws.quotes : session.brokerage ? await optional(readSnapshots(ibkr, validated.positions.map(p => p.conid), { signal })) || [] : [];
  if (new Set(snapshots.map(q => q?.conid)).size !== snapshots.length) throw new AppError("DUPLICATE_QUOTE", "Market snapshots contain duplicate contract IDs.", 502);
  const external = await marketData.collect(validated.positions, sources, { scanIdeas: input.scan_ideas === true, signal });
  if (sourceSettingsUnavailable) external.sources = [{ provider: "DATA_SOURCES", status: "SETTINGS_UNAVAILABLE" }];
  const merged = new Map(snapshots.map(q => [q.conid, q]));
  for (const row of external.quotes) {
    if (!validateQuote(merged.get(row.conid), Date.now(), undefined, { allowDelayed: isTws }).valid) merged.set(row.conid, row);
  }
  snapshots = [...merged.values()];
  const snapshot = buildVerifiedSnapshot(validated, snapshots, {
    openOrders: isTws ? tws.observed_open_order_count ?? null : Array.isArray(orders?.orders) && orders.snapshot === true ? orders.orders.length : null,
    recentTradeCount: isTws ? tws.executions?.length ?? null : Array.isArray(trades) ? trades.length : null,
    allowDelayed: isTws || external.quotes.length > 0, accountValues: isTws ? tws.account_values || [] : [],
    observedOpenOrders: isTws ? tws.observed_open_order_count ?? null : null
  });
  snapshot.account_summary = verifiedSummary(summary);
  snapshot.brokerage_connected = session.brokerage;
  snapshot.connection_source = isTws ? "TWS_READ_ONLY" : "CLIENT_PORTAL";
  if (isTws) snapshot.quote_time_basis = external.quotes.length ? "SOURCE_SPECIFIC_TIMESTAMPS_SEE_EACH_QUOTE" : "LOCAL_RECEIPT_TIME_NOT_EXCHANGE_TIMESTAMP";
  if (isTws) enrichReview(snapshot, { ...tws, quotes: snapshots });
  if (isTws) await enrichTwsMarketData(snapshot, tws, { signal });
  applyMarketData(snapshot, external);
  const fallback = snapshot.options.map(p => ({ ref: p.ref,
    action: p.allowed_actions.includes("CONDITIONAL_REVIEW") ? "CONDITIONAL_REVIEW" : "MANUAL_REVIEW", topics: ["EXPIRY", "LIQUIDITY", "COVERAGE"] }));
  const result = { ok: true, state: "verified_local", retrieved_at: snapshot.retrieved_at,
    option_position_count: snapshot.options.length, validation: validated.issues, verified_data: snapshot,
    advice: renderReview(snapshot, fallback), model: null, data_sent_to_openai: null };
  if (!session.brokerage) {
    result.state = "portfolio_only";
    result.advice = "Browser login and portfolio access succeeded. IBKR's brokerage connection is unavailable, so live quotes, price-dependent calculations and model analysis are paused.\n\n" + result.advice;
    return result;
  }
  if (!ai && snapshot.options.length && snapshot.options.every(position => position.allowed_actions.length === 1 && position.allowed_actions[0] === "MANUAL_REVIEW")) {
    result.state = "manual_review_required";
    return result;
  }
  if (!snapshot.options.length || !ai) {
    if (snapshot.options.some(p => p.flags.length)) result.state = "limited_review";
    return result;
  }
  let question = input.question?.trim() || "Review coverage and management risks in these option positions.";
  for (const secret of [...accounts, ai.openai_api_key, input.ibkr_bearer_token, ...Object.values(sources).map(s => s.key)].filter(Boolean)) question = question.replaceAll(secret, "[removed]");
  const body = strategyRequest(ai.openai_model, question, snapshot);
  if (Buffer.byteLength(JSON.stringify(body)) > 150_000) throw new AppError("CONTEXT_LIMIT", "Verified context exceeds the size limit; no partial snapshot was sent.", 422);
  result.data_sent_to_openai = body;
  try {
    const response = await openAiRequest(ai.openai_api_key, body, signal, isTws ? 45_000 : 75_000);
    let reviews = validateStrategyResponse(response, snapshot);
    const stale = Date.now() - Date.parse(snapshot.retrieved_at) > 600_000 || [...snapshot.options, ...(snapshot.candidates || [])].some(position =>
      [position.quote, position.underlying_quote].some(q => q && Date.now() - Date.parse(q.snapshot_updated_at) + (q.delay_upper_bound_seconds || 0) * 1000 > snapshot.quote_max_age_seconds * 1000) ||
      position.underlying_price && Date.now() - position.underlying_price.asof > snapshot.quote_max_age_seconds * 1000 ||
      position.broker_greeks && Date.now() - position.broker_greeks.asof > snapshot.quote_max_age_seconds * 1000 ||
      position.estimated_greeks && Date.now() - Date.parse(position.estimated_greeks.input_received_at) > snapshot.quote_max_age_seconds * 1000);
    if (stale) reviews = fallback;
    const reviewState = reviews.every(review => review.action === "MANUAL_REVIEW") ? "manual_review_required"
      : reviews.some(review => ["MANUAL_REVIEW", "CONDITIONAL_REVIEW"].includes(review.action)) || snapshot.options.some(p => p.flags.length) ? "limited_review" : "complete";
    Object.assign(result, { state: stale ? "snapshot_expired" : reviewState,
      advice: (stale ? "The snapshot aged while waiting for analysis. Refresh before making decisions.\n\n" : "") + renderReview(snapshot, reviews),
      model: ai.openai_model });
  } catch (error) {
    if (signal.aborted) throw error;
    result.state = "ai_unavailable";
    result.ai_error_code = error instanceof AppError ? error.code : "OPENAI_REQUEST_FAILED";
    result.ai_error = error instanceof AppError ? error.message : "Model analysis failed; the local report is still available.";
    result.advice = result.ai_error + "\n\n" + result.advice;
  }
  return result;
}

function verifiedSummary(raw) {
  const clean = {};
  for (const key of ["netliquidation", "totalcashvalue", "settledcash", "buyingpower", "maintmarginreq", "availablefunds"]) {
    const row = raw?.[key];
    const amount = decimal(row?.amount);
    if (amount && typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency)) clean[key] = { amount: amount.toString(), currency: row.currency };
  }
  return clean;
}

function chooseAccount(accounts, requested) {
  if (requested !== undefined && typeof requested !== "string") throw new AppError("INVALID_ACCOUNT", "Account ID must be text.");
  if (requested?.trim()) {
    if (!accounts.includes(requested.trim())) throw new AppError("INVALID_ACCOUNT", "Requested account is not present in the authenticated session.");
    return requested.trim();
  }
  if (accounts.length !== 1) throw new AppError("ACCOUNT_SELECTION_REQUIRED", `IBKR returned ${accounts.length} accounts; enter the account ID explicitly.`);
  return accounts[0];
}

async function openAiRequest(apiKey, body, signal, timeoutMs) {
  const base = new URL(openAiBase);
  const official = base.origin === "https://api.openai.com" && base.pathname.replace(/\/$/, "") === "/v1";
  const test = allowTests && ["localhost", "127.0.0.1"].includes(base.hostname) && base.protocol === "http:";
  if ((!official && !test) || base.username || base.password || base.search || base.hash) throw new AppError("OPENAI_URL", "OpenAI requests must use the official API.", 500);
  try {
    return await requestJson(buildUrl(base, "responses"), { method: "POST", timeoutMs, signal,
      headers: { Authorization: `Bearer ${apiKey}` }, body, errorMetadata: OPENAI_ERROR_METADATA });
  } catch (error) {
    if (error.upstreamStatus) throw openAiFailure(error);
    throw error;
  }
}

function stopKeepAlive(error = null) {
  keepAliveGeneration++;
  clearTimeout(keepAliveTimer);
  keepAliveTimer = null;
  keepAliveBase = null;
  lastKeepAliveError = error;
}
function startKeepAlive(base, brokerage) {
  stopKeepAlive();
  keepAliveBase = base;
  const generation = keepAliveGeneration;
  const tick = async () => {
    if (keepAliveGeneration !== generation) return;
    const signal = AbortSignal.timeout(25_000);
    try {
      const ibkr = await client({ ibkr_base_url: base }, signal);
      if (brokerage) {
        const reply = await ibkr.request("POST", "tickle", {}, {});
        const auth = reply?.iserver?.authStatus;
        if (!auth?.authenticated || !auth.connected || auth.competing) throw new AppError("IBKR_LOGIN_REQUIRED", "Gateway session ended.", 401);
      } else {
        if (!accountIds(await ibkr.request("GET", "portfolio/accounts")).length) throw new AppError("IBKR_LOGIN_REQUIRED", "Portfolio session ended.", 401);
      }
      if (keepAliveGeneration === generation) { keepAliveTimer = setTimeout(tick, 60_000); keepAliveTimer.unref(); }
    } catch (error) { if (keepAliveGeneration === generation) stopKeepAlive(error.code || "KEEPALIVE_FAILED"); }
  };
  keepAliveTimer = setTimeout(tick, 60_000);
  keepAliveTimer.unref();
}

function enforceLocalRequest(req) {
  const hosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
  if (!hosts.includes(req.headers.host)) throw new AppError("INVALID_HOST", "Local host header required.", 403);
  const origin = req.headers.origin;
  if (origin && !hosts.some(h => origin === `http://${h}`)) throw new AppError("CROSS_ORIGIN", "Cross-origin requests are not allowed.", 403);
  if (req.headers["sec-fetch-site"] === "cross-site") throw new AppError("CROSS_ORIGIN", "Cross-site requests are not allowed.", 403);
  if (req.method === "POST" && !String(req.headers["content-type"]).toLowerCase().startsWith("application/json")) throw new AppError("CONTENT_TYPE", "JSON content type is required.", 415);
}
function requireBrowserOrigin(req) {
  if (![`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`].includes(req.headers.origin)) {
    throw new AppError("CROSS_ORIGIN", "Open the local advisor to use or change saved settings.", 403);
  }
}
async function readJson(req, limit = 32_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new AppError("BODY_TOO_LARGE", "Request body too large.", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new AppError("INVALID_JSON", "Invalid JSON body."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("INVALID_BODY", "Request body must be an object.");
  return value;
}
async function sendFile(res, relative, contentType) {
  const data = await fs.readFile(path.join(root, relative));
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length });
  res.end(data);
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
}
function setSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
