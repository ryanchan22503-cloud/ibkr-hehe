import Decimal from "../vendor/decimal.mjs";
import { AppError } from "./errors.mjs";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const money = value => new D(value).toFixed(4);
const pct = value => new D(value).times(100).toFixed(6);
const numeric = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
export const QUOTE_MAX_AGE_MS = 25 * 60 * 1000;

export function decimal(value, { positive = false, nonnegative = false } = {}) {
  if ((typeof value !== "number" && typeof value !== "string") || !numeric.test(String(value))) return null;
  const number = new D(String(value).replaceAll(",", ""));
  if (!number.isFinite() || number.abs().gt("1e15") || positive && !number.gt(0) || nonnegative && number.lt(0)) return null;
  return number;
}

function id(value) {
  const n = decimal(value, { positive: true });
  return n?.isInteger() && n.lte(Number.MAX_SAFE_INTEGER) ? n.toNumber() : null;
}

function expiryDate(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const timestamp = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(iso) ? iso : null;
}

export function validatePositions(rows) {
  if (!Array.isArray(rows)) throw new AppError("INVALID_POSITIONS", "Positions must be an array.", 422);
  const positions = [];
  const issues = [];
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const ref = `position_${index + 1}`;
    const error = (code, message) => issues.push({ ref, severity: "error", code, message });
    const warning = (code, message) => issues.push({ ref, severity: "warning", code, message });
    if (!row || typeof row !== "object" || Array.isArray(row)) { error("INVALID_ROW", "Position must be an object."); continue; }
    const conid = id(row.conid);
    const quantity = decimal(row.position);
    if (!conid || !quantity) { error("INVALID_POSITION", "A valid contract ID and numeric position size are required."); continue; }
    if (seen.has(conid)) { error("DUPLICATE_POSITION", "Duplicate contract positions must be reconciled."); continue; }
    seen.add(conid);
    if (quantity.isZero()) continue;
    const type = row.assetClass || row.secType;
    if (!["STK", "OPT"].includes(type)) { warning("UNSUPPORTED_ASSET", "This asset is excluded from covered-call analysis."); continue; }
    if (typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) { error("MISSING_CURRENCY", "A contract currency is required; currency conversion is not assumed."); continue; }
    const label = typeof row.ticker === "string" && /^[A-Z0-9. -]{1,20}$/.test(row.ticker) ? row.ticker : `Contract ${conid}`;
    const norm = { ref, conid, type, label, currency: row.currency, quantity: quantity.toString() };
    if (type === "STK") {
      const cost = decimal(row.avgCost, { positive: true });
      if (!cost) { error("MISSING_STOCK_BASIS", "Stock cost basis is missing or invalid. Cost-based yields are blocked."); continue; }
      if (row.multiplier != null && !decimal(row.multiplier)?.eq(1)) { error("STOCK_MULTIPLIER", "Unexpected stock multiplier requires manual review."); continue; }
      norm.cost_basis_per_share = cost.toString();
      norm.whole_lots = quantity.gt(0) ? quantity.div(100).floor().toNumber() : 0;
      norm.remainder_shares = quantity.gt(0) ? quantity.mod(100).toString() : "0";
      if (!quantity.mod(100).isZero()) warning("ODD_LOT", "Only complete share lots can cover standard calls; the remainder is excluded.");
      if (quantity.lte(0)) warning("SHORT_STOCK", "A short stock position cannot cover a short call.");
    } else {
      const multiplier = decimal(row.multiplier, { positive: true });
      const strike = decimal(row.strike, { positive: true });
      const expiry = expiryDate(row.expiry);
      const rawRight = row.putOrCall || row.right;
      const right = typeof rawRight === "string" && ["C", "CALL", "P", "PUT"].includes(rawRight.toUpperCase()) ? rawRight[0].toUpperCase() : null;
      const underlying = id(row.undConid);
      const missing = [
        ["whole-contract quantity", quantity.isInteger()], ["multiplier", multiplier?.isInteger()],
        ["strike", strike], ["expiry", expiry], ["put/call right", right], ["underlying ID", underlying]
      ].filter(([, valid]) => !valid).map(([name]) => name);
      if (missing.length) {
        error("INCOMPLETE_OPTION", `Option data is missing or invalid: ${missing.join(", ")}. Analysis is blocked until IBKR supplies these fields.`); continue;
      }
      Object.assign(norm, { multiplier: multiplier.toNumber(), strike: strike.toString(), expiry, right, underlying_conid: underlying });
      if (!multiplier.eq(100)) warning("NONSTANDARD_MULTIPLIER", "Nonstandard contracts are excluded from standard covered-call calculations.");
    }
    positions.push(norm);
  }
  return { positions, issues, blocked: issues.some(issue => issue.severity === "error") };
}

