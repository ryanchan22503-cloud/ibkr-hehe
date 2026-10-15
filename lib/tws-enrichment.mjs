import { decimal, validateQuote, QUOTE_MAX_AGE_MS } from "./portfolio.mjs";
import { estimatedGreeks } from "./review-data.mjs";
import { marketMath } from "./market-math.mjs";

// Each field carries its own receipt time and feed delay. Missing bid/ask
// must not discard independently returned Greeks, IV or volume.
function dated(value, now) {
  if (!value || ![1, 3].includes(value.data_type) || !Number.isFinite(value.received_at)) return null;
  const historical = value.timestamp_basis === "IBKR_HISTORICAL" && Number.isFinite(value.observed_at);
  const stamp = historical ? value.observed_at : value.received_at;
  const lag = value.data_type === 3 && !historical ? 1_200_000 : 0;
  const age = now - stamp;
  if (age < -5000 || age + lag > QUOTE_MAX_AGE_MS) return null;
  return { asof: stamp - lag, received_at: new Date(value.received_at).toISOString(),
    data_type: value.data_type === 3 ? "DELAYED" : "REALTIME", delay_upper_bound_seconds: lag / 1000 };
}

function field(row, name, now, { integer = false, positive = false, max = 1e12 } = {}) {
  const raw = row?.market_fields?.fields?.[name];
  if (raw?.data_type !== row?.market_fields?.data_type && raw?.timestamp_basis !== "IBKR_HISTORICAL") return null;
  const stamp = dated(raw, now), value = decimal(raw?.value, { nonnegative: true });
  if (!stamp || !value || value.gt(max) || positive && value.lte(0) || integer && !value.isInteger()) return null;
  return { value: value.toString(), ...stamp, source: "IBKR" };
}

function nativeGreeks(raw, right, now) {
  const observation = raw?.independent_greeks;
  const stamp = dated(observation, now);
  if (!stamp) return null;
  const values = {};
  for (const key of ["delta", "gamma", "theta", "vega"]) {
    const value = decimal(observation.values?.[key]);
    values[key] = value && (key !== "delta" || (right === "P" ? value.gte(-1) && value.lte(0) : value.gte(0) && value.lte(1)))
      && (!["gamma", "vega"].includes(key) || value.gte(0)) ? value.toString() : null;
  }
  return { ...stamp, source: "IBKR_OPTION_MODEL", ...values };
}

function liquidity(row, right, now) {
  const fields = {
    open_interest: field(row, right === "P" ? "put_open_interest" : "call_open_interest", now, { integer: true }),
    volume: field(row, "volume", now, { integer: true }),
    bid_size_reported: field(row, "bid_size", now, { integer: true }),
    ask_size_reported: field(row, "ask_size", now, { integer: true })
  };
  return { source: "IBKR", ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value?.value ?? null])),
    observations: fields, open_interest_date: null, size_units: "OPTION_CONTRACTS",
    limitation: "Receipt time does not establish the open-interest business date." };
}

function quoteTime(q) {
  return Date.parse(q.snapshot_updated_at) - (q.delay_upper_bound_seconds || 0) * 1000;
}

