import test from "node:test";
import assert from "node:assert/strict";
import { decimal, validatePositions, validateQuote, coveredCallMath, shortPutMath, verifiedAccountValues, buildVerifiedSnapshot } from "../lib/portfolio.mjs";
import { strategyRequest, validateStrategyResponse, renderReview } from "../lib/strategy.mjs";
import { checkConnection, inspectConnection, readAllPositions, readSnapshots } from "../lib/ibkr.mjs";

const now = Date.parse("2026-10-01T16:00:00Z");
const stock = { assetClass: "STK", conid: 1, ticker: "TEST", currency: "USD", position: 250, avgCost: 50 };
const call = { assetClass: "OPT", conid: 2, ticker: "TEST", currency: "USD", position: -1, multiplier: 100, strike: 55, expiry: "20261031", putOrCall: "C", undConid: 1 };
const quote = (conid, bid = "2", ask = "2.1") => ({ conid, 84: bid, 86: ask, 6509: "RpB", _updated: now, 7308: "0.4", 7309: "0.02", 7310: "-0.03", 7311: "0.12" });
const verified = () => buildVerifiedSnapshot(validatePositions([stock, call]), [quote(1, "52", "52.1"), quote(2)], { now, openOrders: 0 });
const response = reviews => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ reviews }) }] }] });

test("strict numbers reject null, booleans, prefixes, NaN, infinity and malformed separators", () => {
  for (const value of [null, undefined, true, false, "", " ", "NaN", Infinity, "1,23", "A1.2", "2%", {}, []]) assert.equal(decimal(value), null);
  assert.equal(decimal("1,234.50").toString(), "1234.5");
  assert.equal(decimal(0).toString(), "0");
});
test("missing stock cost basis and missing option multiplier block analysis", () => {
  for (const basis of [undefined, null, 0, -2, "NaN", ""]) assert.equal(validatePositions([{ ...stock, avgCost: basis }]).blocked, true);
  assert.equal(validatePositions([{ ...call, multiplier: undefined }]).blocked, true);
  assert.equal(validatePositions([{ ...call, expiry: "20260230" }]).blocked, true);
  for (const right of ["constructor", "__proto__", ["C"], true]) assert.equal(validatePositions([{ ...call, putOrCall: right }]).blocked, true);
});
test("odd and fractional lots preserve remainder without overcounting coverage", () => {
  const validated = validatePositions([{ ...stock, position: 150.5 }]);
  assert.equal(validated.blocked, false);
  assert.equal(validated.positions[0].whole_lots, 1);
  assert.equal(validated.positions[0].remainder_shares, "50.5");
  assert.equal(validated.issues[0].code, "ODD_LOT");
});
test("option validation identifies the missing field without guessing a replacement", () => {
  const result = validatePositions([{ ...call, undConid: null }]);
  assert.equal(result.blocked, true);
  assert.equal(result.positions.length, 0);
  assert.match(result.issues[0].message, /underlying ID/);
  assert(!result.issues[0].message.includes("strike"));
});
test("multiple short calls share one coverage pool", () => {
  const data = buildVerifiedSnapshot(validatePositions([{ ...stock, position: 100 }, call, { ...call, conid: 3 }]), [quote(2), quote(3)], { now, openOrders: 0 });
  for (const option of data.options) {
    assert.equal(option.coverage.total_short_call_share_requirement, "200");
    assert.equal(option.coverage.sufficient_assuming_standard_deliverables, false);
    assert.deepEqual(option.allowed_actions, ["MANUAL_REVIEW"]);
  }
});
test("nonstandard multiplier, currency mismatch and pending orders prevent sale calculations", () => {
  for (const changed of [{ ...call, multiplier: 10 }, { ...call, currency: "HKD" }]) {
    const data = buildVerifiedSnapshot(validatePositions([stock, changed]), [quote(1), quote(2)], { now, openOrders: 0 });
    assert.equal(data.options[0].hypothetical_new_sale, null);
    assert.equal(data.options[0].coverage, null);
  }
  for (const orders of [null, 1]) {
    const data = buildVerifiedSnapshot(validatePositions([stock, call]), [quote(1), quote(2)], { now, openOrders: orders });
    assert.equal(data.options[0].hypothetical_new_sale, null);
    assert.deepEqual(data.options[0].allowed_actions, ["MANUAL_REVIEW"]);
  }
});
test("quotes require real-time status, timestamps and a non-crossed market", () => {
  for (const change of [{ _updated: now - 1_500_001 }, { _updated: now + 5001 }, { _updated: null }, { 6509: "DpB" }, { 6509: "Z" }, { 84: 3, 86: 2 }, { 84: "" }, { 86: 0 }]) {
    assert.equal(validateQuote({ ...quote(2), ...change }, now).valid, false);
  }
  assert.equal(validateQuote({ ...quote(2), 84: 0 }, now).valid, true);
});
test("decimal covered-call math has explicit basis, annualization and fee assumptions", () => {
  const result = coveredCallMath({ shares: 250, contracts: 2, multiplier: 100, basis: 50, strike: 55, bid: 2, stockPrice: 52, days: 30 });
  assert.equal(result.gross_premium, "400.0000");
  assert.equal(result.premium_yield_on_basis_pct, "4.000000");
  assert.equal(result.annualized_premium_yield_on_basis_pct, "48.666667");
  assert.equal(result.premium_cushion_on_current_price_pct, "3.846154");
  assert.equal(result.expiry_breakeven_on_basis, "48.0000");
  assert.equal(result.max_expiry_profit_on_basis, "1400.0000");
  assert.equal(result.fees, "EXCLUDED");
  for (const changes of [{ shares: 199 }, { days: 0 }, { multiplier: 10 }, { basis: null }, { contracts: 0.5 }]) {
    assert.throws(() => coveredCallMath({ shares: 200, contracts: 2, multiplier: 100, basis: 50, strike: 55, bid: 2, stockPrice: 52, days: 30, ...changes }));
  }
});
test("Greeks use signed contract exposure and never synthesize missing values", () => {
  const data = verified();
  assert.deepEqual(data.options[0].position_greeks_from_ibkr, { delta: "-40.000000", gamma: "-2.000000", theta: "3.000000", vega: "-12.000000" });
  const missing = buildVerifiedSnapshot(validatePositions([stock, call]), [{ ...quote(2), 7308: undefined }], { now });
  assert.equal(missing.options[0].position_greeks_from_ibkr.delta, null);
  assert(data.options[0].flags.includes("OPENING_CREDIT_UNVERIFIED"));
});

