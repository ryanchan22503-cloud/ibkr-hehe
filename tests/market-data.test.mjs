import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMarketDataService, normalizeTradierQuote, occSymbol, createDailyBudget } from "../lib/market-data.mjs";
import { createDataSettingsStore } from "../lib/data-settings.mjs";
import { marketMath } from "../lib/market-math.mjs";
import { buildVerifiedSnapshot, validatePositions } from "../lib/portfolio.mjs";
import { enrichReview } from "../lib/review-data.mjs";
import { applyMarketData } from "../lib/market-review.mjs";
import { renderReview, strategyRequest } from "../lib/strategy.mjs";

const now = Date.now(), stamp = now - 900000;
const date = n => new Date(now + n * 86400000).toISOString().slice(0, 10);
const option = { ref: "position_1", label: "XLP", strike: "81", expiry: date(14), multiplier: 100, currency: "USD", right: "P", type: "OPT", conid: 20, underlying_conid: 10, quantity: "-1" };
const symbol = occSymbol(option);
const stockRow = ticker => ({ symbol: ticker, type: "etf", bid: 85, ask: 85.02, bid_date: stamp, ask_date: stamp, bidsize: 10, asksize: 11, volume: 20000 });
const optionRow = (p = option) => ({ symbol: occSymbol(p), type: "option", underlying: p.label, root_symbol: p.label, contract_size: 100,
  expiration_date: p.expiry, option_type: "put", strike: Number(p.strike), bid: 1, ask: 1.04, bid_date: stamp, ask_date: stamp,
  open_interest: 1200, volume: 150, bidsize: 10, asksize: 11 });
const settings = { tradier: { provider: "tradier", key: "secret-tradier", enabled: true, mode: "sandbox" },
  alpha_vantage: { provider: "alpha_vantage", key: "secret-alpha", enabled: true, mode: "live" } };

function history() {
  const rows = [];
  for (let i = 400; i >= 1; i--) {
    const d = new Date(now - i * 86400000);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const close = 85 + Math.sin(i / 10);
    rows.push({ date: d.toISOString().slice(0, 10), open: close, close, high: close + 1, low: close - 1 });
  }
  return rows;
}

test("Tradier contract identity, timestamps, delayed age and lot sizes are not guessed", () => {
  const expected = { symbol, option, conid: 20 };
  const good = normalizeTradierQuote(optionRow(), expected, "sandbox", now);
  assert.equal(good.status, "AVAILABLE");
  assert.equal(good.quote.source, "TRADIER");
  assert.equal(good.quote.timestamp_basis, "PROVIDER_BID_ASK_TIMESTAMPS");
  assert.equal(good.quote.delay_upper_bound_seconds, 0);
  assert.equal(good.quote.feed_delay_seconds, 900);
  assert.equal(good.liquidity.open_interest, 1200);
  for (const change of [{ underlying: "SPY" }, { root_symbol: "XLP1" }, { contract_size: 10 }, { strike: 82 }, { expiration_date: date(15) }, { symbol: "OTHER" }]) {
    assert.equal(normalizeTradierQuote({ ...optionRow(), ...change }, expected, "sandbox", now).status, "CONTRACT_MISMATCH");
  }
  for (const change of [{ bid_date: now + 10000 }, { ask_date: null }, { ask_date: stamp / 1000 }]) {
    assert.equal(normalizeTradierQuote({ ...optionRow(), ...change }, expected, "sandbox", now).status, "QUOTE_TIMESTAMP_UNAVAILABLE");
  }
  assert.equal(normalizeTradierQuote({ ...optionRow(), bid_date: now - 26 * 60000 }, expected, "sandbox", now).status, "STALE_OR_UNTIMED_QUOTE");
  assert.equal(normalizeTradierQuote({ ...optionRow(), ask: 0.9 }, expected, "sandbox", now).status, "INVALID_BID_ASK");
  assert.equal(occSymbol({ ...option, strike: "81.00001" }), null);
  assert.equal(occSymbol({ ...option, label: "XLP1" }), null);
});

test("network-free QuantLib reproduces known BSM values and rejects missing or inconsistent inputs", async () => {
  const future = date(365);
  const data = await marketMath({ now, options: [
    { ref: "golden", spot: 100, strike: 100, right: "C", expiry: future, bid: 7.96556, ask: 7.965575, asof: stamp },
    { ref: "bad", spot: null, strike: 100, right: "P", expiry: future, bid: 1, ask: 2, asof: stamp },
    { ref: "inconsistent", spot: 50, strike: 100, right: "P", expiry: future, bid: 1, ask: 2, asof: stamp }
  ] });
  assert.equal(data.options.golden.status, "ESTIMATED");
  assert(Math.abs(Number(data.options.golden.iv) - 0.2) < 0.00001);
  assert(Math.abs(Number(data.options.golden.delta) - 0.53982784) < 0.00001);
  assert(Number(data.options.golden.delta_low) < Number(data.options.golden.delta));
  assert(Number(data.options.golden.delta_high) > Number(data.options.golden.delta));
  assert.equal(data.options.bad.status, "MODEL_INPUTS_UNUSABLE");
  assert.equal(data.options.inconsistent.status, "MODEL_INPUTS_UNUSABLE");
});

