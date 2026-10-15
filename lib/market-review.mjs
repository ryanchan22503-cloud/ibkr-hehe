import { decimal } from "./portfolio.mjs";
import { estimatedGreeks } from "./review-data.mjs";

export function applyMarketData(snapshot, data, now = Date.now()) {
  const cleanUnderlying = Object.fromEntries(Object.entries(data.underlyings).map(([symbol, { row, ...value }]) => [symbol, value]));
  snapshot.external_data = { sources: data.sources, market: data.market || null, collected_at: data.collected_at,
    underlyings: cleanUnderlying, earnings_calendar: data.earnings_calendar || null, news: data.news || null,
    calculation_status: data.calculation_status || null,
    limits: ["Public data does not verify settled cash, pending assignments, opening fills or adjusted deliverables.",
      "An empty calendar is not proof of no events. Fundamentals and headlines need primary-source review.",
      "At most four ETF chains and six daily histories per run. Company-universe screening is not implemented."] };
  for (const p of snapshot.options) {
    const market = data.positions[p.ref];
    p.external_quote_status = market?.status || "NOT_REQUESTED";
    p.liquidity = market?.liquidity ? { ...market.liquidity, source: "TRADIER" } : p.liquidity || null;
    if (p.quote && p.quote.greeks.delta === null && !p.estimated_greeks && market?.estimated_greeks) {
      p.estimated_greeks = estimatedGreeks({ estimated_greeks: market.estimated_greeks, source: "TRADIER" }, p.right, now);
      if (p.estimated_greeks) {
        if (!p.flags.includes("MODEL_GREEKS_ESTIMATED")) p.flags.push("MODEL_GREEKS_ESTIMATED");
        p.position_greeks_estimated = Object.fromEntries(["delta", "gamma", "theta", "vega"].map(k => [k,
          decimal(p.estimated_greeks[k]).times(p.quantity).times(p.multiplier).toFixed(6)]));
      }
    }
    const underlying = cleanUnderlying[p.label];
    p.reported_events = eventsFor(p, data, now);
    if (underlying?.type === "etf") p.earnings_applicability = "FUND_NOT_COMPANY_EARNINGS_STILL_REVIEW_DISTRIBUTIONS_AND_EVENTS";
  }
  if (data.screen.length) snapshot.screen = data.screen;
  if (data.candidates.length) snapshot.candidates = data.candidates.map(p => {
    const q = p.quote, bid = decimal(q.bid), ask = decimal(q.ask), strike = decimal(p.strike);
    const days = Math.round((Date.parse(p.expiry) - Date.parse(new Date(now).toISOString().slice(0, 10))) / 86400000);
    const spread = ask.minus(bid).div(ask.plus(bid).div(2)).times(100);
    const model = estimatedGreeks({ estimated_greeks: p.estimated_greeks, source: "TRADIER" }, "P", now);
    const delta = decimal(model?.delta)?.abs();
    const events = eventsFor(p, data, now);
    return { ref: p.ref, label: p.label, symbol: p.symbol, expiry: p.expiry, strike: p.strike, currency: "USD", days,
      source: "TRADIER_OBSERVED_CHAIN_NOT_IBKR_QUALIFIED", status: "CONDITIONAL_RESEARCH_ONLY", quote: q,
      liquidity: p.liquidity, estimated_greeks: model, spread_pct: spread.toFixed(4),
      gross_premium_at_bid: bid.times(100).toFixed(4), assignment_cash_assuming_standard: strike.times(100).toFixed(4),
      simple_annualized_gross_yield_pct: days > 0 ? bid.div(strike).times(365).div(days).times(100).toFixed(4) : null,
      reported_events: events,
      blockers: [...(spread.gt(15) ? ["SPREAD_TOO_WIDE"] : spread.gt(10) ? ["SPREAD_CONDITIONAL"] : []),
        ...(delta ? delta.lt("0.15") || delta.gt("0.30") ? ["OUTSIDE_DELTA_ENTRY_RANGE"] : ["MODEL_DELTA_CONFIRM_IN_IBKR"] : ["DELTA_UNAVAILABLE"]),
        ...(p.liquidity.open_interest === null ? ["OPEN_INTEREST_UNAVAILABLE"] : p.liquidity.open_interest < 100 ? ["LOW_OPEN_INTEREST_REVIEW"] : []),
        "SIZE_UNITS_AND_OPEN_INTEREST_DATE_REVIEW", ...(events.length ? ["REPORTED_EVENT_INSIDE_CYCLE"] : []),
        "EVENT_CLEARANCE_UNVERIFIED", "FUNDING_AND_CONCENTRATION_REVIEW", "IBKR_CONTRACT_AND_DELIVERABLE_REVIEW"] };
  }).sort((a, b) => a.blockers.length - b.blockers.length).slice(0, 8);
  return snapshot;
}