test("short puts have a local exposure review without unsupported-scope or covered-call instructions", () => {
  const data = buildVerifiedSnapshot(validatePositions([stock, { ...call, putOrCall: "P" }]), [], { now });
  const option = data.options[0];
  assert.equal(option.coverage, null);
  assert.equal(option.hypothetical_new_sale, null);
  assert.deepEqual(option.allowed_actions, ["CONDITIONAL_REVIEW", "MANUAL_REVIEW"]);
  const text = renderReview(data, [{ ref: option.ref, action: "MANUAL_REVIEW", topics: ["COVERAGE", "COST_BASIS"] }]);
  assert.match(text, /Short-put risk review/);
  assert.match(text, /Cash-secured status is not assumed/);
  assert.match(text, /5500.0000 USD/);
  assert(!option.flags.includes("OUTSIDE_SHORT_WHEEL_SCOPE"));
  assert.match(text, /all short-put assignment obligations/);
  assert.match(text, /No option quote was returned/);
  assert.match(text, /Position Greeks: unavailable; no values have been estimated/);
  assert(!/all short calls|being called away|total short-call share requirement|"delta":null/.test(text));
});

test("short-put math never substitutes average cost for opening credit or counts margin as collateral", () => {
  const value = shortPutMath({ contracts: 2, multiplier: 100, strike: 50, ask: 1.25, days: 25 });
  assert.equal(value.assignment_cash_assuming_standard, "10000.0000");
  assert.equal(value.assignment_shares_assuming_standard, "200");
  assert.equal(value.gross_buyback_at_ask, "250.0000");
  assert.equal(value.remaining_annualized_premium_at_ask_pct, "36.500000");
  assert.equal(value.profit_captured_pct, null);
  assert.equal(value.net_acquisition_basis, null);
  assert.equal(value.cash_security, "UNVERIFIED");
  assert.equal(shortPutMath({ contracts: 1, multiplier: 100, strike: 50, days: 0 }).remaining_annualized_premium_at_ask_pct, null);
  for (const changed of [{ contracts: 0.5 }, { multiplier: 10 }, { strike: null }, { ask: -1 }, { days: NaN }]) {
    assert.throws(() => shortPutMath({ contracts: 1, multiplier: 100, strike: 50, ask: 1, days: 10, ...changed }));
  }
});

