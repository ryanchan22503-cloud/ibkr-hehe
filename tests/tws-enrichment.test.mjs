import test from "node:test";
import assert from "node:assert/strict";
import { validatePositions, buildVerifiedSnapshot } from "../lib/portfolio.mjs";
import { enrichReview } from "../lib/review-data.mjs";
import { enrichTwsMarketData } from "../lib/tws-enrichment.mjs";
import { renderReview } from "../lib/strategy.mjs";
import { applyMarketData } from "../lib/market-review.mjs";
import { marketMath } from "../lib/market-math.mjs";

const now = Date.parse("2026-10-06T14:00:00Z");
const put = { conid: 2, assetClass: "OPT", ticker: "XLP", position: -1, multiplier: 100,
  strike: 81, expiry: "20261016", right: "P", currency: "USD", undConid: 1 };
const field = (value, extra = {}) => ({ value, received_at: now, data_type: 3, ...extra });
const underlying = (changes = {}) => ({ conid: 1, 84: "82", 86: "82.1", 6509: "D", _updated: now,
  delay_upper_bound_seconds: 1200, market_fields: { data_type: 3, fields: { underlying_iv_30d: field("0.25") } }, ...changes });
const native = (changes = {}) => ({ conid: 2, independent_greeks: { data_type: 3, received_at: now,
  values: { delta: "-0.4", gamma: "0.02", theta: "-0.1", vega: "0.2" }, ...changes },
  market_fields: { data_type: 3, fields: { put_open_interest: field("250"), volume: field("0"),
    bid_size: field("3"), ask_size: field("5") } } });
async function review(quotes, extra = {}, options = {}) {
  const data = { positions: [put], quotes, orders: [], executions: [], ...extra };
  const snapshot = buildVerifiedSnapshot(validatePositions(data.positions), quotes, { now, allowDelayed: true, openOrders: 0 });
  enrichReview(snapshot, data, now);
  await enrichTwsMarketData(snapshot, data, { now, ...options });
  return snapshot;
}

test("native Greeks survive missing bid/ask; settled funding and returns remain unknown", async () => {
  const s = await review([native(), underlying()]);
  const p = s.options[0];
  assert.equal(p.quote, null);
  assert.equal(p.broker_greeks.delta, "-0.4");
  assert.equal(p.position_greeks_from_ibkr.delta, "40.000000");
  assert.equal(p.moneyness.status, "OUT_OF_THE_MONEY");
  assert.equal(p.liquidity.volume, "0");
  assert.equal(p.liquidity.open_interest, "250");
  assert(p.allowed_actions.includes("CONDITIONAL_REVIEW"));
  assert.equal(p.short_put.profit_captured_pct, null);
  assert.notEqual(s.short_put_obligations[0].cash_security, "VERIFIED");
  const report = renderReview(s, [{ ref: p.ref, action: "CONDITIONAL_REVIEW", topics: ["EXPIRY"] }]);
  assert.match(report, /absolute option delta: 0.4000/);
  assert.match(report, /Underlying bid\/ask: 82 \/ 82.1/);
  assert.match(report, /IBKR reported open interest: 250; volume: 0/);
  assert.match(report, /This is not trade approval/);
});

test("frozen, stale, mixed and malformed independent fields are rejected", async () => {
  for (const changes of [{ data_type: 4 }, { data_type: null }, { received_at: now - 300001 },
    { received_at: now + 10000 }, { values: { delta: "0.4", gamma: "-1", theta: null, vega: "NaN" } }]) {
    const s = await review([native(changes)]);
    assert.equal(s.options[0].broker_greeks?.delta ?? null, null);
    assert.equal(s.options[0].estimated_greeks, null);
  }
  const row = native();
  row.market_fields.fields.volume = field("1.5");
  row.market_fields.fields.put_open_interest = field("-1");
  row.market_fields.fields.bid_size = field("10", { data_type: 1 });
  const s = await review([row]);
  assert.equal(s.options[0].liquidity.volume, null);
  assert.equal(s.options[0].liquidity.open_interest, null);
  assert.equal(s.options[0].liquidity.bid_size_reported, null);
});