function eventsFor(p, data, now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const earnings = (data.earnings_calendar?.events || []).filter(e => e.symbol === p.label).map(e => ({ type: e.type, date: e.date }));
  const dividends = (data.underlyings[p.label]?.research?.dividends?.upcoming || []).map(e => ({ type: "EX_DIVIDEND", date: e.ex_date, amount: e.amount }));
  return [...earnings, ...dividends].filter(e => e.date >= today && e.date <= p.expiry).slice(0, 12);
}

export function renderMarketData(snapshot) {
  const data = snapshot.external_data;
  if (!data) return null;
  const lines = ["DATA SOURCES"];
  const statuses = { KEY_REQUIRED: "Not configured. Add its key in Data sources.", DISABLED: "Saved, but disabled.",
    CONNECTED: "Connected.", KEY_OR_ENTITLEMENT_REJECTED: "Key or data permission rejected; check the selected environment.",
    PROVIDER_RATE_LIMIT: "Provider request limit reached.", PROVIDER_ACCESS_REQUIRED: "Provider requires a different permission or plan.",
    RUN_BUDGET_REACHED: "This run's request budget was used; other results remain available.", DAILY_BUDGET_REACHED: "Today's local request budget was used.",
    SETTINGS_UNAVAILABLE: "Saved data-source settings could not be opened." };
  for (const source of data.sources) lines.push(`${source.provider}: ${statuses[source.status] || source.status.toLowerCase().replaceAll("_", " ")}${source.feed === "DELAYED_15_MINUTES" ? " Quotes use the 15-minute delayed feed." : ""}`);
  if (data.market?.state) lines.push(`US market state from Tradier: ${data.market.state}; checked ${data.market.asof}. Closed-session quotes do not become fresh merely by fetching them again.`);
  for (const [symbol, row] of Object.entries(data.underlyings)) {
    if (row.quote) lines.push(`${symbol} underlying bid/ask: ${row.quote.bid} / ${row.quote.ask} USD; ${row.quote.data_type.toLowerCase()}, as of ${row.quote.snapshot_updated_at}.`);
    else lines.push(`${symbol}: ${row.status.toLowerCase().replaceAll("_", " ")}${row.last_quote_at ? "; last quote " + row.last_quote_at : ""}.`);
    if (row.history?.status === "CALCULATED") lines.push(`${symbol} daily indicators as of ${row.history.asof_date}: SMA50 ${row.history.sma50 ?? "unknown"}; SMA200 ${row.history.sma200 ?? "unknown"}; RSI14 ${row.history.rsi14}; ATR14 ${row.history.atr14}. Prior-date daily data, not an intraday signal.`);
    if (row.research) {
      const div = row.research.dividends;
      lines.push(`${symbol} dividends: ${div.upcoming ? div.upcoming.length ? div.upcoming.map(d => `ex-date ${d.ex_date}, reported amount ${d.amount} (currency not explicit)`).join("; ") : "no future declared distribution returned; NOT an event clearance" : div.status.toLowerCase().replaceAll("_", " ")}.`);
      const profile = row.research.profile;
      if (profile.values) lines.push(`${symbol} ${profile.type.toLowerCase()} profile from Alpha Vantage, fetched ${profile.retrieved_at}: ${Object.entries(profile.values).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`).join("; ") || "numeric fields unavailable"}. Provider units; not a verified valuation verdict.`);
      else lines.push(`${symbol} profile: ${profile.status.toLowerCase().replaceAll("_", " ")}.`);
    }
  }
  if (data.earnings_calendar) lines.push(data.earnings_calendar.events
    ? `Expected earnings calendar fetched ${data.earnings_calendar.retrieved_at}; ${data.earnings_calendar.events.length} matching reported events. No matching event is not proof of no upcoming event.`
    : `Earnings calendar: ${data.earnings_calendar.status.toLowerCase().replaceAll("_", " ")}.`);
  if (data.news?.articles) for (const article of data.news.articles) lines.push(`Research headline (${article.published || "date unavailable"}): ${article.title}${article.url ? " " + article.url : ""}`);
  if (data.calculation_status) lines.push(`Local calculations: ${data.calculation_status.toLowerCase().replaceAll("_", " ")}.`);
  return lines.join("\n");
}