test("short-put obligations combine by currency without netting long puts or inventing settlement", () => {
  const put = { ...call, putOrCall: "P" };
  const values = [{ tag: "SettledCash", amount: "999999", currency: "SGD", source: "ACCOUNT_SUMMARY" },
    { tag: "CashBalance", amount: "9000", currency: "USD", source: "USD_LEDGER" }];
  const data = buildVerifiedSnapshot(validatePositions([put, { ...put, conid: 3, position: -2 }, { ...put, conid: 4, position: 1 },
    { ...put, conid: 5, multiplier: 10 }]), [], { now, accountValues: values, observedOpenOrders: 0 });
  assert.equal(data.short_put_obligations[0].assignment_cash_assuming_standard, "16500.0000");
  assert.equal(data.short_put_obligations[0].all_short_puts_included, false);
  assert.equal(data.short_put_obligations[0].cash_security, "UNVERIFIED");
  assert.equal(data.short_put_obligations[0].cash_after_reservations, null);
  assert.equal(data.open_order_count, null);
  for (const invalid of [[...values, values[0]], [{ ...values[0], amount: null }], [{ ...values[1], currency: "SGD" }]]) {
    assert.throws(() => verifiedAccountValues(invalid), { code: "INVALID_ACCOUNT_VALUES" });
  }
});

test("explicit delayed planning policy preserves source and rejects stale, frozen and mixed quotes", () => {
  const delayed = { ...quote(2), 6509: "D", delay_upper_bound_seconds: 1200, timestamp_basis: "LOCAL_RECEIPT_TIME_NOT_EXCHANGE_TIMESTAMP" };
  assert.equal(validateQuote(delayed, now).valid, false);
  const parsed = validateQuote(delayed, now, 1500000, { allowDelayed: true });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.data_type, "DELAYED");
  assert.equal(parsed.planning_only, true);
  for (const change of [{ 6509: "U" }, { 6509: "F" }, { _updated: now - 300001 }, { 84: 3, 86: 2 }, { delay_upper_bound_seconds: null }, { delay_upper_bound_seconds: -1 }]) {
    assert.equal(validateQuote({ ...delayed, ...change }, now, 1500000, { allowDelayed: true }).valid, false);
  }
  const data = buildVerifiedSnapshot(validatePositions([{ ...call, putOrCall: "P" }]), [delayed], { now, allowDelayed: true });
  const text = renderReview(data, []);
  assert.match(text, /delayed, planning only/);
  assert.match(text, /210.0000/);
  assert.match(text, /not exchange time/);
  assert.equal(data.options[0].short_put.profit_captured_pct, null);
});

test("market-data entitlement failures are explained without inventing quotes", () => {
  const data = buildVerifiedSnapshot(validatePositions([{ ...call, putOrCall: "P" }]), [{ conid: 2, 6509: "U", _updated: 0, error_codes: [354, 10091] }], { now, allowDelayed: true });
  const text = renderReview(data, []);
  assert.match(text, /IBKR reported API market-data access limits/);
  assert.match(text, /not a password error/);
  assert.equal(data.options[0].quote, null);
  assert.equal(data.options[0].gross_buyback_cost_at_ask, null);
});

