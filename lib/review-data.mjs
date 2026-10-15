import Decimal from "../vendor/decimal.mjs";
import { decimal, validatePositions, validateQuote, QUOTE_MAX_AGE_MS } from "./portfolio.mjs";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const money = v => new D(v).toFixed(4);

export function orderReservations(rows) {
  if (!Array.isArray(rows) || rows.length > 500) return { complete: false, by_currency: [], order_count: null };
  const totals = new Map();
  let complete = true;
  for (const row of rows) {
    if (["Cancelled", "ApiCancelled", "Filled"].includes(row?.status)) continue;
    const qty = decimal(row?.quantity, { positive: true });
    const price = decimal(row?.limit_price, { positive: true });
    const strike = decimal(row?.strike, { positive: true });
    const multiplier = decimal(row?.multiplier, { positive: true });
    if (!qty || !qty.isInteger() || !/^[A-Z]{3}$/.test(row?.currency) || !["BUY", "SELL"].includes(row?.side) || row.oca || row.parent) { complete = false; continue; }
    let reserve;
    if (row.side === "SELL" && row.type === "OPT" && row.right === "P" && multiplier?.eq(100) && strike) reserve = strike.times(100).times(qty);
    else if (row.side === "BUY" && row.order_type === "LMT" && price && (row.type === "STK" || row.type === "OPT" && multiplier?.eq(100))) reserve = price.times(qty).times(row.type === "STK" ? 1 : 100);
    else { complete = false; continue; }
    totals.set(row.currency, (totals.get(row.currency) || new D(0)).plus(reserve));
  }
  return { complete, order_count: rows.length, by_currency: [...totals].map(([currency, value]) => ({ currency, cash: money(value) })),
    basis: "CONSERVATIVE_FULL_ORDER_QUANTITIES_NO_NETTING_FEES_NOT_INCLUDED" };
}

export function estimatedGreeks(row, right, now) {
  const data = row?.estimated_greeks;
  if (!data || data.source !== "LOCAL_QUANTLIB_BSM_ESTIMATE" || typeof data.input_received_at !== "number" ||
      !Number.isFinite(data.input_received_at) || now - data.input_received_at > (["TRADIER", "IBKR_DATED_FIELDS"].includes(row.source) ? QUOTE_MAX_AGE_MS : 600000) || data.input_received_at > now + 5000) return null;
  const values = {};
  for (const key of ["delta", "gamma", "theta", "vega", "delta_low", "delta_high", "spot", "iv"]) {
    const value = decimal(data[key]);
    if (!value) return null;
    values[key] = value.toString();
  }
  const low = right === "P" ? -1 : 0, high = right === "P" ? 0 : 1;
  if (["delta", "delta_low", "delta_high"].some(k => new D(values[k]).lt(low) || new D(values[k]).gt(high)) ||
      new D(values.delta_low).gt(values.delta) || new D(values.delta_high).lt(values.delta) ||
      new D(values.gamma).lt(0) || new D(values.vega).lt(0) || new D(values.iv).lte(0) || new D(values.iv).gt(5) || new D(values.spot).lte(0)) return null;
  return { ...values, source: data.source, input_received_at: new Date(data.input_received_at).toISOString(),
    ...(row.source === "IBKR_DATED_FIELDS" ? { input_source: "IBKR", iv_basis: data.iv_basis,
      assumptions: data.assumptions } : {}),
    ...(row.source === "TRADIER" ? { input_source: "TRADIER", iv_basis: "INVERTED_OBSERVED_BID_ASK_MID",
      assumptions: "European BSM approximation of American options; zero interest/dividend base case; IV fitted to observed bid/ask midpoint. Sensitivity includes quote width, IV +/-0.03, rates and yields 0-6%, plus delta 0.03. Discrete dividends and early exercise are not modelled. Not a confidence interval or assignment probability." } : {
    assumptions: row.source === "IBKR_DATED_FIELDS" ? data.assumptions : "European BSM approximation; zero interest/dividend base case. Delta sensitivity uses 0-6% rate/yield scenarios plus 0.03. Not a confidence interval or assignment probability." }) };
}

export function recentExecutions(rows, position) {
  if (!Array.isArray(rows)) return { status: "UNAVAILABLE", count: null };
  const relevant = rows.filter(row => row?.conid === position.conid);
  const seen = new Set();
  let sold = new D(0), bought = new D(0), credit = new D(0), debit = new D(0), fees = new D(0), feesComplete = true;
  for (const row of relevant) {
    const qty = decimal(row.quantity, { positive: true }), price = decimal(row.price, { nonnegative: true });
    const fee = decimal(row.fees?.amount);
    if (typeof row.id !== "string" || seen.has(row.id) || !qty?.isInteger() || !price || row.currency !== position.currency ||
        !decimal(row.multiplier)?.eq(position.multiplier) || !["SLD", "BOT"].includes(row.side)) return { status: "INVALID_EXECUTIONS", count: null };
    seen.add(row.id);
    const amount = qty.times(price).times(position.multiplier);
    if (row.side === "SLD") { sold = sold.plus(qty); credit = credit.plus(amount); }
    else { bought = bought.plus(qty); debit = debit.plus(amount); }
    if (!fee || row.fees.currency !== position.currency) feesComplete = false;
    else fees = fees.plus(fee);
  }
  return { status: relevant.length ? "RECENT_TRADES_ONLY" : "NO_TRADES_IN_AVAILABLE_LOG", count: relevant.length,
    sold_contracts: sold.toString(), bought_contracts: bought.toString(), sale_proceeds: money(credit), purchase_cost: money(debit),
    reported_fees: feesComplete && relevant.length ? money(fees) : null,
    opening_history_verified: false, reason: "A matching net quantity does not prove history starts before the position was opened." };
}

