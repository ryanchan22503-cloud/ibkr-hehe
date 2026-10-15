import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { requestJson } from "./transport.mjs";
import { decimal, validateQuote, QUOTE_MAX_AGE_MS } from "./portfolio.mjs";
import { AppError } from "./errors.mjs";
import { marketMath } from "./market-math.mjs";

const UNIVERSE = ["XLP", "XLF", "XLU", "XLE", "XLV", "XLI", "XLB", "XLC", "IWM", "EFA", "EEM", "TLT"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL = /^[A-Z]{1,6}$/;
const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const day = now => new Date(now).toISOString().slice(0, 10);
const isoDate = value => typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value)) && day(Date.parse(value)) === value;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const tokenHash = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw new AppError(code, "External market data did not pass validation.", 502); };

export function providerFailure(error) {
  if ([401, 403].includes(error.upstreamStatus)) return "KEY_OR_ENTITLEMENT_REJECTED";
  if (error.upstreamStatus === 429) return "PROVIDER_RATE_LIMIT";
  return ["INVALID_PROVIDER_DATA", "NO_DATA", "KEY_OR_ENTITLEMENT_REJECTED", "PROVIDER_RATE_LIMIT", "PROVIDER_ACCESS_REQUIRED", "DAILY_BUDGET_REACHED", "RUN_BUDGET_REACHED", "BUDGET_UNAVAILABLE", "MODEL_INPUTS_UNUSABLE"].includes(error.code)
    ? error.code : error.name === "AbortError" || error.name === "TimeoutError" ? "TIME_LIMIT_REACHED" : "PROVIDER_UNAVAILABLE";
}

export function occSymbol(position) {
  const strike = decimal(position.strike, { positive: true });
  if (!SYMBOL.test(position.label) || position.currency !== "USD" || position.multiplier !== 100 ||
      !["P", "C"].includes(position.right) || !isoDate(position.expiry) || !strike || !strike.times(1000).isInteger() || strike.times(1000).gt(99999999)) return null;
  return `${position.label}${position.expiry.slice(2).replaceAll("-", "")}${position.right}${strike.times(1000).toFixed(0).padStart(8, "0")}`;
}

export function normalizeTradierQuote(raw, expected, mode, now = Date.now()) {
  if (!raw) return { status: "QUOTE_UNAVAILABLE" };
  if (!raw || raw.symbol !== expected.symbol || !["sandbox", "live"].includes(mode)) return { status: "CONTRACT_MISMATCH" };
  if (expected.option) {
    const p = expected.option;
    if (raw.type !== "option" || raw.underlying !== p.label || raw.root_symbol !== p.label || raw.contract_size !== 100 ||
        raw.expiration_date !== p.expiry || raw.option_type !== (p.right === "P" ? "put" : "call") || !decimal(raw.strike)?.eq(p.strike)) return { status: "CONTRACT_MISMATCH" };
  } else if (!["stock", "etf"].includes(raw.type)) return { status: "SYMBOL_TYPE_UNSUPPORTED" };
  const dates = [raw.bid_date, raw.ask_date];
  if (dates.some(t => !Number.isSafeInteger(t) || t < 1e12 || t > now + 5000)) return { status: "QUOTE_TIMESTAMP_UNAVAILABLE" };
  const asof = Math.min(...dates);
  const row = { conid: expected.conid, 84: raw.bid, 86: raw.ask, 6509: mode === "sandbox" ? "D" : "R",
    _updated: asof, delay_upper_bound_seconds: 0, timestamp_basis: "PROVIDER_BID_ASK_TIMESTAMPS", source: "TRADIER",
    feed_delay_seconds: mode === "sandbox" ? 900 : 0 };
  // Provider timestamps already include feed delay. Never add another fifteen minutes.
  const quote = validateQuote(row, now, QUOTE_MAX_AGE_MS, { allowDelayed: true });
  const liquidity = { open_interest: integer(raw.open_interest), volume: integer(raw.volume), bid_size_reported: integer(raw.bidsize),
    ask_size_reported: integer(raw.asksize), size_units: "PROVIDER_REPORTED_VERIFY_LOT_UNITS", source: "TRADIER", retrieved_at: new Date(now).toISOString(),
    open_interest_asof: null };
  const type = raw.type;
  return { status: quote.valid ? "AVAILABLE" : quote.reason, row: quote.valid ? row : null,
    quote: quote.valid ? quote : null, liquidity, type,
    last_quote_at: new Date(asof).toISOString(), symbol: expected.symbol };
}