test("complete connector-to-report pipeline uses fixture prices and real local calculations, never fictional IBKR IDs", async t => {
  const calls = [], reserved = [];
  const service = createMarketDataService({ reserve: async key => reserved.push(key), request: async (url, opts) => {
    calls.push({ origin: url.origin, path: url.pathname, params: Object.fromEntries(url.searchParams), headers: opts.headers });
    assert.equal(opts.retry, false);
    assert.equal(opts.method, undefined);
    if (url.hostname.includes("tradier")) {
      assert.equal(url.origin, "https://sandbox.tradier.com");
      assert.equal(opts.headers.Authorization, "Bearer secret-tradier");
      assert(url.pathname.startsWith("/v1/markets/"));
      if (url.pathname.endsWith("/quotes")) return { quotes: { quote: url.searchParams.get("symbols").split(",").map(s => s === symbol ? optionRow() : stockRow(s)) } };
      if (url.pathname.endsWith("/clock")) return { clock: { state: "open", timestamp: Math.floor(Date.now() / 1000) } };
      if (url.pathname.endsWith("/expirations")) return { expirations: { date: [date(35)] } };
      if (url.pathname.endsWith("/chains")) return { options: { option: [80, 81].map(strike => optionRow({ ...option, label: url.searchParams.get("symbol"), strike: String(strike), expiry: date(35) })) } };
      if (url.pathname.endsWith("/history")) return { history: { day: history() } };
      throw new Error("unexpected endpoint");
    }
    assert.equal(url.origin, "https://www.alphavantage.co");
    if (url.searchParams.get("function") === "EARNINGS_CALENDAR") return `symbol,name,reportDate\nXLP,"Example, Fund",${date(5)}\n`;
    if (url.searchParams.get("function") === "DIVIDENDS") return { symbol: "XLP", data: [{ ex_dividend_date: date(7), amount: "0.25", declaration_date: date(-1) }] };
    if (url.searchParams.get("function") === "ETF_PROFILE") return { net_assets: "1000000000", net_expense_ratio: "0.001", dividend_yield: "0.02" };
    throw new Error("research budget failed");
  } });
  const external = await service.collect([option], settings, { now, scanIdeas: true });
  assert.equal(reserved.length, 3);
  assert.equal(external.positions.position_1.status, "AVAILABLE");
  assert.equal(external.positions.position_1.estimated_greeks.status, "ESTIMATED");
  assert.equal(external.underlyings.XLP.history.status, "CALCULATED");
  assert.notEqual(external.underlyings.XLP.history.sma200, null);
  assert.equal(external.earnings_calendar.events.length, 1);
  assert.equal(external.news.status, "RUN_BUDGET_REACHED");
  const validated = validatePositions([{ conid: 20, assetClass: "OPT", ticker: "XLP", position: -1, multiplier: 100, strike: 81, expiry: option.expiry, undConid: 10, putOrCall: "P", currency: "USD" }]);
  const snapshot = buildVerifiedSnapshot(validated, external.quotes, { now, allowDelayed: true, openOrders: 0 });
  enrichReview(snapshot, { quotes: external.quotes, orders: [], executions: [] }, now);
  applyMarketData(snapshot, external, now);
  assert.equal(snapshot.options[0].gross_buyback_cost_at_ask, "104.0000");
  assert.equal(snapshot.options[0].short_put.opening_credit, null);
  assert.equal(snapshot.options[0].position_greeks_from_ibkr.delta, null);
  assert(Number(snapshot.options[0].position_greeks_estimated.delta) > 0);
  assert.equal(snapshot.candidates.length, 8);
  assert(snapshot.candidates.every(c => c.symbol && c.conid === undefined && c.status === "CONDITIONAL_RESEARCH_ONLY"));
  assert(snapshot.candidates.every(c => c.blockers.includes("FUNDING_AND_CONCENTRATION_REVIEW")));
  const report = renderReview(snapshot, [{ ref: "position_1", action: "MANUAL_REVIEW", topics: ["EXPIRY"] }]);
  assert.match(report, /Quote \(TRADIER\): delayed/);
  assert.match(report, /local estimate/);
  assert.match(report, /SMA200/);
  assert.match(report, /EX_DIVIDEND/);
  assert(!report.includes("Current delta: UNKNOWN"));
  assert(!report.includes("No qualified option candidates"));
  const ai = strategyRequest("test-model", "Review conditional delta rules", snapshot);
  const serialized = JSON.stringify({ external, snapshot, report, ai });
  assert(!serialized.includes("secret-tradier"));
  assert(!serialized.includes("secret-alpha"));
  assert(!calls.some(c => /accounts|orders|positions|trade/.test(c.path)));
  t.diagnostic(`Fixture report: buyback ${snapshot.options[0].gross_buyback_cost_at_ask}; model delta ${snapshot.options[0].estimated_greeks.delta}; SMA200 ${snapshot.external_data.underlyings.XLP.history.sma200}; ${snapshot.candidates.length} observed-chain candidates. Not live market data.`);
  const original = snapshot.options[0].estimated_greeks;
  snapshot.options[0].estimated_greeks = { ...original, delta: "-0.32", delta_low: "-0.42", delta_high: "-0.25" };
  const uncertain = renderReview(snapshot, [{ ref: "position_1", action: "MANUAL_REVIEW", topics: ["EXPIRY"] }]);
  assert.match(uncertain, /Trigger status is uncertain/);
  assert(!uncertain.includes("The delta reassessment threshold is not met"));
});