test("real QuantLib estimate uses observed underlying IV proxy without inventing bid/ask", async () => {
  const s = await review([underlying()]);
  const p = s.options[0], g = p.estimated_greeks;
  assert(g && Number(g.delta) < 0 && Number(g.delta) > -1);
  assert.equal(g.iv_basis, "IBKR_UNDERLYING_30_DAY_IV_PROXY");
  assert(Number(g.delta_high) - Number(g.delta_low) >= .1 - 1e-8);
  assert.equal(g.input_received_at, new Date(now - 1200000).toISOString());
  assert.equal(p.quote, null);
  assert.equal(p.gross_buyback_cost_at_ask, null);
  assert.match(renderReview(s, []), /not strike-specific IV/);
});

test("native strike IV supports model calculation without a quote; stale inputs do not", async () => {
  const row = native({ values: {}, model_inputs: { iv: "0.3", spot: "82" } });
  const s = await review([row]);
  assert.equal(s.options[0].estimated_greeks.iv_basis, "IBKR_OPTION_MODEL_IV");
  const stale = await review([native({ received_at: now - 300001, values: {}, model_inputs: { iv: "0.3", spot: "82" } })]);
  assert.equal(stale.options[0].estimated_greeks, null);
});

test("no observed IV or prices means no estimate and no math request", async () => {
  let calls = 0;
  const s = await review([], {}, { calculate: async () => { calls++; throw Error(); } });
  assert.equal(calls, 0);
  assert.equal(s.options[0].estimated_greeks, null);
  assert.equal(s.options[0].data_availability.delta, "NOT_RETURNED_NO_VALID_MODEL_INPUTS");
  assert(s.options[0].allowed_actions.includes("CONDITIONAL_REVIEW"));
});

test("unconfigured external providers cannot erase IBKR liquidity", async () => {
  const s = await review([native()]);
  applyMarketData(s, { underlyings: {}, positions: {}, sources: [], screen: [], candidates: [] }, now);
  assert.equal(s.options[0].liquidity.open_interest, "250");
  assert.equal(s.options[0].liquidity.source, "IBKR");
});

test("TWS historical dates normalize and indicators retain IBKR provenance", async () => {
  const bars = Array.from({ length: 230 }, (_, i) => {
    const date = new Date(now - (230 - i) * 86400000).toISOString().slice(0, 10).replaceAll("-", "");
    return { date, open: 80 + i / 100, close: 80.5 + i / 100, low: 79 + i / 100, high: 81 + i / 100 };
  });
  const s = await review([], { history: { XLP: { status: "RETURNED", complete: true, bars } } });
  assert.equal(s.underlyings.XLP.history.status, "CALCULATED");
  assert.equal(s.underlyings.XLP.history.source, "LOCAL_TA_FROM_IBKR_DAILY_BARS");
  assert(s.underlyings.XLP.history.sma200);
  assert.match(renderReview(s, []), /Completed daily bars through 2026-10-05/);
});

test("incomplete history is not forwarded and calculation failure does not discard positions", async () => {
  let calls = 0;
  const s = await review([], { history: { XLP: { status: "RETURNED", complete: false, bars: [] } } }, {
    calculate: async () => { calls++; throw Error(); }
  });
  assert.equal(calls, 0);
  assert.equal(s.options.length, 1);
  const failure = await review([underlying()], {}, { calculate: async () => { throw Error(); } });
  assert.equal(failure.tws_calculation_status, "UNAVAILABLE");
  assert.equal(failure.options[0].estimated_greeks, null);
});

test("model rejects invented volatility basis and retains price-inversion support", async () => {
  const base = { ref: "p", spot: 82, strike: 81, expiry: "2026-10-16", right: "P", asof: now, bid: .5, ask: .6 };
  const out = await marketMath({ now, options: [base, { ...base, ref: "bad", iv_basis: "LLM_GUESS", iv: .3 }] });
  assert.equal(out.options.p.status, "ESTIMATED");
  assert.equal(out.options.p.iv_basis, "INVERTED_OBSERVED_BID_ASK_MID");
  assert.equal(out.options.bad.status, "MODEL_INPUTS_UNUSABLE");
});

