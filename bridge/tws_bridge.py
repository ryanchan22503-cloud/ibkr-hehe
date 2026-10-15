"""One bounded, read-only TWS request using the official IBKR Python SDK."""
import contextlib
import copy
import io
import json
import logging
import re
import sys
import threading
import time
import datetime
from decimal import Decimal, InvalidOperation

logging.disable(logging.CRITICAL)


class BridgeError(Exception):
    pass


def number(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = Decimal(str(value))
        return format(result, "f") if result.is_finite() and abs(result) <= Decimal("1e15") else None
    except (InvalidOperation, ValueError):
        return None


def model_greeks(contract, inputs, now=None):
    """Planning estimate only; never infer a price or volatility from a target delta."""
    now = time.time() if now is None else now
    if not isinstance(inputs, dict):
        return None
    iv, spot, strike = (number(inputs.get("iv")), number(inputs.get("spot")), number(contract.strike))
    stamp = inputs.get("received_at")
    if not all((iv, spot, strike)) or not isinstance(stamp, (int, float)) or not 0 <= now * 1000 - stamp <= 600000:
        return None
    if not 0 < float(iv) <= 5 or not 0 < float(spot) <= 1e8 or not 0 < float(strike) <= 1e8 or contract.right not in ("C", "P"):
        return None
    try:
        import QuantLib as ql
        expiry = datetime.datetime.strptime(contract.lastTradeDateOrContractMonth, "%Y%m%d").date()
        today = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).date()
        days = (expiry - today).days
        if not 0 < days <= 730:
            return None
        qdate = lambda date: ql.Date(date.day, date.month, date.year)
        ql.Settings.instance().evaluationDate = qdate(today)
        dc = ql.Actual365Fixed()
        def option(rate, dividend):
            process = ql.BlackScholesMertonProcess(
                ql.QuoteHandle(ql.SimpleQuote(float(spot))),
                ql.YieldTermStructureHandle(ql.FlatForward(qdate(today), dividend, dc)),
                ql.YieldTermStructureHandle(ql.FlatForward(qdate(today), rate, dc)),
                ql.BlackVolTermStructureHandle(ql.BlackConstantVol(qdate(today), ql.NullCalendar(), float(iv), dc)))
            value = ql.VanillaOption(ql.PlainVanillaPayoff(ql.Option.Call if contract.right == "C" else ql.Option.Put, float(strike)), ql.EuropeanExercise(qdate(expiry)))
            value.setPricingEngine(ql.AnalyticEuropeanEngine(process))
            return value
        base = option(0, 0)
        deltas = [option(r, q).delta() for r in (0, .06) for q in (0, .06)]
        lower, upper = (-1, 0) if contract.right == "P" else (0, 1)
        return {"source": "LOCAL_QUANTLIB_BSM_ESTIMATE", "delta": number(base.delta()),
                "gamma": number(base.gamma()), "theta": number(base.thetaPerDay()), "vega": number(base.vega() / 100),
                "delta_low": number(max(lower, min(deltas) - .03)), "delta_high": number(min(upper, max(deltas) + .03)),
                "spot": spot, "iv": iv, "input_received_at": stamp,
                "rate_assumption": "0", "dividend_yield_assumption": "0",
                "limitations": "European approximation for American contracts; zero-rate/yield base case; delta sensitivity spans rates/yields 0-6% plus 0.03, not a statistical confidence interval or assignment probability."}
    except (ImportError, ValueError, RuntimeError):
        return None