export function validateQuote(row, now = Date.now(), maxAgeMs = QUOTE_MAX_AGE_MS, { allowDelayed = false } = {}) {
  if (!row || typeof row !== "object") return { valid: false, reason: "MISSING_QUOTE" };
  const updated = row._updated;
  if (row[84] == null || row[86] == null || updated === 0) return { valid: false, reason: "MISSING_QUOTE" };
  if (typeof updated !== "number" || !Number.isFinite(updated) || updated > now + 5000 || now - updated > maxAgeMs) return { valid: false, reason: "STALE_OR_UNTIMED_QUOTE" };
  const kind = typeof row[6509] === "string" ? row[6509][0] : "";
  if (kind !== "R" && !(allowDelayed && kind === "D")) return { valid: false, reason: "UNSUPPORTED_QUOTE_TYPE" };
  if (kind === "D") {
    const lag = row.delay_upper_bound_seconds;
    if (typeof lag !== "number" || !Number.isFinite(lag) || lag < 0 || now - updated + lag * 1000 > maxAgeMs) {
      return { valid: false, reason: "DELAY_EXCEEDS_POLICY" };
    }
  }
  const bid = decimal(row[84], { nonnegative: true });
  const ask = decimal(row[86], { positive: true });
  if (!bid || !ask || bid.gt(ask)) return { valid: false, reason: "INVALID_BID_ASK" };
  const greeks = {};
  for (const [key, field] of Object.entries({ delta: 7308, gamma: 7309, theta: 7310, vega: 7311 })) {
    const value = decimal(row[field]);
    greeks[key] = value && (key !== "delta" || value.abs().lte(1)) && (!["gamma", "vega"].includes(key) || value.gte(0)) ? value.toString() : null;
  }
  return { valid: true, bid: bid.toString(), ask: ask.toString(), snapshot_updated_at: new Date(updated).toISOString(), greeks,
    data_type: kind === "D" ? "DELAYED" : "REALTIME", planning_only: kind === "D",
    delay_upper_bound_seconds: kind === "D" ? row.delay_upper_bound_seconds : 0,
    source: ["TRADIER", "IBKR_HISTORICAL_TICKS"].includes(row.source) ? row.source : "IBKR",
    feed_delay_seconds: row.source === "TRADIER" && kind === "D" ? 900 : null,
    timestamp_basis: ["LOCAL_RECEIPT_TIME_NOT_EXCHANGE_TIMESTAMP", "PROVIDER_BID_ASK_TIMESTAMPS", "EXCHANGE_HISTORICAL_TICK_TIMESTAMP"].includes(row.timestamp_basis) ? row.timestamp_basis : "IBKR_SNAPSHOT_TIMESTAMP" };
}

export function verifiedAccountValues(rows) {
  if (!Array.isArray(rows) || rows.length > 200) throw new AppError("INVALID_ACCOUNT_VALUES", "Account balances were not returned in a valid form.", 502);
  const seen = new Set();
  return rows.map(row => {
    const amount = decimal(row?.amount);
    if (!amount || !["NetLiquidation", "SettledCash", "TotalCashValue", "CashBalance", "TotalCashBalance", "ExchangeRate"].includes(row.tag) ||
        !/^[A-Z]{3}$/.test(row.currency) || !["ACCOUNT_SUMMARY", "USD_LEDGER", "ACCOUNT_UPDATES", "CURRENCY_LEDGER"].includes(row.source) || row.source === "USD_LEDGER" && row.currency !== "USD") {
      throw new AppError("INVALID_ACCOUNT_VALUES", "Account balances contain invalid or ambiguous fields.", 502);
    }
    const key = `${row.source}:${row.tag}:${row.currency}`;
    if (seen.has(key)) throw new AppError("INVALID_ACCOUNT_VALUES", "Duplicate account balances need reconciliation.", 502);
    seen.add(key);
    return { tag: row.tag, currency: row.currency, amount: amount.toString(), source: row.source };
  });
}

export function shortPutMath({ contracts, multiplier, strike, ask = null, days }) {
  const count = decimal(contracts, { positive: true });
  const exercise = decimal(strike, { positive: true });
  const premium = ask === null ? null : decimal(ask, { positive: true });
  if (!count?.isInteger() || multiplier !== 100 || !exercise || !Number.isInteger(days) || ask !== null && !premium) {
    throw new AppError("INVALID_MATH_INPUT", "Short-put inputs are invalid or the contract is nonstandard.", 422);
  }
  const shares = count.times(multiplier);
  const obligation = exercise.times(shares);
  return {
    basis: "ASSUMES_STANDARD_SHARE_DELIVERABLE_REQUIRES_CONFIRMATION",
    assignment_shares_assuming_standard: shares.toString(),
    assignment_cash_assuming_standard: money(obligation),
    gross_buyback_at_ask: premium ? money(premium.times(shares)) : null,
    remaining_annualized_premium_at_ask_pct: premium && days > 0 ? pct(premium.div(exercise).times(365).div(days)) : null,
    annualization: "SIMPLE_ACT_365_CALENDAR_DAYS", fees: "EXCLUDED",
    opening_credit: null, profit_captured_pct: null, net_acquisition_basis: null,
    cash_security: "UNVERIFIED"
  };
}