export function createDailyBudget(directory = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "IBKROptionsAdvisor")) {
  let pending = Promise.resolve();
  return async (key, now) => {
    const next = pending.then(async () => {
      if (!directory) fail("BUDGET_UNAVAILABLE");
      const filename = path.join(directory, "research-budget.v1.json");
      let stored = { date: day(now), keys: {} };
      try {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.size > 32000) fail("BUDGET_UNAVAILABLE");
        stored = JSON.parse(await fs.readFile(filename, "utf8"));
        if (!isoDate(stored.date) || !stored.keys || typeof stored.keys !== "object" || Array.isArray(stored.keys) ||
            Object.entries(stored.keys).some(([k, n]) => !/^[a-f0-9]{64}$/.test(k) || !Number.isSafeInteger(n) || n < 0 || n > 25)) fail("BUDGET_UNAVAILABLE");
        if (stored.date > day(now)) fail("BUDGET_UNAVAILABLE");
        if (stored.date < day(now)) stored = { date: day(now), keys: {} };
      } catch (error) { if (error.code !== "ENOENT") fail("BUDGET_UNAVAILABLE"); }
      const id = tokenHash(key);
      if ((stored.keys[id] || 0) >= 25) fail("DAILY_BUDGET_REACHED");
      stored.keys[id] = (stored.keys[id] || 0) + 1;
      const temp = filename + "." + randomUUID() + ".tmp";
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(temp, JSON.stringify(stored), { mode: 0o600, flag: "wx" });
        await fs.rename(temp, filename);
      } catch { fail("BUDGET_UNAVAILABLE"); }
      finally { await fs.unlink(temp).catch(() => {}); }
    });
    pending = next.catch(() => {});
    return next;
  };
}