test("provider errors preserve IBKR review and never echo secrets", async () => {
  const service = createMarketDataService({ reserve: async () => {}, request: async url => {
    if (url.hostname.includes("tradier")) throw Object.assign(new Error("secret-tradier"), { upstreamStatus: 401 });
    return { Information: "secret-alpha rate limit" };
  } });
  const data = await service.collect([option], settings, { now });
  assert.equal(data.sources[0].status, "KEY_OR_ENTITLEMENT_REJECTED");
  assert.equal(data.sources[1].status, "PROVIDER_RATE_LIMIT");
  assert.deepEqual(data.quotes, []);
  assert(!JSON.stringify(data).includes("secret-"));
});

test("calendar caching is credential-separated and calls stay inside the local budget", async () => {
  let count = 0;
  const service = createMarketDataService({ reserve: async () => {}, request: async () => { count++; return "symbol,name,reportDate\n"; } });
  assert.equal((await service.test("alpha_vantage", settings)).status, "CONNECTED");
  assert.equal((await service.test("alpha_vantage", settings)).cached, true);
  assert.equal(count, 1);
  const changed = { ...settings, alpha_vantage: { ...settings.alpha_vantage, key: "different-secret" } };
  assert.equal((await service.test("alpha_vantage", changed)).status, "CONNECTED");
  assert.equal(count, 2);
});

test("daily budget survives recreation, rejects corrupt files and never saves plaintext credentials", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-market-budget-"));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); assert(path.basename(dir).startsWith("advisor-market-budget-")); await fs.rm(dir, { recursive: true, force: true }); });
  const reserve = createDailyBudget(dir);
  for (let i = 0; i < 25; i++) await reserve("secret-alpha", now);
  await assert.rejects(createDailyBudget(dir)("secret-alpha", now), { code: "DAILY_BUDGET_REACHED" });
  assert(!(await fs.readFile(path.join(dir, "research-budget.v1.json"), "utf8")).includes("secret-alpha"));
  await fs.writeFile(path.join(dir, "research-budget.v1.json"), "invalid");
  await assert.rejects(reserve("secret-alpha", now), { code: "BUDGET_UNAVAILABLE" });
});

test("data-source credentials preserve other keys and metadata never exposes a secret", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-market-settings-"));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); assert(path.basename(dir).startsWith("advisor-market-settings-")); await fs.rm(dir, { recursive: true, force: true }); });
  const store = createDataSettingsStore({ directory: dir });
  const meta = await store.save(settings.tradier);
  assert.equal(meta.tradier.saved, true);
  assert(!JSON.stringify(meta).includes("secret-tradier"));
  await store.save(settings.alpha_vantage);
  await store.save({ ...settings.tradier, key: "", enabled: false });
  assert.equal((await store.read()).tradier.key, settings.tradier.key);
  assert.equal((await store.metadata()).tradier.enabled, false);
  assert(!(await fs.readFile(path.join(dir, "data-sources.v1.dpapi"))).includes(Buffer.from("secret-")));
  await assert.rejects(store.save({ ...settings.tradier, endpoint: "https://evil.example" }));
  await store.forget("tradier");
  assert.equal((await store.metadata()).alpha_vantage.saved, true);
  assert.equal((await store.metadata()).tradier.saved, false);
  await fs.writeFile(path.join(dir, "data-sources.v1.dpapi"), "corrupt");
  await assert.rejects(store.read(), { code: "DATA_SETTINGS_UNAVAILABLE" });
  assert.equal((await store.reset()).alpha_vantage.saved, false);
  assert.deepEqual(await store.read(), {});
});

test("cancellation stops provider reads instead of continuing background requests", async () => {
  const controller = new AbortController();
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let count = 0;
  const service = createMarketDataService({ request: async (url, opts) => {
    count++; started();
    return new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
  } });
  const read = service.collect([option], { tradier: settings.tradier }, { signal: controller.signal }).catch(error => error);
  await pending; controller.abort();
  assert.equal((await read).name, "AbortError");
  assert.equal(count, 1);
});