// A hypothetical NEW sale. Portfolio average option cost is never treated as an opening fill.
export function coveredCallMath({ shares, contracts, multiplier, basis, strike, bid, stockPrice, days }) {
  const qty = decimal(shares, { positive: true });
  const count = decimal(contracts, { positive: true });
  const cost = decimal(basis, { positive: true });
  const exercise = decimal(strike, { positive: true });
  const premium = decimal(bid, { nonnegative: true });
  const spot = decimal(stockPrice, { positive: true });
  if (!qty || !count?.isInteger() || multiplier !== 100 || !cost || !exercise || !premium || !spot || !Number.isInteger(days) || days <= 0 || count.times(100).gt(qty)) {
    throw new AppError("INVALID_MATH_INPUT", "Covered-call inputs are incomplete, expired, or insufficiently covered.", 422);
  }
  const coveredShares = count.times(100);
  return {
    scenario: "HYPOTHETICAL_NEW_SALE_AT_BID", fees: "EXCLUDED", annualization: "SIMPLE_ACT_365_CALENDAR_DAYS",
    covered_shares: coveredShares.toString(), contracts: count.toString(), calendar_days_to_expiry: days,
    premium_per_share: money(premium), gross_premium: money(premium.times(coveredShares)),
    premium_yield_on_basis_pct: pct(premium.div(cost)),
    annualized_premium_yield_on_basis_pct: pct(premium.div(cost).times(365).div(days)),
    premium_cushion_on_current_price_pct: pct(premium.div(spot)),
    expiry_breakeven_on_basis: money(cost.minus(premium)),
    max_expiry_profit_on_basis: money(exercise.minus(cost).plus(premium).times(coveredShares))
  };
}

