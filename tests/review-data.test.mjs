import test from "node:test";
import assert from "node:assert/strict";
import { validatePositions, buildVerifiedSnapshot, verifiedAccountValues } from "../lib/portfolio.mjs";
import { enrichReview, orderReservations, recentExecutions, estimatedGreeks } from "../lib/review-data.mjs";
import { validateTwsReply } from "../lib/tws.mjs";
import { renderReview } from "../lib/strategy.mjs";

const now = Date.parse("2026-10-03T10:00:00Z");
const put = { accountId: "TEST", conid: 2, assetClass: "OPT", ticker: "TEST", position: -1, multiplier: 100,
  strike: 81, expiry: "20261016", right: "P", currency: "USD", undConid: 1 };
const balances = [
  { tag: "NetLiquidation", amount: "15000", currency: "SGD", source: "ACCOUNT_SUMMARY" },
  { tag: "NetLiquidation", amount: "15000", currency: "SGD", source: "ACCOUNT_UPDATES" },
  { tag: "SettledCash", amount: "10000", currency: "USD", source: "CURRENCY_LEDGER" },
  { tag: "ExchangeRate", amount: "1.3", currency: "USD", source: "CURRENCY_LEDGER" }
];
const raw = (changes = {}) => ({ ok: true, authenticated: true, complete: true, accounts: ["TEST"], account_id: "TEST",
  positions: [put], quotes: [], account_values: balances, orders: [], executions: [], observed_open_order_count: 0, ...changes });
function snapshot(data = raw()) {
  validateTwsReply(data, "portfolio");
  const result = buildVerifiedSnapshot(validatePositions(data.positions), data.quotes, {
    now, allowDelayed: true, accountValues: data.account_values, openOrders: data.observed_open_order_count });
  return enrichReview(result, data, now);
}

test("regression: updated TWS account-update and currency-ledger balances pass the whole review pipeline", () => {
  const result = snapshot();
  assert.equal(result.options.length, 1);
  assert.deepEqual(result.account_values, balances);
  const group = result.short_put_obligations[0];
  assert.equal(group.assignment_cash_assuming_standard, "8100.0000");
  assert.equal(group.cash_after_reported_obligations, "1900.0000");
  assert.equal(group.reported_funding_check, "SUFFICIENT_FOR_REPORTED_SCOPE");
  assert.notEqual(group.cash_security, "VERIFIED");
  assert.equal(result.options[0].short_put.profit_captured_pct, null);
  const report = renderReview(result, []);
  assert.match(report, /Missing opening credit does not block/);
  assert.match(report, /Current delta: UNKNOWN/);
  assert.match(report, /0\.35-0\.45/);
  assert.match(report, /1900\.0000 USD/);
  assert(!report.includes("TEST\":") && !report.includes("accountId"));
});

test("new balance sources still reject unknown sources, nonfinite values and duplicates", () => {
  for (const change of [{ source: "MYSTERY" }, { amount: null }, { amount: "NaN" }, { currency: "BASE" }]) {
    assert.throws(() => verifiedAccountValues([{ ...balances[2], ...change }]), { code: "INVALID_ACCOUNT_VALUES" });
  }
  assert.throws(() => verifiedAccountValues([balances[2], balances[2]]), { code: "INVALID_ACCOUNT_VALUES" });
});

test("settled cash is not inferred from currency totals, foreign currencies or conflicting readings", () => {
  for (const account_values of [[{ ...balances[2], tag: "CashBalance" }], [{ ...balances[2], currency: "SGD" }]]) {
    assert.equal(snapshot(raw({ account_values })).short_put_obligations[0].reported_funding_check, "UNVERIFIED");
  }
  const conflict = snapshot(raw({ account_values: [...balances, { ...balances[2], source: "USD_LEDGER", amount: "9999" }] }));
  assert.equal(conflict.short_put_obligations[0].reported_funding_check, "CONFLICTING_BALANCES");
});

test("order reserves keep currencies separate and unknown/complex orders fail closed", () => {
  const sell = { type: "OPT", right: "P", side: "SELL", quantity: "2", strike: "50", multiplier: "100", currency: "USD" };
  assert.deepEqual(orderReservations([sell]).by_currency, [{ currency: "USD", cash: "10000.0000" }]);
  for (const orders of [null, [{ ...sell, parent: true }], [{ ...sell, multiplier: 10 }], [{ ...sell, side: "BUY", order_type: "MKT" }]]) {
    assert.equal(orderReservations(orders).complete, false);
  }
  assert.equal(snapshot(raw({ orders: null })).short_put_obligations[0].reported_funding_check, "UNVERIFIED");
});

test("recent executions never become assumed original opening credit", () => {
  const row = { id: "test.1", conid: 2, side: "SLD", quantity: "1", price: "2.5", currency: "USD", multiplier: "100", fees: { amount: "1", currency: "USD" } };
  const result = recentExecutions([row], { conid: 2, multiplier: 100, currency: "USD" });
  assert.equal(result.sale_proceeds, "250.0000");
  assert.equal(result.opening_history_verified, false);
  assert.equal(recentExecutions([row, row], { conid: 2, multiplier: 100, currency: "USD" }).status, "INVALID_EXECUTIONS");
});

test("model Greeks require finite fresh inputs, valid put sign and remain explicitly estimated", () => {
  const estimated_greeks = { source: "LOCAL_QUANTLIB_BSM_ESTIMATE", input_received_at: now,
    delta: "-0.4", gamma: "0.02", theta: "-0.1", vega: "0.04", delta_low: "-0.45", delta_high: "-0.35", spot: "82", iv: "0.2" };
  for (const change of [{ input_received_at: NaN }, { input_received_at: now - 600001 }, { delta: "0.4" }, { iv: null }, { spot: "0" }]) {
    assert.equal(estimatedGreeks({ estimated_greeks: { ...estimated_greeks, ...change } }, "P", now), null);
  }
  const result = snapshot(raw({ quotes: [{ conid: 2, 84: "1", 86: "1.1", 6509: "R", _updated: now, estimated_greeks }] }));
  assert.equal(result.options[0].position_greeks_from_ibkr.delta, null);
  assert.equal(result.options[0].position_greeks_estimated.delta, "40.000000");
  assert.match(renderReview(result, []), /Position Greeks \(local estimates\)/);
  assert.match(renderReview(result, []), /model range is at or above the reassessment threshold/);
  assert.match(renderReview(result, []), /confirm the current broker delta/);
});

test("screening failures still render a report and do not synthesize contracts", () => {
  const result = snapshot(raw({ screen: [{ ticker: "XLP", status: "QUOTE_UNAVAILABLE" }], candidate_positions: [] }));
  assert.match(renderReview(result, []), /No qualified option candidates were returned/);
  assert.equal(result.options.length, 1);
});

test("delayed candidate quotes within the planning window retain delay and research-only status", () => {
  const result = snapshot(raw({ candidate_positions: [{ ...put, conid: 3 }],
    quotes: [{ conid: 3, 84: "1", 86: "1.1", 6509: "D", _updated: now, delay_upper_bound_seconds: 1200, 7308: "-0.2" }] }));
  assert.equal(result.candidates[0].quote.data_type, "DELAYED");
  assert.equal(result.candidates[0].gross_premium_at_bid, "100.0000");
  assert.equal(result.candidates[0].status, "CONDITIONAL_RESEARCH_ONLY");
});