test("historical IV and quotes use observation timestamps without counting the delay twice", async () => {
  const stamp = now - 1200000;
  const uq = underlying({ _updated: stamp, delay_upper_bound_seconds: 0, source: "IBKR_HISTORICAL_TICKS",
    timestamp_basis: "EXCHANGE_HISTORICAL_TICK_TIMESTAMP",
    market_fields: { data_type: 1, fields: { underlying_iv_30d: field("0.25", {
      observed_at: stamp, timestamp_basis: "IBKR_HISTORICAL" }) } } });
  const s = await review([uq]);
  assert(s.options[0].estimated_greeks);
  assert.equal(s.options[0].estimated_greeks.input_received_at, new Date(stamp).toISOString());
  assert.match(renderReview(s, []), /Observation time .*timestamp already includes the delay/);
  const stale = structuredClone(uq);
  stale.market_fields.fields.underlying_iv_30d.observed_at = now - 1500001;
  const rejected = await review([stale]);
  assert.equal(rejected.options[0].estimated_greeks, null);
});

test("valid delayed option prices unlock local price calculations, not unverified entry approval", async () => {
  const oq = { conid: 2, 84: "0.60", 86: "0.80", 6509: "D", _updated: now - 1200000,
    delay_upper_bound_seconds: 0, source: "IBKR_HISTORICAL_TICKS", timestamp_basis: "EXCHANGE_HISTORICAL_TICK_TIMESTAMP" };
  const s = await review([oq, underlying()]);
  assert.equal(s.options[0].gross_buyback_cost_at_ask, "80.0000");
  assert.equal(s.options[0].estimated_greeks.iv_basis, "INVERTED_OBSERVED_BID_ASK_MID");
  assert(s.options[0].flags.includes("CASH_SECURITY_UNVERIFIED"));
  assert(s.options[0].flags.includes("EVENT_CALENDAR_UNVERIFIED"));
  assert(!s.options[0].allowed_actions.some(a => /APPROVE|TRADE|SELL/.test(a)));
});

test("a dated last trade supports moneyness and IV-based delta, never a fabricated spread", async () => {
  const stamp = now - 1200000;
  const observed = value => field(value, { observed_at: stamp, timestamp_basis: "IBKR_HISTORICAL" });
  const row = { conid: 1, market_fields: { data_type: null, fields: {
    last: observed("82"), underlying_iv_30d: observed("0.25")
  } } };
  const s = await review([row]);
  const p = s.options[0];
  assert.equal(p.underlying_quote, null);
  assert.deepEqual(p.underlying_price, { value: "82", asof: stamp, basis: "LAST_TRADE" });
  assert.equal(p.moneyness.underlying_reference, "82.0000");
  assert.equal(p.moneyness.underlying_mid, undefined);
  assert.equal(p.estimated_greeks.iv_basis, "IBKR_UNDERLYING_30_DAY_IV_PROXY");
  assert.equal(p.gross_buyback_cost_at_ask, null);
  assert.match(renderReview(s, []), /Underlying reference price: 82 USD; last trade;/);
  const mismatched = structuredClone(row);
  mismatched.market_fields.fields.last.observed_at -= 180000;
  assert.equal((await review([mismatched])).options[0].estimated_greeks, null);
  row.market_fields.fields.last.observed_at = now - 1500001;
  const stale = (await review([row])).options[0];
  assert.equal(stale.underlying_price, null);
  assert.equal(stale.moneyness, null);
  assert.equal(stale.estimated_greeks, null);
});

test("native option-model spot is labelled as a model input, not an underlying quote", async () => {
  const s = await review([native({ model_inputs: { spot: "82", iv: "0.25" } })]);
  assert.equal(s.options[0].underlying_price.basis, "IBKR_OPTION_MODEL_UNDERLYING");
  assert.equal(s.options[0].underlying_quote, null);
  assert.equal(s.options[0].moneyness.status, "OUT_OF_THE_MONEY");
  const stale = await review([native({ received_at: now - 300001, model_inputs: { spot: "82", iv: "0.25" } })]);
  assert.equal(stale.options[0].underlying_price, null);
});
