"""Isolated, network-free market-data calculations. No keys or account identifiers."""
import csv
import io
import json
import math
import sys
from datetime import date, datetime, timezone, timedelta


def number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError("INVALID_NUMBER")
    result = float(value)
    if not math.isfinite(result) or not low <= result <= high:
        raise ValueError("INVALID_NUMBER")
    return result


def greeks(row, now):
    import QuantLib as ql
    spot = number(row["spot"], 0.000001, 1e7)
    strike = number(row["strike"], 0.000001, 1e7)
    stamp = number(row["asof"], now - 25 * 60 * 1000, now + 5000)
    basis = row.get("iv_basis", "INVERTED_OBSERVED_BID_ASK_MID")
    if basis not in ("INVERTED_OBSERVED_BID_ASK_MID", "IBKR_OPTION_MODEL_IV", "IBKR_UNDERLYING_30_DAY_IV_PROXY"):
        raise ValueError("INVALID_IV_BASIS")
    bid, ask = None, None
    if basis == "INVERTED_OBSERVED_BID_ASK_MID":
        bid, ask = number(row["bid"], 0, 1e7), number(row["ask"], 0.000001, 1e7)
    if (bid is not None and bid > ask) or row["right"] not in ("P", "C"):
        raise ValueError("INVALID_QUOTE")
    today = datetime.fromtimestamp(now / 1000, timezone.utc).date()
    expiry = date.fromisoformat(row["expiry"])
    if not 1 <= (expiry - today).days <= 730:
        raise ValueError("INVALID_EXPIRY")
    evaluation = ql.Date(today.day, today.month, today.year)
    maturity = ql.Date(expiry.day, expiry.month, expiry.year)
    ql.Settings.instance().evaluationDate = evaluation
    dc = ql.Actual365Fixed()
    volatility = ql.SimpleQuote(0.3)
    rate, dividend = ql.SimpleQuote(0), ql.SimpleQuote(0)
    process = ql.BlackScholesMertonProcess(
        ql.QuoteHandle(ql.SimpleQuote(spot)),
        ql.YieldTermStructureHandle(ql.FlatForward(evaluation, ql.QuoteHandle(dividend), dc)),
        ql.YieldTermStructureHandle(ql.FlatForward(evaluation, ql.QuoteHandle(rate), dc)),
        ql.BlackVolTermStructureHandle(ql.BlackConstantVol(evaluation, ql.NullCalendar(), ql.QuoteHandle(volatility), dc)))
    option = ql.VanillaOption(ql.PlainVanillaPayoff(ql.Option.Put if row["right"] == "P" else ql.Option.Call, strike), ql.EuropeanExercise(maturity))
    option.setPricingEngine(ql.AnalyticEuropeanEngine(process))
    iv = (option.impliedVolatility((bid + ask) / 2, process, 1e-8, 200, 0.0001, 5.0)
          if bid is not None else number(row["iv"], 0.0001, 5))
    volatility.setValue(iv)
    delta = option.delta()
    values = {"delta": delta, "gamma": option.gamma(), "theta": option.thetaPerDay(), "vega": option.vega() / 100,
              "iv": iv, "spot": spot}
    # Quote width, volatility and carry assumptions affect the range independently.
    proxy = basis == "IBKR_UNDERLYING_30_DAY_IV_PROXY"
    ivs = [iv, min(5, iv + 0.05)] if proxy else [max(0.0001, iv - 0.03), iv, min(5, iv + 0.03)]
    for price in (() if bid is None else (bid, ask)):
        try:
            ivs.append(option.impliedVolatility(price, process, 1e-8, 200, 0.0001, 5.0))
        except RuntimeError:
            pass
    deltas = [delta]
    for r in (0, 0.06):
        for q in (0, 0.06):
            for vol in ivs:
                rate.setValue(r)
                dividend.setValue(q)
                volatility.setValue(vol)
                deltas.append(option.delta())
    padding = 0.05 if proxy else 0.03
    values.update(delta_low=max(-1, min(deltas) - padding), delta_high=min(1, max(deltas) + padding))
    if row["right"] == "P":
        values["delta_high"] = min(0, values["delta_high"])
    else:
        values["delta_low"] = max(0, values["delta_low"])
    if not all(math.isfinite(v) for v in values.values()):
        raise ValueError("NONFINITE_MODEL")
    return {**{k: format(v, ".8f") for k, v in values.items()}, "input_received_at": stamp,
            "source": "LOCAL_QUANTLIB_BSM_ESTIMATE", "iv_basis": basis,
            "assumptions": ("Underlying 30-day IV is a proxy, not strike-specific IV; sensitivity spans proxy IV to IV+0.05 and delta padding 0.05. " if proxy else
                            "Sensitivity includes IV +/-0.03, observed quote width when available, and delta padding 0.03. ") +
                           "European BSM approximation of an American option; UTC calendar-day expiry; zero rate/dividend base case with 0-6% carry scenarios. Discrete dividends and early exercise are not modelled. Range is not a confidence interval or assignment probability."}