export async function enrichTwsMarketData(snapshot, data, { now = Date.now(), signal, calculate = marketMath } = {}) {
  const quotes = new Map((data.quotes || []).map(q => [q.conid, q]));
  const positions = [...snapshot.options, ...(snapshot.candidates || [])];
  const candidateIds = new Map((data.candidate_positions || []).map(p => [p.conid, p.undConid]));
  snapshot.underlyings = {};
  const models = [], histories = {};
  for (const p of positions) {
    const raw = quotes.get(p.conid);
    const underlyingId = p.underlying_conid || candidateIds.get(p.conid);
    const underlying = quotes.get(underlyingId);
    const q = validateQuote(underlying, now, QUOTE_MAX_AGE_MS, { allowDelayed: true });
    const uq = q.valid ? q : null;
    const iv = field(underlying, "underlying_iv_30d", now, { positive: true, max: 5 });
    const last = field(underlying, "last", now, { positive: true });
    snapshot.underlyings[p.label] = { conid: underlyingId, quote: uq, last_trade: last, underlying_iv_30d: iv,
      historical_volatility_30d: field(underlying, "historical_volatility_30d", now, { positive: true, max: 5 }),
      history: { status: data.history?.[p.label]?.status === "RETURNED" && data.history?.[p.label]?.complete === true ? "AWAITING_CALCULATION" : "NOT_RETURNED",
        error_codes: (data.history?.[p.label]?.error_codes || []).filter(Number.isInteger).slice(0, 10) } };
    p.underlying_quote = uq;
    p.liquidity = liquidity(raw, p.right || "P", now);
    p.broker_greeks = nativeGreeks(raw, p.right || "P", now);
    // Rebuild estimates from independently dated inputs instead of retaining
    // a quote-coupled estimate from an older observation or feed.
    p.estimated_greeks = null;
    if (p.flags) p.flags = p.flags.filter(f => f !== "MODEL_GREEKS_ESTIMATED");
    if (p.position_greeks_from_ibkr && p.broker_greeks) {
      for (const key of ["delta", "gamma", "theta", "vega"]) {
        const value = decimal(p.broker_greeks[key]);
        if (value) p.position_greeks_from_ibkr[key] = value.times(p.quantity).times(p.multiplier).toFixed(6);
      }
    }
    const metadata = data.contract_metadata?.[p.conid];
    p.contract_verification = metadata?.conid === p.conid && metadata.status === "IBKR_QUALIFIED"
      ? { identity: "IBKR_QUALIFIED", deliverable: "NOT_VERIFIED" } : { identity: "NOT_RETURNED", deliverable: "NOT_VERIFIED" };
    const nativeStamp = dated(raw?.independent_greeks, now);
    const nativeSpot = decimal(raw?.independent_greeks?.model_inputs?.spot, { positive: true });
    p.underlying_price = uq ? { value: decimal(uq.bid).plus(uq.ask).div(2).toString(), asof: quoteTime(uq), basis: "BID_ASK_MIDPOINT" }
      : last ? { value: last.value, asof: last.asof, basis: "LAST_TRADE" }
      : nativeStamp && nativeSpot?.lte(1e7) ? { value: nativeSpot.toString(), asof: nativeStamp.asof, basis: "IBKR_OPTION_MODEL_UNDERLYING" } : null;
    const spot = decimal(p.underlying_price?.value);
    p.moneyness = spot ? { underlying_reference: spot.toFixed(4), strike_minus_underlying: decimal(p.strike).minus(spot).toFixed(4),
      status: decimal(p.strike).eq(spot) ? "AT_THE_MONEY" : (p.right || "P") === "P"
        ? decimal(p.strike).gt(spot) ? "IN_THE_MONEY" : "OUT_OF_THE_MONEY"
        : decimal(p.strike).lt(spot) ? "IN_THE_MONEY" : "OUT_OF_THE_MONEY",
      basis: p.underlying_price.basis } : null;
    if (p.quote?.greeks?.delta != null || p.broker_greeks?.delta != null) continue;
    const inputs = raw?.independent_greeks?.model_inputs;
    const stamp = dated(raw?.independent_greeks, now);
    const optionIv = decimal(inputs?.iv, { positive: true });
    const optionSpot = decimal(inputs?.spot, { positive: true });
    const base = { ref: p.ref, strike: p.strike, expiry: p.expiry, right: p.right || "P" };
    if (stamp && optionIv?.lte(5) && optionSpot && optionSpot.lte(1e7)) {
      models.push({ ...base, spot: optionSpot.toString(), iv: optionIv.toString(), asof: stamp.asof, iv_basis: "IBKR_OPTION_MODEL_IV" });
    } else if (p.quote && spot && Math.abs(quoteTime(p.quote) - p.underlying_price.asof) <= 120000) {
      models.push({ ...base, spot: spot.toString(), bid: p.quote.bid, ask: p.quote.ask, asof: Math.min(quoteTime(p.quote), p.underlying_price.asof) });
    } else if (iv && spot && Math.abs(iv.asof - p.underlying_price.asof) <= 120000) {
      models.push({ ...base, spot: spot.toString(), iv: iv.value, asof: Math.min(iv.asof, p.underlying_price.asof), iv_basis: "IBKR_UNDERLYING_30_DAY_IV_PROXY" });
    }
  }
  for (const [symbol, history] of Object.entries(data.history || {}).slice(0, 6)) {
    if (!/^[A-Z.]{1,10}$/.test(symbol) || history.status !== "RETURNED" || history.complete !== true || !Array.isArray(history.bars)) continue;
    histories[symbol] = history.bars.slice(0, 501).map(row => ({ ...row,
      date: /^\d{8}$/.test(row.date) ? row.date.slice(0, 4) + "-" + row.date.slice(4, 6) + "-" + row.date.slice(6, 8) : row.date }));
  }
  let math = { options: {}, history: {} };
  if (models.length || Object.keys(histories).length) {
    try {
      math = await calculate({ now, options: models, histories, history_source: "IBKR" }, { signal });
      snapshot.tws_calculation_status = "COMPLETED";
    } catch (error) {
      if (signal?.aborted) throw error;
      snapshot.tws_calculation_status = "UNAVAILABLE";
    }
  }
  for (const [symbol, history] of Object.entries(math.history || {})) {
    snapshot.underlyings[symbol] ||= { quote: null, last_trade: null };
    snapshot.underlyings[symbol].history = history;
  }
  for (const p of positions) {
    const model = math.options?.[p.ref];
    if (model?.status === "ESTIMATED") {
      p.estimated_greeks = estimatedGreeks({ estimated_greeks: model, source: "IBKR_DATED_FIELDS" }, p.right || "P", now);
      if (p.estimated_greeks && p.quantity) {
        p.position_greeks_estimated = Object.fromEntries(["delta", "gamma", "theta", "vega"].map(key => [key,
          decimal(p.estimated_greeks[key]).times(p.quantity).times(p.multiplier).toFixed(6)]));
        if (!p.flags.includes("MODEL_GREEKS_ESTIMATED")) p.flags.push("MODEL_GREEKS_ESTIMATED");
      }
    }
    if (p.blockers && (p.broker_greeks?.delta != null || p.estimated_greeks)) p.blockers = p.blockers.filter(v => v !== "DELTA_UNAVAILABLE");
    if (p.blockers && p.liquidity.open_interest !== null) p.blockers = p.blockers.filter(v => v !== "OPEN_INTEREST_UNVERIFIED").concat("OPEN_INTEREST_DATE_REVIEW");
    p.data_availability = {
      option_bid_ask: p.quote ? "RETURNED" : "NOT_RETURNED_OR_REJECTED",
      underlying_bid_ask: p.underlying_quote ? "RETURNED" : "NOT_RETURNED_OR_REJECTED",
      underlying_price: p.underlying_price ? p.underlying_price.basis : "NOT_RETURNED",
      delta: p.quote?.greeks?.delta != null || p.broker_greeks?.delta != null ? "IBKR_MODEL" : p.estimated_greeks ? "LOCAL_ESTIMATE" : "NOT_RETURNED_NO_VALID_MODEL_INPUTS",
      open_interest: p.liquidity.open_interest !== null ? "RETURNED_DATE_UNVERIFIED" : "NOT_RETURNED",
      volume: p.liquidity.volume !== null ? "RETURNED" : "NOT_RETURNED",
      bid_ask_sizes: p.liquidity.bid_size_reported !== null && p.liquidity.ask_size_reported !== null ? "RETURNED" : "NOT_RETURNED",
      daily_history: snapshot.underlyings[p.label]?.history?.status || "NOT_RETURNED",
      iv_percentile: "NOT_IMPLEMENTED_REQUIRES_IV_HISTORY",
      event_clearance: "NOT_VERIFIED",
      opening_credit: "NOT_VERIFIED_ONLY_NEEDED_FOR_RETURN_CALCULATIONS",
      settled_assignment_funding: "NOT_VERIFIED"
    };
  }
  return snapshot;
}