export function createMarketDataService({ request = requestJson, calculate = marketMath, reserve = createDailyBudget() } = {}) {
  const cache = new Map();
  let rotation = 0;
  function client(setting, signal) {
    let calls = 0, unavailable = null;
    return async (endpoint, params = {}) => {
      signal.throwIfAborted();
      if (unavailable) fail(unavailable);
      let url, headers, textResponse = false, cacheKey, cached;
      if (setting.provider === "tradier") {
        if (!["markets/quotes", "markets/options/expirations", "markets/options/chains", "markets/history", "markets/clock"].includes(endpoint)) fail("INVALID_PROVIDER_DATA");
        if (++calls > 24) fail("RUN_BUDGET_REACHED");
        url = new URL(`/v1/${endpoint}`, setting.mode === "sandbox" ? "https://sandbox.tradier.com" : "https://api.tradier.com");
        headers = { Authorization: `Bearer ${setting.key}`, Accept: "application/json" };
      } else {
        if (!["EARNINGS_CALENDAR", "DIVIDENDS", "OVERVIEW", "ETF_PROFILE", "NEWS_SENTIMENT"].includes(endpoint)) fail("INVALID_PROVIDER_DATA");
        cacheKey = `${tokenHash(setting.key)}:${endpoint}:${JSON.stringify(params)}`;
        cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.at < 6 * 3600000 && Date.now() >= cached.at) return { ...cached, cached: true };
        if (calls >= 3) fail("RUN_BUDGET_REACHED");
        await reserve(setting.key, Date.now());
        calls++;
        url = new URL("https://www.alphavantage.co/query");
        url.searchParams.set("function", endpoint);
        url.searchParams.set("apikey", setting.key);
        headers = { Accept: endpoint === "EARNINGS_CALENDAR" ? "text/csv, application/json" : "application/json" };
        textResponse = endpoint === "EARNINGS_CALENDAR";
      }
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      try {
        const body = await request(url, { headers, signal, retry: false, timeoutMs: 7000, maxBytes: 2000000, textResponse });
        let errorBody = body;
        if (textResponse && typeof body === "string" && body.trim().startsWith("{")) { try { errorBody = JSON.parse(body); } catch { fail("INVALID_PROVIDER_DATA"); } }
        if (errorBody?.Note) fail("PROVIDER_RATE_LIMIT");
        if (errorBody?.Information) fail(/rate|frequency|limit/i.test(errorBody.Information) ? "PROVIDER_RATE_LIMIT" : "PROVIDER_ACCESS_REQUIRED");
        if (errorBody?.["Error Message"] || errorBody?.errors) fail("INVALID_PROVIDER_DATA");
        const result = { body, at: Date.now(), cached: false };
        if (cacheKey) { if (cache.size >= 64) cache.delete(cache.keys().next().value); cache.set(cacheKey, result); }
        return result;
      } catch (error) {
        const status = providerFailure(error);
        if (["KEY_OR_ENTITLEMENT_REJECTED", "PROVIDER_RATE_LIMIT", "PROVIDER_ACCESS_REQUIRED"].includes(status)) unavailable = status;
        throw error;
      }
    };
  }
  async function attempt(work) {
    try { return await work(); } catch (error) { return { status: providerFailure(error) }; }
  }
  async function collect(positions, settings, { scanIdeas = false, signal: parentSignal, now = Date.now() } = {}) {
    const signal = AbortSignal.any([parentSignal || new AbortController().signal, AbortSignal.timeout(45000)]);
    const result = { sources: [], quotes: [], underlyings: {}, positions: {}, candidates: [], screen: [], scope: "BOUNDED_READ_ONLY_RESEARCH", collected_at: new Date(now).toISOString() };
    const options = positions.filter(p => p.type === "OPT");
    const held = [...new Set(positions.filter(p => p.currency === "USD" && SYMBOL.test(p.label)).map(p => p.label))];
    const symbols = [...new Set([...held, ...(scanIdeas ? UNIVERSE : [])])].slice(0, 52);
    const setting = settings.tradier;
    let tradier, quotes = new Map(), rawHistory = {}, modelRows = [];
    if (!setting?.enabled) result.sources.push({ provider: "TRADIER", status: setting ? "DISABLED" : "KEY_REQUIRED" });
    else {
      tradier = client(setting, signal);
      const requested = [...new Set([...symbols, ...options.map(occSymbol).filter(Boolean)])];
      const read = await attempt(async () => {
        const data = await tradier("markets/quotes", { symbols: requested.join(","), greeks: "false" });
        const rows = list(data.body?.quotes?.quote);
        if (!rows.length) fail("NO_DATA");
        if (rows.length > requested.length) fail("INVALID_PROVIDER_DATA");
        const map = new Map();
        for (const row of rows) {
          if (!requested.includes(row?.symbol) || map.has(row.symbol)) fail("INVALID_PROVIDER_DATA");
          map.set(row.symbol, row);
        }
        return { status: "CONNECTED", map };
      });
      result.sources.push({ provider: "TRADIER", status: read.status, feed: setting.mode === "sandbox" ? "DELAYED_15_MINUTES" : "LIVE_ENTITLEMENT_REQUIRED" });
      quotes = read.map || new Map();
      if (quotes.size) {
        const clock = await attempt(async () => {
          const { body } = await tradier("markets/clock");
          const c = body?.clock;
          if (!["open", "closed", "premarket", "postmarket"].includes(c?.state) || !Number.isFinite(c.timestamp) || Math.abs(Date.now() - c.timestamp * 1000) > 120000) fail("INVALID_PROVIDER_DATA");
          return { state: c.state, asof: new Date(c.timestamp * 1000).toISOString(), source: "TRADIER" };
        });
        result.market = clock;
      }
      for (const symbol of symbols) result.underlyings[symbol] = normalizeTradierQuote(quotes.get(symbol), { symbol }, setting.mode, now);
      const underlyingIds = new Map();
      for (const p of positions) {
        const conid = p.type === "STK" ? p.conid : p.underlying_conid;
        const row = result.underlyings[p.label]?.row;
        if (conid && row && !underlyingIds.has(conid)) underlyingIds.set(conid, { ...row, conid });
      }
      result.quotes.push(...underlyingIds.values());
      for (const p of options) {
        const symbol = occSymbol(p);
        const data = symbol ? normalizeTradierQuote(quotes.get(symbol), { symbol, option: p, conid: p.conid }, setting.mode, now) : { status: "SYMBOL_MAPPING_REQUIRES_REVIEW" };
        result.positions[p.ref] = data;
        if (data.row) result.quotes.push(data.row);
        const underlying = result.underlyings[p.label];
        const input = modelInput(p.ref, p, data, underlying);
        if (input) modelRows.push(input);
      }
      const selected = scanIdeas ? Array.from({ length: 4 }, (_, i) => UNIVERSE[(rotation + i) % UNIVERSE.length]) : [];
      if (scanIdeas) rotation = (rotation + 4) % UNIVERSE.length;
      for (const ticker of scanIdeas ? UNIVERSE : []) {
        const underlying = result.underlyings[ticker];
        if (!underlying?.quote) { result.screen.push({ ticker, status: underlying?.status || "QUOTE_UNAVAILABLE" }); continue; }
        if (!selected.includes(ticker)) { result.screen.push({ ticker, status: "CHAIN_NOT_SELECTED_THIS_RUN" }); continue; }
        const found = await attempt(async () => {
          const expirations = await tradier("markets/options/expirations", { symbol: ticker });
          const dates = list(expirations.body?.expirations?.date);
          if (dates.length > 200 || dates.some(d => !isoDate(d))) fail("INVALID_PROVIDER_DATA");
          const expiry = dates.filter(d => { const days = (Date.parse(d) - Date.parse(day(now))) / 86400000; return days >= 30 && days <= 50; })
            .sort((a, b) => Math.abs(Date.parse(a) - now - 40 * 86400000) - Math.abs(Date.parse(b) - now - 40 * 86400000))[0];
          if (!expiry) fail("NO_DATA");
          const chain = await tradier("markets/options/chains", { symbol: ticker, expiration: expiry, greeks: "false" });
          const rows = list(chain.body?.options?.option);
          if (rows.length > 5000) fail("INVALID_PROVIDER_DATA");
          const spot = decimal(underlying.quote.bid).plus(underlying.quote.ask).div(2);
          const seen = new Set();
          const valid = [];
          for (const row of rows) {
            if (row?.option_type !== "put") continue;
            const strike = decimal(row.strike, { positive: true });
            if (!strike || strike.lt(spot.times("0.80")) || strike.gt(spot)) continue;
            const p = { label: ticker, strike: strike.toString(), right: "P", expiry, currency: "USD", multiplier: 100 };
            const symbol = occSymbol(p);
            const q = normalizeTradierQuote(row, { symbol, option: p }, setting.mode, now);
            if (!q.quote || !decimal(q.quote.bid).gt(0) || seen.has(symbol)) continue;
            seen.add(symbol);
            valid.push({ ...p, ref: `tradier_${symbol}`, symbol, ...q });
          }
          // Model actual quoted strikes nearest 95% of spot, never synthesize contracts.
          valid.sort((a, b) => decimal(a.strike).minus(spot.times("0.95")).abs().cmp(decimal(b.strike).minus(spot.times("0.95")).abs()));
          for (const p of valid.slice(0, 4)) {
            result.candidates.push(p);
            const input = modelInput(p.ref, p, p, underlying);
            if (input) modelRows.push(input);
          }
          return { status: valid.length ? "QUOTED_CONTRACTS_RETURNED" : "NO_USABLE_CONTRACTS" };
        });
        result.screen.push({ ticker, status: found.status });
      }
      for (const symbol of [...new Set([...held, ...selected])].slice(0, 6)) {
        if (!quotes.has(symbol)) continue;
        const history = await attempt(async () => {
          const data = await tradier("markets/history", { symbol, interval: "daily", start: day(now - 500 * 86400000), end: day(now - 86400000) });
          const rows = list(data.body?.history?.day);
          if (!rows.length || rows.length > 500) fail("NO_DATA");
          rawHistory[symbol] = rows;
          return { status: "RETURNED" };
        });
        result.underlyings[symbol].history = history;
      }
    }
    const av = settings.alpha_vantage;
    if (!av?.enabled) result.sources.push({ provider: "ALPHA_VANTAGE", status: av ? "DISABLED" : "KEY_REQUIRED" });
    else {
      const research = client(av, signal);
      const calendar = await attempt(async () => {
        const data = await research("EARNINGS_CALENDAR", { horizon: "3month" });
        const parsed = await calculate({ action: "earnings_csv", csv: data.body, symbols, now }, { signal });
        return { status: parsed.status, events: parsed.events, retrieved_at: new Date(data.at).toISOString(), cached: data.cached };
      });
      result.earnings_calendar = calendar;
      result.sources.push({ provider: "ALPHA_VANTAGE", status: calendar.events ? "CONNECTED" : calendar.status, per_run_limit: 3, per_day_local_limit: 25 });
      for (const symbol of [...new Set([...held, ...result.candidates.map(p => p.label)])].slice(0, 6)) {
        result.underlyings[symbol] ||= { status: "QUOTE_UNAVAILABLE" };
        const researchData = {};
        researchData.dividends = await attempt(async () => {
          const data = await research("DIVIDENDS", { symbol });
          if (data.body?.symbol !== symbol || !Array.isArray(data.body.data) || data.body.data.length > 2000) fail("INVALID_PROVIDER_DATA");
          const records = data.body.data.filter(row => isoDate(row.ex_dividend_date) && decimal(row.amount, { nonnegative: true })).map(row => ({
            ex_date: row.ex_dividend_date, amount: decimal(row.amount).toString(), declaration_date: isoDate(row.declaration_date) ? row.declaration_date : null,
            payment_date: isoDate(row.payment_date) ? row.payment_date : null
          })).sort((a, b) => a.ex_date.localeCompare(b.ex_date));
          return { status: "REPORTED_DISTRIBUTIONS_NOT_COMPLETE_EVENT_CLEARANCE", upcoming: records.filter(r => r.ex_date >= day(now)).slice(0, 8),
            recent: records.filter(r => r.ex_date < day(now)).slice(-4), retrieved_at: new Date(data.at).toISOString(), source: "ALPHA_VANTAGE", currency: "NOT_EXPLICIT_IN_RESPONSE" };
        });
        const etf = result.underlyings[symbol].type === "etf";
        researchData.profile = await attempt(async () => {
          const data = await research(etf ? "ETF_PROFILE" : "OVERVIEW", { symbol });
          if (!data.body || typeof data.body !== "object" || etf && !Object.hasOwn(data.body, "net_assets") || !etf && data.body.Symbol !== symbol) fail("NO_DATA");
          const fields = etf ? ["net_assets", "net_expense_ratio", "dividend_yield", "portfolio_turnover"]
            : ["MarketCapitalization", "PERatio", "ForwardPE", "PEGRatio", "PriceToBookRatio", "ProfitMargin", "OperatingMarginTTM", "ReturnOnEquityTTM", "DividendYield", "Beta"];
          const values = Object.fromEntries(fields.map(k => [k, decimal(data.body[k])?.toString() ?? null]));
          return { status: "PROVIDER_REPORTED_REQUIRES_PRIMARY_VERIFICATION", type: etf ? "ETF" : "COMPANY", values,
            source: "ALPHA_VANTAGE", retrieved_at: new Date(data.at).toISOString(), fiscal_date: isoDate(data.body.LatestQuarter) ? data.body.LatestQuarter : null };
        });
        result.underlyings[symbol].research = researchData;
      }
      // Cached calendars/profiles leave room for news on later runs; never exceed the budget.
      result.news = await attempt(async () => {
        const tickers = [...new Set([...held, ...result.candidates.map(p => p.label)])].slice(0, 6);
        if (!tickers.length) fail("NO_DATA");
        const data = await research("NEWS_SENTIMENT", { tickers: tickers.join(","), sort: "LATEST", limit: 10 });
        if (!Array.isArray(data.body?.feed)) fail("INVALID_PROVIDER_DATA");
        return { status: "HEADLINES_NOT_EVENT_CLEARANCE", source: "ALPHA_VANTAGE", retrieved_at: new Date(data.at).toISOString(),
          articles: data.body.feed.slice(0, 10).map(a => ({ title: typeof a.title === "string" ? a.title.slice(0, 200) : "", published: /^\d{8}T\d{6}$/.test(a.time_published) ? a.time_published : null,
            url: safePublicLink(a.url) })) };
      });
    }
    if (modelRows.length || Object.keys(rawHistory).length) {
      // Optional network reads may exhaust their own deadline; preserve time for local math.
      const mathSignal = AbortSignal.any([parentSignal || new AbortController().signal, AbortSignal.timeout(15000)]);
      const math = await attempt(() => calculate({ options: modelRows.slice(0, 60), histories: rawHistory, now }, { signal: mathSignal }));
      for (const p of options) {
        const data = result.positions[p.ref];
        if (data && math.options?.[p.ref]?.status === "ESTIMATED") {
          data.estimated_greeks = math.options[p.ref];
          if (data.row) data.row.estimated_greeks = math.options[p.ref];
        }
      }
      for (const p of result.candidates) p.estimated_greeks = math.options?.[p.ref]?.status === "ESTIMATED" ? math.options[p.ref] : null;
      for (const [symbol, value] of Object.entries(math.history || {})) result.underlyings[symbol].history = value;
      if (math.status) result.calculation_status = math.status;
    }
    parentSignal?.throwIfAborted();
    return result;
  }
  return { collect,
    test: async (provider, settings, { signal } = {}) => {
      const setting = settings[provider];
      if (!setting?.enabled) return { provider, status: setting ? "DISABLED" : "KEY_REQUIRED" };
      const read = client(setting, signal || AbortSignal.timeout(15000));
      return attempt(async () => {
        if (provider === "tradier") {
          const data = await read("markets/quotes", { symbols: "XLP", greeks: "false" });
          const rows = list(data.body?.quotes?.quote);
          if (rows.length !== 1 || rows[0]?.symbol !== "XLP") fail("INVALID_PROVIDER_DATA");
          const q = normalizeTradierQuote(rows[0], { symbol: "XLP" }, setting.mode);
          return { provider, status: "CONNECTED", quote_status: q.status, last_quote_at: q.last_quote_at || null };
        }
        const data = await read("EARNINGS_CALENDAR", { horizon: "3month" });
        const parsed = await calculate({ action: "earnings_csv", csv: data.body, symbols: [], now: Date.now() }, { signal });
        if (!Array.isArray(parsed.events)) fail("INVALID_PROVIDER_DATA");
        return { provider, status: "CONNECTED", cached: data.cached };
      });
    }
  };
}

function modelInput(ref, p, option, stock) {
  if (!option?.quote || !stock?.quote) return null;
  const optionAt = Date.parse(option.quote.snapshot_updated_at), stockAt = Date.parse(stock.quote.snapshot_updated_at);
  if (Math.abs(optionAt - stockAt) > 120000) return null;
  return { ref, strike: p.strike, expiry: p.expiry, right: p.right,
    spot: decimal(stock.quote.bid).plus(stock.quote.ask).div(2).toString(), bid: option.quote.bid, ask: option.quote.ask, asof: Math.min(optionAt, stockAt) };
}

function safePublicLink(value) {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !["localhost", "127.0.0.1"].includes(u.hostname) ? u.href : null; }
  catch { return null; }
}