export function buildVerifiedSnapshot(validated, snapshots, { now = Date.now(), openOrders = null, recentTradeCount = null,
  allowDelayed = false, accountValues = [], observedOpenOrders = null } = {}) {
  const balances = verifiedAccountValues(accountValues);
  const quotes = new Map();
  const quoteErrors = new Map();
  for (const row of snapshots) {
    const conid = id(row?.conid);
    if (!conid || quotes.has(conid)) throw new AppError("DUPLICATE_QUOTE", "Market snapshots contain invalid or duplicate contract IDs.", 502);
    quotes.set(conid, validateQuote(row, now, QUOTE_MAX_AGE_MS, { allowDelayed }));
    quoteErrors.set(conid, Array.isArray(row.error_codes) ? row.error_codes.filter(code => Number.isInteger(code) && code >= 0 && code <= 100_000).slice(0, 10) : []);
  }
  const stocks = new Map(validated.positions.filter(p => p.type === "STK").map(p => [p.conid, { ...p, reserved: new D(0), coverage_unknown: false }]));
  for (const p of validated.positions) {
    if (p.type !== "OPT" || p.right !== "C" || new D(p.quantity).gte(0)) continue;
    const stock = stocks.get(p.underlying_conid);
    if (stock) {
      if (p.multiplier !== 100 || stock.currency !== p.currency) stock.coverage_unknown = true;
      else stock.reserved = stock.reserved.plus(new D(p.quantity).abs().times(100));
    }
  }
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  const options = validated.positions.filter(p => p.type === "OPT").map(p => {
    const q = quotes.get(p.conid) || { valid: false, reason: "MISSING_QUOTE" };
    if (q.valid && q.greeks.delta !== null && (p.right === "P" ? new D(q.greeks.delta).gt(0) : new D(q.greeks.delta).lt(0))) q.greeks.delta = null;
    const stock = stocks.get(p.underlying_conid);
    const stockQuote = quotes.get(p.underlying_conid);
    const days = Math.round((Date.parse(p.expiry + "T00:00:00Z") - today) / 86_400_000);
    const shortCall = p.right === "C" && new D(p.quantity).lt(0);
    const shortPut = p.right === "P" && new D(p.quantity).lt(0);
    const flags = ["OPENING_CREDIT_UNVERIFIED", "EVENT_CALENDAR_UNVERIFIED"];
    if (shortCall || shortPut) flags.push("DELIVERABLE_REQUIRES_CONFIRMATION");
    if (!q.valid) flags.push(q.reason);
    if (q.valid && q.data_type === "DELAYED") flags.push("DELAYED_PLANNING_QUOTE");
    if (p.multiplier !== 100) flags.push("NONSTANDARD_MULTIPLIER");
    if (days <= 0) flags.push("EXPIRY_DAY_OR_PAST");
    if (openOrders === null) flags.push("ORDERS_UNAVAILABLE");
    else if (openOrders > 0) flags.push("OPEN_ORDERS_REQUIRE_REVIEW");
    if (!shortCall && !shortPut) flags.push("OUTSIDE_SHORT_WHEEL_SCOPE");
    if (shortPut) flags.push("CASH_SECURITY_UNVERIFIED");
    const coverage = shortCall && stock && !stock.coverage_unknown && stock.currency === p.currency
      ? { shares: stock.quantity, total_short_call_share_requirement: stock.reserved.toString(),
          sufficient_assuming_standard_deliverables: new D(stock.quantity).gte(stock.reserved),
          available_standard_contracts_before_orders: D.max(0, new D(stock.quantity).minus(stock.reserved).div(100).floor()).toString() } : null;
    if (shortCall && (!coverage || !coverage.sufficient_assuming_standard_deliverables)) flags.push("COVERAGE_NOT_VERIFIED");
    let hypothetical = null;
    if (coverage && p.right === "C" && p.multiplier === 100 && q.valid && new D(q.bid).gt(0) && stockQuote?.valid && days > 0 && openOrders === 0 && new D(coverage.available_standard_contracts_before_orders).gte(1)) {
      hypothetical = coveredCallMath({ shares: new D(stock.quantity).minus(stock.reserved).toString(), contracts: 1, multiplier: 100,
        basis: stock.cost_basis_per_share, strike: p.strike, bid: q.bid, stockPrice: stockQuote.bid, days });
    }
    const greekExposure = {};
    for (const key of ["delta", "gamma", "theta", "vega"]) {
      const value = q.valid ? q.greeks[key] : null;
      greekExposure[key] = value === null ? null : new D(value).times(p.quantity).times(p.multiplier).toFixed(6);
    }
    const putExposure = shortPut && p.multiplier === 100 ? shortPutMath({ contracts: new D(p.quantity).abs().toString(),
      multiplier: p.multiplier, strike: p.strike, ask: q.valid ? q.ask : null, days }) : null;
    const hardReview = flags.some(f => !["OPENING_CREDIT_UNVERIFIED", "EVENT_CALENDAR_UNVERIFIED", "DELIVERABLE_REQUIRES_CONFIRMATION", "DELAYED_PLANNING_QUOTE", "CASH_SECURITY_UNVERIFIED"].includes(f));
    const conditionalReview = shortPut && p.multiplier === 100 && days > 0;
    return { ...p, calendar_days_to_expiry: days, flags, coverage,
      short_put: putExposure,
      quote_error_codes: quoteErrors.get(p.conid) || [],
      quote: q.valid ? q : null, position_greeks_from_ibkr: greekExposure,
      underlying_quote: stockQuote?.valid ? stockQuote : null,
      gross_buyback_cost_at_ask: q.valid && new D(p.quantity).lt(0) ? money(new D(q.ask).times(p.quantity).abs().times(p.multiplier)) : null,
      hypothetical_new_sale: hypothetical,
      allowed_actions: hardReview ? conditionalReview ? ["CONDITIONAL_REVIEW", "MANUAL_REVIEW"] : ["MANUAL_REVIEW"]
        : ["MONITOR", "REVIEW_EXIT", "REVIEW_ROLL", "CONDITIONAL_REVIEW", "MANUAL_REVIEW"] };
  });
  const obligations = new Map();
  for (const option of options.filter(p => p.right === "P" && new D(p.quantity).lt(0))) {
    const group = obligations.get(option.currency) || { total: new D(0), complete: true };
    if (option.short_put) group.total = group.total.plus(option.short_put.assignment_cash_assuming_standard);
    else group.complete = false;
    obligations.set(option.currency, group);
  }
  return { retrieved_at: new Date(now).toISOString(), validation: validated.issues,
    scope: "SHORT_PUT_AND_COVERED_CALL_RISK_REVIEW", quote_max_age_seconds: QUOTE_MAX_AGE_MS / 1000, expiry_day_basis: "UTC_CALENDAR_DATES_NOT_INTRADAY_TIME",
    account_values: balances, observed_open_order_count: observedOpenOrders,
    short_put_obligations: [...obligations].map(([currency, value]) => ({ currency, assignment_cash_assuming_standard: money(value.total),
      all_short_puts_included: value.complete, cash_security: "UNVERIFIED", cash_after_reservations: null })),
    open_order_count: openOrders, recent_trade_count: recentTradeCount,
    stocks: [...stocks.values()].map(({ reserved, coverage_unknown, ...stock }) => ({ ...stock, reserved_shares_assuming_standard_calls: reserved.toString(), coverage_unknown })),
    options };
}