test("long options are not described as short-call coverage or buyback obligations", () => {
  for (const putOrCall of ["P", "C"]) {
    const data = buildVerifiedSnapshot(validatePositions([stock, { ...call, putOrCall, position: 1 }]), [quote(2)], { now, openOrders: 0 });
    const option = data.options[0];
    assert.equal(option.coverage, null);
    assert.equal(option.hypothetical_new_sale, null);
    const text = renderReview(data, [{ ref: option.ref, action: "MANUAL_REVIEW", topics: ["COVERAGE", "COST_BASIS"] }]);
    assert(!/buyback cost|cash-secured|being called away|short calls|share requirement/i.test(text));
  }
});
test("numeric model text, foreign refs, forbidden actions and incomplete responses are blocked", () => {
  const data = verified();
  const good = { ref: "position_2", action: "MONITOR", topics: ["COVERAGE"] };
  assert.equal(validateStrategyResponse(response([good]), data).length, 1);
  for (const row of [null, { ...good, yield: 999 }, { ...good, action: "SELL NOW" }, { ...good, ref: "alien" }, { ...good, topics: ["Return is 999 percent"] }, { ...good, topics: [["COVERAGE"]] }, { ...good, topics: [] }]) {
    assert.throws(() => validateStrategyResponse(response([row]), data));
  }
  assert.throws(() => validateStrategyResponse(response([good, good]), data));
  assert.throws(() => validateStrategyResponse(null, data), { code: "AI_INCOMPLETE" });
  assert.throws(() => validateStrategyResponse({ ...response([good]), status: "incomplete" }, data));
  const request = strategyRequest("test-model", "Invent a yield", data);
  assert.equal(request.text.format.strict, true);
  assert.equal(request.store, false);
  assert.equal(request.tools, undefined);
  assert.match(renderReview(data, [good]), /48\.666667/);
});
test("pagination waits for an empty page and refuses malformed, duplicate or truncated portfolios", async () => {
  let calls = 0;
  const good = { request: async () => (++calls === 1 ? [{ conid: 1 }] : calls === 2 ? [{ conid: 2 }] : []) };
  assert.equal((await readAllPositions(good, "U123")).length, 2);
  await assert.rejects(readAllPositions({ request: async () => ({ error: "bad" }) }, "U123"));
  await assert.rejects(readAllPositions({ request: async () => [{ conid: 1 }] }, "U123"));
  let id = 0;
  await assert.rejects(readAllPositions({ request: async () => [{ conid: ++id }] }, "U123", 2), { code: "POSITION_LIMIT" });
});

test("connection states distinguish competing sessions and malformed authentication", async () => {
  for (const [status, code] of [
    [{ authenticated: true, connected: true, competing: true }, "IBKR_COMPETING_SESSION"],
    [{ authenticated: false, connected: true }, "IBKR_BROKERAGE_NOT_READY"],
    [{ authenticated: true }, "INVALID_AUTH_RESPONSE"]
  ]) await assert.rejects(checkConnection({ request: async () => status }), { code });
});
test("browser-only login initializes brokerage without taking over another session", async () => {
  const calls = [];
  let initialized = false;
  const mock = { request: async (method, endpoint, query, body) => {
    calls.push(endpoint);
    if (endpoint === "iserver/auth/ssodh/init") {
      assert.deepEqual(body, { publish: true, compete: false });
      initialized = true;
      return { authenticated: true, connected: true, competing: false };
    }
    if (endpoint === "iserver/accounts") return { accounts: ["U123"] };
    return { authenticated: initialized, connected: initialized, competing: false };
  } };
  assert.deepEqual(await checkConnection(mock), ["U123"]);
  assert.equal(calls.filter(path => path === "iserver/auth/ssodh/init").length, 1);
});

test("portfolio access survives brokerage rejection but not a malformed or failed portfolio response", async () => {
  const calls = [];
  const mock = { request: async (method, endpoint) => {
    calls.push(endpoint);
    if (endpoint === "portfolio/accounts") return [{ accountId: "U123" }];
    throw Object.assign(new Error("Session unavailable"), { code: "IBKR_LOGIN_REQUIRED" });
  } };
  const session = await inspectConnection(mock);
  assert.equal(session.brokerage, false);
  assert.equal(session.portfolio_initialized, true);
  assert.deepEqual(session.accounts, ["U123"]);
  assert.equal(calls[0], "portfolio/accounts");
  await assert.rejects(inspectConnection({ request: async () => ({ unexpected: true }) }), { code: "INVALID_ACCOUNTS" });
  await assert.rejects(inspectConnection({ request: async () => { throw Object.assign(new Error(), { code: "IBKR_LOGIN_REQUIRED" }); } }), { code: "IBKR_LOGIN_REQUIRED" });
});
test("market data preflight is followed by a bounded retrieval", async () => {
  let count = 0;
  const mock = { request: async (method, endpoint, query) => {
    assert.equal(method, "GET"); assert.match(query.fields, /7308/);
    return ++count === 1 ? [{ conid: 2 }] : [quote(2)];
  } };
  const rows = await readSnapshots(mock, [2]);
  assert.equal(count, 2); assert.equal(rows[0][84], "2");
});
test("share lot invariant holds across odd, fractional and short holdings", () => {
  for (let n = -200; n <= 550; n += 7.5) {
    const result = validatePositions([{ ...stock, position: n }]);
    if (!n) continue;
    const position = result.positions[0];
    assert(position.whole_lots * 100 <= Math.max(0, n));
    assert.equal(position.whole_lots * 100 + Number(position.remainder_shares), Math.max(0, n));
  }
});