export function enrichReview(snapshot, data, now = Date.now()) {
  snapshot.order_reservations = orderReservations(data.orders);
  snapshot.collection_status = Object.fromEntries(Object.entries(data.collection_status || {}).filter(([key, value]) => ["summary", "cash_detail", "executions", "orders"].includes(key) && typeof value === "boolean"));
  snapshot.calendar = { status: data.calendar?.status === "RETURNED_REQUIRES_REVIEW" ? "RETURNED_REQUIRES_REVIEW" : "UNAVAILABLE",
    source: "IBKR_WSH", error_codes: (data.calendar?.error_codes || []).filter(Number.isInteger).slice(0, 10) };
  const qmap = new Map(data.quotes.map(q => [q.conid, q]));
  for (const position of snapshot.options) {
    position.recent_executions = recentExecutions(data.executions, position);
    position.estimated_greeks = position.quote && position.quote.greeks.delta === null ? estimatedGreeks(qmap.get(position.conid), position.right, now) : null;
    if (position.estimated_greeks) {
      position.flags.push("MODEL_GREEKS_ESTIMATED");
      position.position_greeks_estimated = Object.fromEntries(["delta", "gamma", "theta", "vega"].map(key => [key,
        new D(position.estimated_greeks[key]).times(position.quantity).times(position.multiplier).toFixed(6)]));
    }
  }
  for (const group of snapshot.short_put_obligations) {
    const settled = snapshot.account_values.filter(v => v.currency === group.currency && v.tag === "SettledCash" && ["CURRENCY_LEDGER", "USD_LEDGER"].includes(v.source));
    const distinct = new Set(settled.map(v => v.amount));
    const reserved = snapshot.order_reservations.by_currency.find(v => v.currency === group.currency)?.cash || "0";
    if (distinct.size === 1 && snapshot.order_reservations.complete && group.all_short_puts_included) {
      group.reported_settled_cash = settled[0].amount;
      group.observed_order_reservations = reserved;
      group.cash_after_reported_obligations = money(new D(settled[0].amount).minus(reserved).minus(group.assignment_cash_assuming_standard));
      group.reported_funding_check = new D(group.cash_after_reported_obligations).gte(0) ? "SUFFICIENT_FOR_REPORTED_SCOPE" : "SHORTFALL";
    } else group.reported_funding_check = distinct.size > 1 ? "CONFLICTING_BALANCES" : "UNVERIFIED";
    // Pending settlements, transfers and deliverable adjustments remain separate from this arithmetic.
    group.cash_security = "REQUIRES_FINAL_ACCOUNT_AND_DELIVERABLE_CHECK";
  }
  snapshot.screen = (data.screen || []).filter(v => /^[A-Z.]{1,10}$/.test(v?.ticker)).map(v => ({ ticker: v.ticker,
    status: ["CONTRACT_UNAVAILABLE", "QUOTE_UNAVAILABLE", "DELAY_EXCEEDS_POLICY", "CHAIN_NOT_SELECTED_THIS_RUN", "NO_QUALIFIED_CHAIN", "CONTRACTS_REQUESTED"].includes(v.status) ? v.status : "UNAVAILABLE" }));
  const validated = validatePositions(data.candidate_positions || []);
  snapshot.candidates = validated.blocked ? [] : validated.positions.filter(p => p.type === "OPT" && p.right === "P" && p.multiplier === 100).map(p => {
    const raw = qmap.get(p.conid), q = validateQuote(raw, now, QUOTE_MAX_AGE_MS, { allowDelayed: true });
    const days = Math.round((Date.parse(p.expiry + "T00:00:00Z") - Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z")) / 86400000);
    const model = q.valid && q.greeks.delta === null ? estimatedGreeks(raw, "P", now) : null;
    const spread = q.valid ? new D(q.ask).minus(q.bid).div(new D(q.ask).plus(q.bid).div(2)).times(100) : null;
    return { ref: `candidate_${p.conid}`, label: p.label, conid: p.conid, expiry: p.expiry, strike: p.strike, currency: p.currency,
      days, quote: q.valid ? q : null, estimated_greeks: model, spread_pct: spread?.toFixed(4) ?? null,
      gross_premium_at_bid: q.valid ? money(new D(q.bid).times(100)) : null,
      assignment_cash_assuming_standard: money(new D(p.strike).times(100)),
      status: "CONDITIONAL_RESEARCH_ONLY", blockers: [...(!q.valid ? [q.reason] : []), ...(spread?.gt(15) ? ["SPREAD_TOO_WIDE"] : []),
        ...(!q.valid || q.greeks.delta === null && !model ? ["DELTA_UNAVAILABLE"] : []), "OPEN_INTEREST_UNVERIFIED", "EVENTS_UNVERIFIED", "FUNDING_AND_CONCENTRATION_REVIEW", "DELIVERABLE_REVIEW"],
      source: "IBKR_QUALIFIED_CHAIN_NOT_A_TRADE_RECOMMENDATION" };
  });
  return snapshot;
}