def settings(value):
    if not isinstance(value, dict) or set(value) - {"action", "port", "account_id", "scan_ideas"}:
        raise BridgeError("INVALID_TWS_INPUT")
    if value.get("action") not in ("status", "portfolio") or type(value.get("port")) is not int or value["port"] not in (7496, 7497):
        raise BridgeError("INVALID_TWS_INPUT")
    account = value.get("account_id", "")
    if "scan_ideas" in value and type(value["scan_ideas"]) is not bool:
        raise BridgeError("INVALID_TWS_INPUT")
    if not isinstance(account, str) or (account and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", account)):
        raise BridgeError("INVALID_TWS_INPUT")
    return value


def position_row(account, contract, quantity, cost, details=None):
    if details is not None:
        qualified = details.contract
        if (qualified.conId != contract.conId or qualified.secType != contract.secType or
                qualified.currency != contract.currency):
            raise BridgeError("TWS_CONTRACT_MISMATCH")
        contract = qualified
    return {
        "accountId": account, "conid": contract.conId, "assetClass": contract.secType,
        "ticker": contract.symbol, "currency": contract.currency,
        "position": number(quantity), "avgCost": number(cost),
        "multiplier": "1" if contract.secType == "STK" else number(contract.multiplier),
        "strike": number(contract.strike), "right": contract.right,
        "expiry": (getattr(details, "realExpirationDate", "") or contract.lastTradeDateOrContractMonth),
        "undConid": getattr(details, "underConId", None)
    }


def market_data_contract(details):
    contract = copy.deepcopy(details.contract)
    exchanges = {value.strip() for value in details.validExchanges.split(",")}
    # A position's venue can reject delayed data even when SMART is available.
    # Change only the quote request, and only for a qualified SMART-capable contract.
    if contract.secType in ("STK", "OPT") and contract.currency == "USD" and "SMART" in exchanges:
        contract.exchange = "SMART"
    elif not contract.exchange:
        contract.exchange = "SMART"
    return contract


def read_tws(config):
    from ibapi.client import EClient
    from ibapi.wrapper import EWrapper
    from ibapi.contract import Contract
    from ibapi.execution import ExecutionFilter
    from ibapi.common import WshEventData

    class Reader(EWrapper, EClient):
        def __init__(self):
            EWrapper.__init__(self)
            EClient.__init__(self, self)
            self.condition = threading.Condition(threading.RLock())
            self.fatal = None
            self.ready = False
            self.accounts = []
            self.server_time = None
            self.account = None
            self.rows = {}
            self.positions_done = False
            self.details = {}
            self.details_done = set()
            self.details_errors = {}
            self.quotes = {}
            self.quote_done = set()
            self.cancelled_quotes = set()
            self.histories = {}
            self.history_done = set()
            self.history_errors = {}
            self.history_warnings = {}
            self.cancelled_histories = set()
            self.historical_quotes = {}
            self.historical_quotes_done = set()
            self.historical_quote_errors = {}
            self.summary = {}
            self.summary_done = set()
            self.summary_failed = set()
            self.orders = set()
            self.order_rows = {}
            self.orders_done = False
            self.orders_failed = False
            self.account_updates = {}
            self.account_updates_done = False
            self.account_updates_failed = False
            self.executions = {}
            self.execution_fees = {}
            self.executions_done = False
            self.executions_failed = False
            self.chains = {}
            self.chains_done = set()
            self.calendar_meta = False
            self.calendar_meta_done = False
            self.calendar_data = None
            self.calendar_done = False
            self.calendar_errors = set()
            self.closing = False

        def nextValidId(self, orderId):
            # This is the SDK's handshake callback, not a request to place an order.
            with self.condition:
                self.ready = True
                self.condition.notify_all()

        def managedAccounts(self, accountsList):
            with self.condition:
                self.accounts = [account.strip() for account in accountsList.split(",") if account.strip()] if accountsList else []
                self.condition.notify_all()

        def currentTime(self, server_time):
            with self.condition:
                self.server_time = server_time
                self.condition.notify_all()

        def error(self, reqId, errorTime, errorCode, errorString, advancedOrderRejectJson=""):
            # Never print upstream text: it may contain account or authentication data.
            with self.condition:
                if errorCode in (1100, 1300, 2110, 504):
                    self.fatal = "TWS_DISCONNECTED"
                elif errorCode == 502:
                    self.fatal = "TWS_NOT_READY"
                elif errorCode == 326:
                    self.fatal = "TWS_CLIENT_IN_USE"
                elif reqId in (3000, 3001):
                    self.summary_failed.add(reqId)
                    self.summary_done.add(reqId)
                elif reqId == 3002:
                    self.account_updates_failed = True
                    self.account_updates_done = True
                elif reqId == 4000:
                    self.executions_failed = True
                    self.executions_done = True
                elif reqId in (3100, 3101):
                    self.calendar_errors.add(errorCode)
                    self.calendar_meta_done = True
                    self.calendar_done = True
                elif reqId in self.chains:
                    self.chains[reqId] = []
                    self.chains_done.add(reqId)
                elif reqId == -1 and errorCode in (321, 322):
                    self.orders_failed = True
                elif reqId in self.details:
                    self.details[reqId] = []
                    self.details_done.add(reqId)
                    self.details_errors.setdefault(reqId, set()).add(errorCode)
                elif reqId in self.histories:
                    if errorCode == 366 and reqId in self.cancelled_histories:
                        pass
                    elif errorCode == 2188:
                        self.history_warnings.setdefault(reqId, set()).add(errorCode)
                    else:
                        self.history_errors.setdefault(reqId, set()).add(errorCode)
                        self.history_done.add(reqId)
                elif reqId in self.historical_quotes:
                    self.historical_quote_errors.setdefault(reqId, set()).add(errorCode)
                    if errorCode != 2188:
                        self.historical_quotes_done.add(reqId)
                elif reqId in self.quotes:
                    if errorCode == 300 and reqId in self.cancelled_quotes:
                        return
                    self.quotes[reqId].setdefault("error_codes", set()).add(errorCode)
                    # These warn about partial/delayed data; actual ticks still need validation.
                    if errorCode not in (2187, 10090, 10091, 10167):
                        self.quotes[reqId]["failed"] = True
                        self.quote_done.add(reqId)
                self.condition.notify_all()

        def accountSummary(self, reqId, account, tag, value, currency):
            with self.condition:
                if reqId not in (3000, 3001) or reqId in self.summary_done or account != self.account:
                    return
                tag = tag.removeprefix("$LEDGER-")
                if tag not in ("NetLiquidation", "SettledCash", "TotalCashValue", "CashBalance", "TotalCashBalance") or not re.fullmatch(r"[A-Z]{3}", currency):
                    return
                amount = number(value)
                if amount is not None:
                    self.summary[(reqId, tag, currency)] = amount
                if len(self.summary) > 100:
                    self.summary_failed.add(reqId)
                self.condition.notify_all()

        def accountSummaryEnd(self, reqId):
            with self.condition:
                self.summary_done.add(reqId)
                self.condition.notify_all()

        def accountUpdateMulti(self, reqId, account, modelCode, key, value, currency):
            with self.condition:
                if reqId != 3002 or account != self.account or modelCode or self.account_updates_done:
                    return
                if key == "AccountReady" and value.lower() != "true":
                    self.account_updates_failed = True
                    self.summary_failed.update((3000, 3001))
                    return
                source = "CURRENCY_LEDGER" if key.startswith("$LEDGER-") else "ACCOUNT_UPDATES"
                key = key.removeprefix("$LEDGER-")
                if key not in ("SettledCash", "CashBalance", "TotalCashBalance", "NetLiquidation", "ExchangeRate") or not re.fullmatch(r"[A-Z]{3}", currency):
                    return
                amount = number(value)
                if amount is not None:
                    self.account_updates[(key, currency, source)] = amount
                if len(self.account_updates) > 100:
                    self.account_updates_failed = True

        def accountUpdateMultiEnd(self, reqId):
            with self.condition:
                if reqId == 3002:
                    self.account_updates_done = True
                self.condition.notify_all()

        def execDetails(self, reqId, contract, execution):
            with self.condition:
                if reqId != 4000 or execution.acctNumber != self.account or self.executions_done:
                    return
                if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", execution.execId):
                    self.executions_failed = True
                    return
                self.executions[execution.execId] = {
                    "id": execution.execId, "conid": contract.conId,
                    "side": execution.side, "quantity": number(execution.shares),
                    "price": number(execution.price), "currency": contract.currency,
                    "time": execution.time, "multiplier": number(contract.multiplier),
                    "exchange": execution.exchange,
                }
                if len(self.executions) > 2000:
                    self.executions_failed = True

        def execDetailsEnd(self, reqId):
            with self.condition:
                if reqId == 4000:
                    self.executions_done = True
                self.condition.notify_all()

        def commissionAndFeesReport(self, report):
            with self.condition:
                if len(self.execution_fees) < 2000:
                    self.execution_fees[report.execId] = {"amount": number(report.commissionAndFees), "currency": report.currency}

        def commissionReport(self, report):
            with self.condition:
                if len(self.execution_fees) < 2000:
                    self.execution_fees[report.execId] = {"amount": number(report.commission), "currency": report.currency}

        def wshMetaData(self, reqId, dataJson):
            with self.condition:
                if reqId == 3100 and len(dataJson) <= 200000:
                    try:
                        data = json.loads(dataJson)
                        self.calendar_meta = isinstance(data, dict) and isinstance(data.get("event_types"), list)
                    except ValueError:
                        pass
                    self.calendar_meta_done = True
                    self.condition.notify_all()

        def wshEventData(self, reqId, dataJson):
            with self.condition:
                if reqId == 3101 and len(dataJson) <= 200000:
                    try:
                        data = json.loads(dataJson)
                        if isinstance(data, (dict, list)):
                            self.calendar_data = data
                    except ValueError:
                        pass
                    self.calendar_done = True
                    self.condition.notify_all()

        def openOrder(self, orderId, contract, order, orderState):
            with self.condition:
                if self.orders_done:
                    return
                if not getattr(order, "account", None):
                    self.orders_failed = True
                elif order.account == self.account:
                    key = (getattr(order, "clientId", None), orderId)
                    self.orders.add(key)
                    self.order_rows[key] = {
                        "conid": contract.conId, "type": contract.secType, "currency": contract.currency,
                        "right": contract.right, "strike": number(contract.strike), "multiplier": number(contract.multiplier or 1),
                        "side": getattr(order, "action", None), "quantity": number(getattr(order, "totalQuantity", None)),
                        "limit_price": number(getattr(order, "lmtPrice", None)), "order_type": getattr(order, "orderType", None),
                        "status": getattr(orderState, "status", None),
                        "oca": bool(getattr(order, "ocaGroup", "")), "parent": bool(getattr(order, "parentId", 0)),
                    }
                    if len(self.orders) > 500:
                        self.orders_failed = True
                self.condition.notify_all()

        def openOrderEnd(self):
            with self.condition:
                self.orders_done = True
                self.condition.notify_all()

        def connectionClosed(self):
            with self.condition:
                if not self.closing:
                    self.fatal = self.fatal or ("TWS_DISCONNECTED" if self.ready else "TWS_NOT_READY")
                self.condition.notify_all()

        def position(self, account, contract, position, avgCost):
            with self.condition:
                if account != self.account or self.positions_done:
                    return
                if contract.conId in self.rows:
                    self.fatal = "TWS_POSITIONS_INCOMPLETE"
                self.rows[contract.conId] = (copy.deepcopy(contract), position, avgCost)
                if len(self.rows) > 500:
                    self.fatal = "TWS_POSITION_LIMIT"
                self.condition.notify_all()

        def positionEnd(self):
            with self.condition:
                self.positions_done = True
                self.condition.notify_all()

        def contractDetails(self, reqId, details):
            with self.condition:
                if reqId in self.details and reqId not in self.details_done:
                    self.details[reqId].append(details)
                    if len(self.details[reqId]) > 1:
                        self.fatal = "TWS_CONTRACT_MISMATCH"
                self.condition.notify_all()

        def contractDetailsEnd(self, reqId):
            with self.condition:
                self.details_done.add(reqId)
                self.condition.notify_all()

        def marketDataType(self, reqId, marketDataType):
            with self.condition:
                if reqId in self.quotes:
                    quote = self.quotes[reqId]
                    if quote.get("data_type") not in (None, marketDataType):
                        identity = {key: quote[key] for key in ("conid", "error_codes", "failed") if key in quote}
                        quote.clear()
                        quote.update(identity)
                    quote["data_type"] = marketDataType

        def securityDefinitionOptionParameter(self, reqId, exchange, underlyingConId, tradingClass, multiplier, expirations, strikes):
            with self.condition:
                if reqId in self.chains and exchange == "SMART" and multiplier == "100" and len(self.chains[reqId]) < 10:
                    self.chains[reqId].append({"underlying": underlyingConId, "class": tradingClass,
                                             "expirations": sorted(expirations)[:100], "strikes": sorted(strikes)[:2000]})

        def securityDefinitionOptionParameterEnd(self, reqId):
            with self.condition:
                self.chains_done.add(reqId)
                self.condition.notify_all()

        def tickPrice(self, reqId, tickType, price, attrib):
            with self.condition:
                quote = self.quotes.get(reqId)
                fields = {1: "84", 2: "86", 4: "last", 9: "previous_close", 66: "84", 67: "86", 68: "last", 75: "previous_close"}
                if quote is None or tickType not in fields:
                    return
                if quote.get("data_type") is None and tickType >= 66:
                    quote["data_type"] = 3
                key = fields[tickType]
                if key == "last":
                    quote.pop("last_observed_at", None)
                quote[key] = number(price)
                quote[key + "_at"] = int(time.time() * 1000)
                quote[key + "_type"] = 3 if tickType >= 66 else 1
                self.condition.notify_all()

        def tickSize(self, reqId, tickType, size):
            fields = {0: "bid_size", 3: "ask_size", 8: "volume", 27: "call_open_interest", 28: "put_open_interest",
                      69: "bid_size", 70: "ask_size", 74: "volume"}
            with self.condition:
                quote = self.quotes.get(reqId)
                value = number(size)
                if quote is None or tickType not in fields or value is None or Decimal(value) < 0 or Decimal(value) != Decimal(value).to_integral_value():
                    return
                if quote.get("data_type") is None and tickType in (69, 70, 74):
                    quote["data_type"] = 3
                key = fields[tickType]
                quote[key] = value
                quote[key + "_at"] = int(time.time() * 1000)
                quote[key + "_type"] = 3 if tickType in (69, 70, 74) else 1 if tickType in (0, 3, 8) else quote.get("data_type")

        def tickGeneric(self, reqId, tickType, value):
            # 106 requests 30-day underlying IV; 104 requests historical volatility.
            with self.condition:
                quote = self.quotes.get(reqId)
                value = number(value)
                if quote is None or tickType not in (23, 24) or value is None or not 0 < Decimal(value) <= 5:
                    return
                key = "historical_volatility_30d" if tickType == 23 else "underlying_iv_30d"
                quote[key] = value
                quote[key + "_at"] = int(time.time() * 1000)
                quote[key + "_type"] = quote.get("data_type")

        def historicalData(self, reqId, bar):
            with self.condition:
                if reqId not in self.histories or reqId in self.history_done:
                    return
                if len(self.histories[reqId]) >= 500:
                    self.history_errors.setdefault(reqId, set()).add(-1)
                    self.history_done.add(reqId)
                    return
                self.histories[reqId].append({"date": bar.date, **{key: number(getattr(bar, key, None)) for key in ("open", "high", "low", "close", "volume")}})

        def historicalDataEnd(self, reqId, start, end):
            with self.condition:
                self.history_done.add(reqId)
                self.condition.notify_all()

        def historicalTicksBidAsk(self, reqId, ticks, done):
            with self.condition:
                if reqId not in self.historical_quotes or reqId in self.historical_quotes_done:
                    return
                for tick in ticks[:1000]:
                    bid, ask = number(tick.priceBid), number(tick.priceAsk)
                    if (not isinstance(tick.time, int) or not bid or not ask or
                            not 0 <= Decimal(bid) <= Decimal(ask) or Decimal(ask) <= 0 or
                            getattr(tick.tickAttribBidAsk, "bidPastLow", True) or getattr(tick.tickAttribBidAsk, "askPastHigh", True)):
                        continue
                    previous = self.historical_quotes[reqId]
                    if previous is None or tick.time >= previous["time"]:
                        self.historical_quotes[reqId] = {"time": tick.time, "bid": bid, "ask": ask,
                            "bid_size": number(tick.sizeBid), "ask_size": number(tick.sizeAsk)}
                if done:
                    self.historical_quotes_done.add(reqId)
                self.condition.notify_all()

        def tickOptionComputation(self, reqId, tickType, tickAttrib, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice):
            with self.condition:
                quote = self.quotes.get(reqId)
                if quote is not None and tickType in (13, 83):
                    if quote.get("data_type") is None and tickType == 83:
                        quote["data_type"] = 3
                    quote.update({"7308": number(delta), "7309": number(gamma), "7310": number(theta), "7311": number(vega)})
                    quote["greek_type"] = 3 if tickType == 83 else 1
                    quote["greeks_at"] = int(time.time() * 1000)
                    quote["model_inputs"] = {"iv": number(impliedVol), "spot": number(undPrice),
                                             "received_at": int(time.time() * 1000), "source": "IBKR_OPTION_MODEL"}

        def tickSnapshotEnd(self, reqId):
            with self.condition:
                self.quote_done.add(reqId)
                self.condition.notify_all()

        def wait_for(self, predicate, timeout, error=None):
            with self.condition:
                success = self.condition.wait_for(lambda: self.fatal or predicate(), timeout)
                if self.fatal:
                    raise BridgeError(self.fatal)
                if not success and error:
                    raise BridgeError(error)
                return bool(success)

        def read_loop(self):
            try:
                self.run()
            except Exception:
                with self.condition:
                    self.fatal = "TWS_WORKER"
                    self.condition.notify_all()

        def placeOrder(self, *args, **kwargs):
            raise BridgeError("READ_ONLY_BOUNDARY")

        cancelOrder = placeOrder
        reqGlobalCancel = placeOrder
        exerciseOptions = placeOrder
        reqAutoOpenOrders = placeOrder
        replaceFA = placeOrder

    app = Reader()
    thread = None
    try:
        app.connect("127.0.0.1", config["port"], clientId=83)
        thread = threading.Thread(target=app.read_loop, daemon=True)
        thread.start()
        app.wait_for(lambda: app.ready and app.accounts, 10, "TWS_NOT_READY")
        if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", account) for account in app.accounts):
            raise BridgeError("TWS_ACCOUNTS")
        app.reqCurrentTime()
        app.wait_for(lambda: app.server_time is not None, 5, "TWS_NOT_READY")
        if not isinstance(app.server_time, int) or abs(time.time() - app.server_time) > 120:
            raise BridgeError("TWS_NOT_READY")
        result = {"ok": True, "authenticated": True, "complete": True, "accounts": sorted(set(app.accounts))}
        if config["action"] == "status":
            return result
        account = config.get("account_id")
        if not account and len(result["accounts"]) != 1:
            raise BridgeError("ACCOUNT_SELECTION_REQUIRED")
        app.account = account or result["accounts"][0]
        if app.account not in result["accounts"]:
            raise BridgeError("INVALID_ACCOUNT")
        # Read-only snapshots; never bind orders or change the TWS master client.
        app.reqAccountSummary(3000, "All", "NetLiquidation,SettledCash,TotalCashValue")
        app.reqAccountSummary(3001, "All", "$LEDGER:USD")
        app.reqAccountUpdatesMulti(3002, app.account, "", False)
        app.reqAllOpenOrders()
        execution_filter = ExecutionFilter()
        execution_filter.acctCode = app.account
        app.reqExecutions(4000, execution_filter)
        app.reqWshMetaData(3100)
        app.reqPositions()
        app.wait_for(lambda: app.positions_done, 10, "TWS_POSITIONS_INCOMPLETE")
        app.cancelPositions()
        holdings = list(app.rows.values())
        supported = [row for row in holdings if row[0].secType in ("STK", "OPT") and number(row[1]) != "0"]
        if len(supported) > 100 or sum(row[0].secType == "OPT" for row in supported) > 40:
            raise BridgeError("TWS_POSITION_LIMIT")
        requests = {}
        for index, (contract, quantity, cost) in enumerate(supported):
            req = 1000 + index
            requests[contract.conId] = req
            with app.condition:
                app.details[req] = []
            query = Contract()
            query.conId = contract.conId
            query.exchange = contract.exchange or "SMART"
            app.reqContractDetails(req, query)
            time.sleep(0.05)
        universe = ["XLP", "XLF", "XLU", "XLE", "XLV", "XLI", "XLB", "XLC", "IWM", "EFA", "EEM", "TLT"] if config.get("scan_ideas") else []
        screen = [{"ticker": ticker, "status": "CONTRACT_UNAVAILABLE"} for ticker in universe]
        for index, ticker in enumerate(universe):
            req = 5000 + index
            app.details[req] = []
            query = Contract()
            query.symbol, query.secType, query.currency, query.exchange = ticker, "STK", "USD", "SMART"
            app.reqContractDetails(req, query)
            time.sleep(0.05)
        app.wait_for(lambda: all(req in app.details_done for req in [*requests.values(), *range(5000, 5000 + len(universe))]), 12)
        positions = []
        quote_contracts = []
        contract_metadata = {}
        with app.condition:
            for contract, quantity, cost in holdings:
                req = requests.get(contract.conId)
                matches = app.details.get(req, []) if req in app.details_done else []
                details = matches[0] if len(matches) == 1 else None
                positions.append(position_row(app.account, contract, quantity, cost, details))
                if details and details.contract.secType in ("STK", "OPT"):
                    quote_contracts.append(market_data_contract(details))
                    contract_metadata[contract.conId] = {"status": "IBKR_QUALIFIED", "conid": contract.conId,
                        "multiplier": number(details.contract.multiplier or 1), "trading_class": details.contract.tradingClass,
                        "local_symbol": details.contract.localSymbol, "deliverable_verified": False}
            for index, ticker in enumerate(universe):
                matches = app.details.get(5000 + index, []) if 5000 + index in app.details_done else []
                if len(matches) == 1 and matches[0].contract.symbol == ticker and matches[0].contract.secType == "STK" and matches[0].contract.currency == "USD":
                    contract = copy.deepcopy(matches[0].contract)
                    contract.exchange = "SMART"
                    screen[index].update(conid=contract.conId, status="QUOTE_UNAVAILABLE")
                    if contract.conId not in {c.conId for c in quote_contracts}:
                        quote_contracts.append(contract)
        # Always request held-option underlyings, including when idea screening is off.
        underlying_requests = {}
        for p in positions:
            conid = p.get("undConid")
            if p["assetClass"] != "OPT" or not isinstance(conid, int) or conid <= 0 or conid in underlying_requests or conid in {c.conId for c in quote_contracts}:
                continue
            req = 5500 + len(underlying_requests)
            underlying_requests[conid] = req
            app.details[req] = []
            query = Contract()
            query.conId, query.exchange = conid, "SMART"
            app.reqContractDetails(req, query)
            time.sleep(0.05)
        if underlying_requests:
            app.wait_for(lambda: all(r in app.details_done for r in underlying_requests.values()), 6)
        for conid, req in underlying_requests.items():
            matches = app.details.get(req, []) if req in app.details_done else []
            if len(matches) == 1 and matches[0].contract.conId == conid and matches[0].contract.secType == "STK":
                quote_contracts.append(market_data_contract(matches[0]))
        # IBKR returns live data when entitled, otherwise explicitly delayed ticks.
        # Leave room for candidate requests under the common 100-line allowance.
        held_ids = {p["conid"] for p in positions}
        underlying_ids = {p.get("undConid") for p in positions}
        quote_contracts.sort(key=lambda c: 0 if c.conId in held_ids else 1 if c.conId in underlying_ids else 2)
        quote_contracts = quote_contracts[:90]
        app.reqMarketDataType(3)
        for index, contract in enumerate(quote_contracts):
            req = 2000 + index
            with app.condition:
                app.quotes[req] = {"conid": contract.conId}
            # Generic data requires a short-lived stream, not snapshot=True.
            # Some TWS builds omit generic fields on delayed fallback (warning
            # 2187) while still returning ordinary prices. Never a paid snapshot.
            app.reqMktData(req, contract, "101" if contract.secType == "OPT" else "106", False, False, [])
            time.sleep(0.05)
        app.wait_for(lambda: all(req in app.quote_done for req in app.quotes), 14)
        # Underlying selection needs a dated observed price, not necessarily an
        # executable stock spread. A minute-bar close is labelled as a last trade.
        spot_requests = {}
        spot_end_epoch = int(time.time()) - 20 * 60
        spot_end = datetime.datetime.fromtimestamp(spot_end_epoch, datetime.timezone.utc).strftime("%Y%m%d-%H:%M:%S")
        for contract in [c for c in quote_contracts if c.secType == "STK"][:12]:
            quote = next(q for q in app.quotes.values() if q["conid"] == contract.conId)
            bid, ask = number(quote.get("84")), number(quote.get("86"))
            lag = 1200000 if quote.get("data_type") == 3 else 0
            if (not quote.get("failed") and quote.get("data_type") in (1, 3) and
                    quote.get("84_type") == quote.get("86_type") == quote.get("data_type") and
                    bid and ask and 0 < Decimal(bid) <= Decimal(ask) and
                    time.time() * 1000 - min(quote.get("84_at", 0), quote.get("86_at", 0)) + lag <= 1500000):
                continue
            req = 13000 + len(spot_requests)
            spot_requests[req] = quote
            app.histories[req] = []
            app.reqHistoricalData(req, contract, spot_end, "120 S", "1 min", "TRADES", 1, 2, False, [])
            time.sleep(0.1)
        if spot_requests:
            app.wait_for(lambda: all(r in app.history_done for r in spot_requests), 8)
        for req, quote in spot_requests.items():
            app.cancelled_histories.add(req)
            app.cancelHistoricalData(req)
            if req not in app.history_done or req in app.history_errors:
                continue
            valid = [b for b in app.histories[req] if str(b["date"]).isdigit() and
                     0 <= time.time() - int(b["date"]) <= 25 * 60 and int(b["date"]) <= spot_end_epoch
                     and b["close"] and Decimal(b["close"]) > 0]
            if valid:
                bar = max(valid, key=lambda b: int(b["date"]))
                with app.condition:
                    quote.update(last=bar["close"], last_observed_at=int(bar["date"]) * 1000,
                                 last_at=int(time.time() * 1000), last_type=3)
        # Known feed delay plus local age must fit the saved prompt's planning window.
        eligible = []
        for row in screen:
            quote = next((q for q in app.quotes.values() if q["conid"] == row.get("conid")), {})
            row["error_codes"] = sorted(quote.get("error_codes", set()))[:10]
            kind = quote.get("data_type")
            lag = 1200000 if kind == 3 else 0
            if kind in (1, 3) and not quote.get("failed") and quote.get("84_type") == quote.get("86_type") == kind:
                bid, ask = number(quote.get("84")), number(quote.get("86"))
                if bid and ask and 0 < Decimal(bid) <= Decimal(ask) and time.time() * 1000 - min(quote.get("84_at", 0), quote.get("86_at", 0)) + lag <= 1500000:
                    row.update(status="CHAIN_NOT_SELECTED_THIS_RUN", spot=str((Decimal(bid) + Decimal(ask)) / 2))
                    eligible.append(row)
            if (row not in eligible and quote.get("last_observed_at") and
                    0 <= time.time() * 1000 - quote["last_observed_at"] <= 1500000 and
                    number(quote.get("last")) and Decimal(quote["last"]) > 0):
                row.update(status="CHAIN_NOT_SELECTED_THIS_RUN", spot=quote["last"], spot_basis="HISTORICAL_LAST_TRADE")
                eligible.append(row)
        if eligible:
            offset = datetime.datetime.now(datetime.timezone.utc).date().toordinal() % len(eligible)
            eligible = (eligible[offset:] + eligible[:offset])[:4]
        for index, row in enumerate(eligible):
            req = 6000 + index
            app.chains[req] = []
            app.reqSecDefOptParams(req, row["ticker"], "", "STK", row["conid"])
            time.sleep(0.05)
        if eligible:
            app.wait_for(lambda: all(req in app.chains_done for req in app.chains), 10)
        candidates = []
        today = datetime.datetime.now(datetime.timezone.utc).date()
        for index, row in enumerate(eligible):
            chains = [c for c in app.chains.get(6000 + index, []) if c["underlying"] == row["conid"]]
            row["status"] = "NO_QUALIFIED_CHAIN"
            if len(chains) != 1:
                continue
            chain = chains[0]
            dates = []
            for value in chain["expirations"]:
                try:
                    date = datetime.datetime.strptime(value, "%Y%m%d").date()
                    if 30 <= (date - today).days <= 50:
                        dates.append(date)
                except ValueError:
                    pass
            if not dates:
                continue
            expiry = min(dates, key=lambda d: (not (d.weekday() == 4 and 15 <= d.day <= 21), abs((d - today).days - 40)))
            strikes = [s for s in chain["strikes"] if number(s) and Decimal(0) < Decimal(str(s)) < Decimal(row["spot"])]
            chosen = set()
            for ratio in (Decimal("0.90"), Decimal("0.95")):
                if strikes:
                    chosen.add(min(strikes, key=lambda s: abs(Decimal(str(s)) - Decimal(row["spot"]) * ratio)))
            for strike in sorted(chosen):
                query = Contract()
                query.symbol, query.secType, query.currency, query.exchange = row["ticker"], "OPT", "USD", "SMART"
                query.lastTradeDateOrContractMonth, query.right, query.strike = expiry.strftime("%Y%m%d"), "P", strike
                query.multiplier, query.tradingClass = "100", chain["class"]
                req = 8000 + len(candidates)
                app.details[req] = []
                candidates.append({"query": query, "req": req, "underlying": row["conid"]})
                app.reqContractDetails(req, query)
                time.sleep(0.05)
            row["status"] = "CONTRACTS_REQUESTED"
        if candidates:
            app.wait_for(lambda: all(c["req"] in app.details_done for c in candidates), 10)
        candidate_rows = []
        for item in candidates:
            matches = app.details.get(item["req"], []) if item["req"] in app.details_done else []
            query = item["query"]
            if len(matches) != 1:
                continue
            details = matches[0]
            contract = details.contract
            if (contract.secType != "OPT" or contract.symbol != query.symbol or contract.currency != "USD" or
                    contract.right != "P" or str(contract.multiplier) != "100" or contract.strike != query.strike or
                    contract.lastTradeDateOrContractMonth != query.lastTradeDateOrContractMonth or details.underConId != item["underlying"]):
                continue
            candidate_rows.append(position_row(app.account, contract, -1, 0, details))
            contract_metadata[contract.conId] = {"status": "IBKR_QUALIFIED", "conid": contract.conId,
                "multiplier": number(contract.multiplier), "trading_class": contract.tradingClass,
                "local_symbol": contract.localSymbol, "deliverable_verified": False}
            if contract.conId in {q["conid"] for q in app.quotes.values()}:
                continue
            req = 9000 + len(candidate_rows)
            app.quotes[req] = {"conid": contract.conId}
            contract = market_data_contract(details)
            quote_contracts.append(contract)
            app.reqMktData(req, contract, "101", False, False, [])
            time.sleep(0.05)
        if candidates:
            app.wait_for(lambda: all(req in app.quote_done for req in app.quotes), 14)
        for req in list(app.quotes):
            app.cancelled_quotes.add(req)
            app.cancelMktData(req)
        # A dated historical bid/ask is a real observation, not a model price.
        # Ask only for data ending twenty minutes ago, then independently reject
        # stale or out-of-range timestamps. No subscription is changed.
        delayed_end_epoch = int(time.time()) - 20 * 60
        delayed_end = datetime.datetime.fromtimestamp(delayed_end_epoch, datetime.timezone.utc).strftime("%Y%m%d-%H:%M:%S")
        fallback_options = [c for c in quote_contracts if c.secType == "OPT" and
            not any(q["conid"] == c.conId and not q.get("failed") and q.get("data_type") in (1, 3)
                    and q.get("84_type") == q.get("86_type") == q.get("data_type")
                    and number(q.get("84")) is not None and number(q.get("86")) is not None
                    for q in app.quotes.values())][:12]
        needed_underlyings = {p.get("undConid") for p in positions + candidate_rows
                              if p["conid"] in {c.conId for c in fallback_options}}
        fallback_stocks = [c for c in quote_contracts if c.secType == "STK" and c.conId in needed_underlyings][:6]
        historical_quote_contracts = {}
        for i, contract in enumerate(fallback_options + fallback_stocks):
            req = 11000 + i
            historical_quote_contracts[req] = contract
            app.historical_quotes[req] = None
            app.reqHistoricalTicks(req, contract, "", delayed_end, 1, "BID_ASK", 1, False, [])
            time.sleep(0.1)
        iv_contracts = {}
        for i, contract in enumerate(fallback_stocks):
            req = 12000 + i
            iv_contracts[req] = contract
            app.histories[req] = []
            app.reqHistoricalData(req, contract, delayed_end, "120 S", "1 min", "OPTION_IMPLIED_VOLATILITY", 1, 2, False, [])
            time.sleep(0.1)
        if historical_quote_contracts:
            app.wait_for(lambda: all(r in app.historical_quotes_done for r in historical_quote_contracts)
                         and all(r in app.history_done for r in iv_contracts), 10)
        for req in iv_contracts:
            app.cancelled_histories.add(req)
            app.cancelHistoricalData(req)
        # Bounded daily histories for held underlyings first, then screened names.
        history_contracts = sorted((c for c in quote_contracts if c.secType == "STK"),
                                   key=lambda c: c.conId not in {p.get("undConid") for p in positions})[:6]
        history_symbols = {}
        for i, contract in enumerate(history_contracts):
            req = 10000 + i
            history_symbols[req] = contract.symbol
            app.histories[req] = []
            history_end = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-00:00:00")
            app.reqHistoricalData(req, contract, history_end, "1 Y", "1 day", "TRADES", 1, 1, False, [])
            time.sleep(0.1)
        if history_symbols:
            app.wait_for(lambda: all(r in app.history_done for r in history_symbols), 8)
        for req in history_symbols:
            app.cancelled_histories.add(req)
            app.cancelHistoricalData(req)
        calendar_ids = sorted({p["undConid"] for p in positions + candidate_rows if isinstance(p.get("undConid"), int) and p["undConid"] > 0})[:50]
        if app.calendar_meta and calendar_ids:
            calendar_query = WshEventData()
            calendar_query.filter = json.dumps({"country": "All", "watchlist": [str(i) for i in calendar_ids], "limit": 100})
            calendar_query.startDate = today.strftime("%Y%m%d")
            calendar_query.endDate = (today + datetime.timedelta(days=60)).strftime("%Y%m%d")
            calendar_query.totalLimit = 100
            app.reqWshEventData(3101, calendar_query)
            app.wait_for(lambda: app.calendar_done, 5)
            app.cancelWshEventData(3101)
        app.cancelWshMetaData(3100)
        app.wait_for(lambda: {3000, 3001}.issubset(app.summary_done) and app.orders_done and app.account_updates_done and app.executions_done, 3)
        app.cancelAccountSummary(3000)
        app.cancelAccountSummary(3001)
        app.cancelAccountUpdatesMulti(3002)
        with app.condition:
            quotes = []
            for req, quote in app.quotes.items():
                row = {key: value for key, value in quote.items() if key in ("conid", "84", "86")}
                kind = quote.get("data_type")
                matching = kind in (1, 3) and quote.get("84_type") == kind and quote.get("86_type") == kind and not quote.get("failed")
                row["6509"] = ("R" if kind == 1 else "D") if matching else "U"
                if matching and quote.get("greek_type") == kind:
                    row.update({key: quote[key] for key in ("7308", "7309", "7310", "7311") if key in quote})
                    row["model_inputs"] = quote.get("model_inputs")
                if matching and quote.get("greek_type") == kind and (number(row.get("7308")) is None or abs(Decimal(str(row["7308"]))) > 1):
                    contract = next((c for c in quote_contracts if c.conId == quote["conid"]), None)
                    if contract and contract.secType == "OPT":
                        row["estimated_greeks"] = model_greeks(contract, quote.get("model_inputs"))
                row["delay_upper_bound_seconds"] = 1200 if kind == 3 else 0 if kind == 1 else None
                row["_updated"] = min(quote.get("84_at", 0), quote.get("86_at", 0))
                row["timestamp_basis"] = "LOCAL_RECEIPT_TIME_NOT_EXCHANGE_TIMESTAMP"
                row["error_codes"] = sorted(quote.get("error_codes", set()))[:10]
                # Preserve independently timed fields even if one side of the quote is absent.
                row["market_fields"] = {"data_type": kind, "source": "IBKR", "received_at": int(time.time() * 1000),
                    "delay_upper_bound_seconds": 1200 if kind == 3 else 0 if kind == 1 else None,
                    "fields": {key: {"value": quote[key], "received_at": quote.get(key + "_at"), "data_type": quote.get(key + "_type")}
                               for key in ("last", "previous_close", "bid_size", "ask_size", "volume", "call_open_interest", "put_open_interest", "underlying_iv_30d", "historical_volatility_30d") if key in quote}}
                if quote.get("failed"):
                    row["market_fields"]["fields"] = {}
                if quote.get("last_observed_at"):
                    row["market_fields"]["fields"]["last"] = {"value": quote["last"], "data_type": 3,
                        "received_at": quote["last_at"], "observed_at": quote["last_observed_at"], "timestamp_basis": "IBKR_HISTORICAL"}
                if quote.get("greek_type") in (1, 3) and quote.get("greek_type") == kind and not quote.get("failed"):
                    row["independent_greeks"] = {"data_type": quote["greek_type"], "received_at": quote.get("greeks_at"),
                        "delay_upper_bound_seconds": 1200 if quote["greek_type"] == 3 else 0,
                        "values": {name: quote.get(key) for name, key in (("delta", "7308"), ("gamma", "7309"), ("theta", "7310"), ("vega", "7311"))},
                        "model_inputs": quote.get("model_inputs")}
                quotes.append(row)
            by_conid = {q["conid"]: q for q in quotes}
            for req, contract in historical_quote_contracts.items():
                tick = app.historical_quotes.get(req)
                errors = app.historical_quote_errors.get(req, set())
                if (req not in app.historical_quotes_done or not tick or errors - {2188} or
                        tick["time"] > delayed_end_epoch or not 0 <= time.time() - tick["time"] <= 25 * 60):
                    continue
                row = by_conid[contract.conId]
                row.update({"84": tick["bid"], "86": tick["ask"], "6509": "D", "_updated": tick["time"] * 1000,
                            "delay_upper_bound_seconds": 0, "source": "IBKR_HISTORICAL_TICKS",
                            "timestamp_basis": "EXCHANGE_HISTORICAL_TICK_TIMESTAMP"})
                for key in ("bid_size", "ask_size"):
                    row["market_fields"]["fields"][key] = {"value": tick[key], "data_type": 3,
                        "received_at": int(time.time() * 1000), "observed_at": tick["time"] * 1000,
                        "timestamp_basis": "IBKR_HISTORICAL"}
            for req, contract in iv_contracts.items():
                if req not in app.history_done or req in app.history_errors:
                    continue
                valid = [bar for bar in app.histories[req] if str(bar["date"]).isdigit() and
                         0 <= time.time() - int(bar["date"]) <= 25 * 60 and int(bar["date"]) <= delayed_end_epoch
                         and bar["close"] and 0 < Decimal(bar["close"]) <= 5]
                if valid:
                    bar = max(valid, key=lambda b: int(b["date"]))
                    by_conid[contract.conId]["market_fields"]["fields"]["underlying_iv_30d"] = {
                        "value": bar["close"], "data_type": 3, "observed_at": int(bar["date"]) * 1000,
                        "received_at": int(time.time() * 1000), "timestamp_basis": "IBKR_HISTORICAL"}
            if app.fatal:
                raise BridgeError(app.fatal)
            summary = [{"tag": tag, "currency": currency, "amount": amount,
                        "source": "USD_LEDGER" if req == 3001 else "ACCOUNT_SUMMARY"}
                       for (req, tag, currency), amount in app.summary.items()
                       if req in app.summary_done and req not in app.summary_failed]
            observed_orders = len(app.orders) if app.orders_done and not app.orders_failed else None
            if app.account_updates_done and not app.account_updates_failed:
                summary.extend({"tag": tag, "currency": currency, "amount": amount, "source": source}
                               for (tag, currency, source), amount in app.account_updates.items())
            trades = [dict(row, fees=app.execution_fees.get(key)) for key, row in app.executions.items()] if app.executions_done and not app.executions_failed else None
        result.update(account_id=app.account, positions=positions, quotes=quotes, account_values=summary,
                      observed_open_order_count=observed_orders, order_scope="OBSERVED_TWS_API_SNAPSHOT_NOT_ALL_ACCOUNT_RESERVATIONS",
                      orders=list(app.order_rows.values()) if observed_orders is not None else None,
                      executions=trades, execution_history_scope="TWS_AVAILABLE_TRADE_LOG_NOT_LIFETIME_HISTORY",
                      candidate_positions=candidate_rows, screen=screen,
                      contract_metadata=contract_metadata,
                      history={history_symbols[req]: {"source": "IBKR", "status": "RETURNED" if req in app.history_done and req not in app.history_errors and app.histories[req] else "UNAVAILABLE",
                               "bars": app.histories[req] if req in app.history_done and req not in app.history_errors else [],
                               "error_codes": sorted(app.history_errors.get(req, set())), "complete": req in app.history_done and req not in app.history_errors}
                               for req in history_symbols},
                      contract_request_errors={str(req): sorted(codes) for req, codes in app.details_errors.items()},
                      historical_quote_status=[{"conid": c.conId, "complete": req in app.historical_quotes_done,
                          "error_codes": sorted(app.historical_quote_errors.get(req, set()))}
                          for req, c in historical_quote_contracts.items()],
                      calendar={"source": "IBKR_WSH", "target_underlyings": calendar_ids,
                                "status": "RETURNED_REQUIRES_REVIEW" if app.calendar_data is not None else "UNAVAILABLE",
                                "error_codes": sorted(app.calendar_errors), "data": app.calendar_data},
                      collection_status={"summary": not app.summary_failed and {3000, 3001}.issubset(app.summary_done),
                                         "cash_detail": app.account_updates_done and not app.account_updates_failed,
                                         "executions": app.executions_done and not app.executions_failed,
                                         "orders": observed_orders is not None})
        return result
    finally:
        app.closing = True
        app.disconnect()
        if thread:
            thread.join(timeout=2)


def main():
    try:
        value = sys.stdin.read(4097)
        if len(value) > 4096:
            raise BridgeError("INVALID_TWS_INPUT")
        config = settings(json.loads(value))
        # SDK diagnostics must not contaminate the single JSON result or leak secrets.
        with contextlib.redirect_stdout(io.StringIO()):
            result = read_tws(config)
    except ImportError:
        result = {"ok": False, "code": "TWS_DEPENDENCY"}
    except BridgeError as error:
        result = {"ok": False, "code": str(error)}
    except Exception:
        result = {"ok": False, "code": "TWS_WORKER"}
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