def indicators(rows, now, source="TRADIER"):
    import pandas as pd
    from ta.trend import SMAIndicator
    from ta.momentum import RSIIndicator
    from ta.volatility import AverageTrueRange
    if not isinstance(rows, list) or not 15 <= len(rows) <= 500:
        raise ValueError("HISTORY_UNAVAILABLE")
    today = datetime.fromtimestamp(now / 1000, timezone.utc).date()
    clean = []
    seen = set()
    for row in rows:
        day = date.fromisoformat(row["date"])
        if day >= today:
            continue
        if day in seen:
            raise ValueError("DUPLICATE_HISTORY")
        seen.add(day)
        values = {k: number(row[k], 0.000001, 1e9) for k in ("close", "high", "low", "open")}
        if values["high"] < max(values["low"], values["close"], values["open"]) or values["low"] > min(values["open"], values["close"]):
            raise ValueError("INVALID_HISTORY")
        clean.append({"date": day.isoformat(), **values})
    clean.sort(key=lambda r: r["date"])
    if len(clean) < 15 or (today - date.fromisoformat(clean[-1]["date"])).days > 7:
        raise ValueError("HISTORY_STALE_OR_SHORT")
    frame = pd.DataFrame(clean)
    close = frame["close"]
    values = {"sma50": SMAIndicator(close, 50).sma_indicator().iloc[-1] if len(clean) >= 50 else None,
              "sma200": SMAIndicator(close, 200).sma_indicator().iloc[-1] if len(clean) >= 200 else None,
              "rsi14": RSIIndicator(close, 14).rsi().iloc[-1],
              "atr14": AverageTrueRange(frame["high"], frame["low"], close, 14).average_true_range().iloc[-1]}
    if source not in ("TRADIER", "IBKR"):
        raise ValueError("INVALID_HISTORY_SOURCE")
    returns = (close / close.shift(1)).dropna().apply(math.log)
    values["historical_volatility_30d"] = returns.tail(30).std(ddof=1) * math.sqrt(252) if len(returns) >= 30 else None
    for weeks in (13, 26, 52):
        start = date.fromisoformat(clean[-1]["date"]) - timedelta(weeks=weeks)
        period = frame[frame["date"] >= start.isoformat()]
        sufficient = date.fromisoformat(clean[0]["date"]) <= start + timedelta(days=7)
        values[f"range_{weeks}w_low"] = period["low"].min() if sufficient else None
        values[f"range_{weeks}w_high"] = period["high"].max() if sufficient else None
    return {"asof_date": clean[-1]["date"], "bars": len(clean), "source": f"LOCAL_TA_FROM_{source}_DAILY_BARS",
            **{k: format(v, ".4f") if v is not None and math.isfinite(v) else None for k, v in values.items()},
            "limitations": "Completed prior-date daily bars only; corporate-action adjustment basis and missing sessions require review. Indicators do not establish support or a trade signal."}


def run(payload):
    now = number(payload.get("now"), 1e12, 1e14)
    if payload.get("action") == "earnings_csv":
        text = payload["csv"]
        symbols = payload["symbols"]
        if not isinstance(text, str) or len(text) > 2000000 or not isinstance(symbols, list) or len(symbols) > 60:
            raise ValueError("INVALID_CALENDAR")
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
        if not reader.fieldnames or not {"symbol", "reportDate"}.issubset(reader.fieldnames):
            raise ValueError("INVALID_CALENDAR")
        events = []
        for i, row in enumerate(reader):
            if i > 20000:
                raise ValueError("CALENDAR_TOO_LARGE")
            if row["symbol"] in symbols:
                events.append({"symbol": row["symbol"], "date": date.fromisoformat(row["reportDate"]).isoformat(), "type": "EXPECTED_EARNINGS"})
        return {"events": events[:200], "status": "REPORTED_CALENDAR_NOT_COMPLETENESS_PROOF"}
    rows = payload.get("options", [])
    histories = payload.get("histories", {})
    if not isinstance(rows, list) or len(rows) > 60 or not isinstance(histories, dict) or len(histories) > 6:
        raise ValueError("MATH_LIMIT")
    result = {"options": {}, "history": {}}
    for row in rows:
        try:
            result["options"][row["ref"]] = {"status": "ESTIMATED", **greeks(row, now)}
        except (ValueError, KeyError, TypeError, RuntimeError):
            result["options"][row.get("ref", "unknown")] = {"status": "MODEL_INPUTS_UNUSABLE"}
    for symbol, bars in histories.items():
        try:
            result["history"][symbol] = {"status": "CALCULATED", **indicators(bars, now, payload.get("history_source", "TRADIER"))}
        except (ValueError, KeyError, TypeError, RuntimeError, IndexError):
            result["history"][symbol] = {"status": "HISTORY_UNUSABLE"}
    return result


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(2500001)
        if len(raw) > 2500000:
            raise ValueError("INPUT_LIMIT")
        print(json.dumps({"ok": True, **run(json.loads(raw))}, allow_nan=False))
    except Exception:
        print(json.dumps({"ok": False, "code": "MARKET_MATH_UNAVAILABLE"}))
