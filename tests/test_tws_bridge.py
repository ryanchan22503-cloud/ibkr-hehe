import ast
import importlib.util
import time
import datetime
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from ibapi.client import EClient
from ibapi.contract import Contract, ContractDetails

FILE = Path(__file__).resolve().parents[1] / "bridge" / "tws_bridge.py"
spec = importlib.util.spec_from_file_location("tws_bridge", FILE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def stock():
    c = Contract()
    c.conId, c.secType, c.symbol, c.currency, c.exchange = 1, "STK", "TEST", "USD", "SMART"
    return c


class BridgeTests(unittest.TestCase):
    def test_numeric_unset_values_are_not_prices(self):
        for value in (None, True, float("nan"), float("inf"), 1.7976931348623157e308):
            self.assertIsNone(bridge.number(value))
        self.assertEqual(bridge.number(Decimal("150.5")), "150.5")

    def test_allowlisted_settings(self):
        for config in ({"action": "order", "port": 7496}, {"action": "status", "port": True},
                       {"action": "status", "port": 7496, "host": "remote"}):
            with self.assertRaises(bridge.BridgeError):
                bridge.settings(config)

    def test_mapping_preserves_stock_basis_and_never_invents_underlying(self):
        row = bridge.position_row("TEST1", stock(), Decimal("150.5"), 51.23)
        self.assertEqual(row["position"], "150.5")
        self.assertEqual(row["avgCost"], "51.23")
        self.assertEqual(row["multiplier"], "1")
        option = stock()
        option.secType, option.multiplier, option.right, option.strike = "OPT", "100", "C", 55
        option.lastTradeDateOrContractMonth = "20261218"
        self.assertIsNone(bridge.position_row("TEST1", option, -1, 200)["undConid"])
        details = ContractDetails()
        details.contract, details.underConId = option, 1
        self.assertEqual(bridge.position_row("TEST1", option, -1, 200, details)["undConid"], 1)
        wrong = ContractDetails()
        wrong.contract = stock()
        wrong.contract.conId = 99
        with self.assertRaisesRegex(bridge.BridgeError, "MISMATCH"):
            bridge.position_row("TEST1", option, -1, 200, wrong)

    def test_delayed_quotes_use_qualified_smart_route_without_changing_positions(self):
        for kind in ("STK", "OPT"):
            details = ContractDetails()
            details.contract = stock()
            details.contract.secType = kind
            details.contract.exchange = "AMEX"
            details.validExchanges = "AMEX, SMART,CBOE"
            quote = bridge.market_data_contract(details)
            self.assertEqual(quote.exchange, "SMART")
            self.assertEqual(quote.conId, details.contract.conId)
            self.assertEqual(quote.secType, kind)
            self.assertEqual(details.contract.exchange, "AMEX")
            self.assertIsNot(quote, details.contract)

    def test_data_route_does_not_invent_smart_eligibility(self):
        details = ContractDetails()
        details.contract = stock()
        details.contract.exchange = "AMEX"
        details.validExchanges = "AMEX,CBOE"
        self.assertEqual(bridge.market_data_contract(details).exchange, "AMEX")
        details.validExchanges = "NOTSMART"
        self.assertEqual(bridge.market_data_contract(details).exchange, "AMEX")
        details.validExchanges = "SMART,AMEX"
        details.contract.currency = "SGD"
        self.assertEqual(bridge.market_data_contract(details).exchange, "AMEX")

    def mock_read(self, action="portfolio", data_type=1, complete=True, duplicate=False, disconnect=False,
                  summary_complete=True, orders_complete=True, quote_error=None, mismatched_ticks=False,
                  scan=False, invalid_delta=False, change_feed=False, account_ready=True, held_option=False, no_bid_ask=False,
                  history_success=False, historical_age=1200, missing_type_callback=False, cancel_notices=False,
                  no_stock_bid_ask=False, later_last_tick=False):
        calls = []
        def connect(client, host, port, clientId):
            self.assertEqual(host, "127.0.0.1")
            self.assertNotEqual(clientId, 0)
            client.nextValidId(42)
            client.managedAccounts("TEST1,")
        def positions(client):
            client.position("OTHER", stock(), Decimal(999), 99)
            c = stock()
            if held_option:
                c.conId, c.secType, c.right, c.multiplier, c.strike = 2, "OPT", "P", "100", 50
                c.lastTradeDateOrContractMonth = (datetime.datetime.now(datetime.timezone.utc).date() + datetime.timedelta(days=30)).strftime("%Y%m%d")
            client.position("TEST1", c, Decimal(-1 if held_option else 150), 50)
            if duplicate:
                client.position("TEST1", stock(), Decimal(160), 50)
            if complete:
                client.positionEnd()
        def details(client, req, contract):
            data = ContractDetails()
            data.contract = stock() if req < 5000 else contract
            if req == 1000 and held_option:
                data.contract.conId, data.contract.secType, data.contract.right, data.contract.multiplier, data.contract.strike = 2, "OPT", "P", "100", 50
                data.contract.lastTradeDateOrContractMonth = (datetime.datetime.now(datetime.timezone.utc).date() + datetime.timedelta(days=30)).strftime("%Y%m%d")
                data.underConId = 1
            if 5500 <= req < 5600:
                self.assertEqual(contract.conId, 1)
                data.contract = stock()
            elif 5000 <= req < 5500:
                data.contract.conId = req
            elif req >= 8000:
                data.contract.conId = req + 10000
                data.underConId = 5000 + ["XLP", "XLF", "XLU", "XLE", "XLV", "XLI", "XLB", "XLC", "IWM", "EFA", "EEM", "TLT"].index(contract.symbol)
            client.contractDetails(req, data)
            client.contractDetailsEnd(req)
        def quote(client, req, contract, ticks, snapshot, regulatory, options):
            calls.append("quote")
            self.assertFalse(snapshot)
            self.assertEqual(ticks, "101" if contract.secType == "OPT" else "106")
            self.assertFalse(regulatory)
            if not missing_type_callback:
                client.marketDataType(req, data_type)
            delayed = data_type in (3, 4) and not mismatched_ticks
            if quote_error:
                client.error(req, 0, quote_error, "PRIVATE UPSTREAM TEXT")
            if not (no_bid_ask and contract.secType == "OPT" or no_stock_bid_ask and contract.secType == "STK"):
                client.tickPrice(req, 66 if delayed else 1, 52, None)
                client.tickPrice(req, 67 if delayed else 2, 52.10, None)
            client.tickSize(req, 69 if delayed else 0, Decimal(12))
            client.tickSize(req, 70 if delayed else 3, Decimal(15))
            client.tickSize(req, 74 if delayed else 8, Decimal(0))
            client.tickSize(req, 28, Decimal(250))
            client.tickGeneric(req, 24, .25)
            client.tickOptionComputation(req, 83 if delayed else 13, 0, .2, float("nan") if invalid_delta else -.4 if contract.right == "P" else .4, 2, 0, .01, .2, -.1, 52)
            if change_feed:
                client.marketDataType(req, 3)
                client.tickPrice(req, 66, 52, None)
                client.tickPrice(req, 67, 52.1, None)
            client.tickSnapshotEnd(req)
            if disconnect:
                client.error(-1, 0, 1100, "PRIVATE")
        def summary(client, req, group, tags):
            calls.append("summary")
            client.accountSummary(req, "OTHER", "CashBalance", "999999", "USD")
            if req == 3000:
                client.accountSummary(req, "TEST1", "NetLiquidation", "12000", "SGD")
                client.accountSummary(req, "TEST1", "SettledCash", "10000", "SGD")
                client.accountSummary(req, "TEST1", "AccountName", "PRIVATE", "SGD")
            else:
                self.assertEqual(tags, "$LEDGER:USD")
                client.accountSummary(req, "TEST1", "CashBalance", "8000", "USD")
            if summary_complete:
                client.accountSummaryEnd(req)
        def orders(client):
            calls.append("orders")
            client.openOrder(1, stock(), SimpleNamespace(account="OTHER", clientId=1), None)
            client.openOrder(2, stock(), SimpleNamespace(account="TEST1", clientId=2), None)
            client.openOrder(2, stock(), SimpleNamespace(account="TEST1", clientId=2), None)
            if orders_complete:
                client.openOrderEnd()
        def account_updates(client, req, account, model, ledger_only):
            self.assertFalse(ledger_only)
            client.accountUpdateMulti(req, "OTHER", "", "$LEDGER-SettledCash", "999999", "USD")
            client.accountUpdateMulti(req, account, "MODEL", "$LEDGER-SettledCash", "999999", "USD")
            client.accountUpdateMulti(req, account, "", "AccountReady", "true" if account_ready else "false", "")
            client.accountUpdateMulti(req, account, "", "NetLiquidation", "12000", "SGD")
            client.accountUpdateMulti(req, account, "", "$LEDGER-SettledCash", "8000", "USD")
            client.accountUpdateMulti(req, account, "", "$LEDGER-ExchangeRate", "1.3", "USD")
            if summary_complete:
                client.accountUpdateMultiEnd(req)
        def chains(client, req, symbol, exchange, kind, conid):
            calls.append("chain")
            if later_last_tick:
                quote_req = next(r for r, q in client.quotes.items() if q["conid"] == conid)
                self.assertIn("last_observed_at", client.quotes[quote_req])
                client.tickPrice(quote_req, 68, 53, None)
                self.assertNotIn("last_observed_at", client.quotes[quote_req])
            expiry = (datetime.datetime.now(datetime.timezone.utc).date() + datetime.timedelta(days=40)).strftime("%Y%m%d")
            client.securityDefinitionOptionParameter(req, "SMART", conid, symbol, "100", {expiry}, {45, 47, 49, 55})
            client.securityDefinitionOptionParameterEnd(req)
        def history(client, req, contract, end, duration, size, what, rth, fmt, keep, options):
            self.assertFalse(keep)
            self.assertTrue(end)
            calls.append("history")
            if history_success:
                client.error(req, 0, 2188, "Up-to-the-second historical data requires additional subscription for the API.")
                date = str(int(time.time()) - historical_age) if fmt == 2 else "20261005"
                price = .2 if what == "OPTION_IMPLIED_VOLATILITY" else 52
                client.historicalData(req, SimpleNamespace(date=date, open=price, high=price, low=price, close=price, volume=0))
            client.historicalDataEnd(req, "", "")
        def historical_quote(client, req, contract, start, end, count, what, rth, ignore, options):
            self.assertEqual(what, "BID_ASK")
            self.assertEqual(start, "")
            self.assertEqual(count, 1)
            self.assertTrue(end)
            if history_success:
                client.error(req, 0, 2188, "Up-to-the-second historical data requires additional subscription for the API.")
                tick = SimpleNamespace(time=int(time.time()) - historical_age, priceBid=.5, priceAsk=.6,
                    sizeBid=Decimal(3), sizeAsk=Decimal(4), tickAttribBidAsk=SimpleNamespace(bidPastLow=False, askPastHigh=False))
                client.historicalTicksBidAsk(req, [tick], True)
            else:
                client.error(req, 0, 162, "No permitted historical data")
        patches = {
            "connect": connect, "run": lambda c: None, "disconnect": lambda c: calls.append("disconnect"),
            "reqCurrentTime": lambda c: c.currentTime(int(time.time())), "reqPositions": positions,
            "cancelPositions": lambda c: None, "reqContractDetails": details,
            "reqMarketDataType": lambda c, t: self.assertEqual(t, 3), "reqMktData": quote,
            "cancelMktData": lambda c, r: (calls.append("cancel_quote"), c.error(r, 0, 300, "Cancelled") if cancel_notices else None),
            "reqHistoricalData": history, "reqHistoricalTicks": historical_quote,
            "cancelHistoricalData": lambda c, r: (calls.append("cancel_history"), c.error(r, 0, 366, "Cancelled") if cancel_notices else None),
            "reqAccountSummary": summary, "cancelAccountSummary": lambda c, r: calls.append("cancel_summary"),
            "reqAllOpenOrders": orders,
            "reqAccountUpdatesMulti": account_updates, "cancelAccountUpdatesMulti": lambda c, r: None,
            "reqExecutions": lambda c, r, f: c.execDetailsEnd(r),
            "reqWshMetaData": lambda c, r: c.error(r, 0, 10276, "PRIVATE"),
            "cancelWshMetaData": lambda c, r: None,
            "reqSecDefOptParams": chains
        }
        with patch.multiple(EClient, **patches), patch.object(bridge.time, "sleep", lambda t: None), \
                patch.object(bridge.threading.Condition, "wait_for", lambda c, predicate, timeout: predicate()):
            return bridge.read_tws({"action": action, "port": 7496, "account_id": "", "scan_ideas": scan}), calls

    def test_completed_handshake_and_account_isolation(self):
        result, calls = self.mock_read()
        self.assertEqual(len(result["positions"]), 1)
        self.assertEqual(result["positions"][0]["position"], "150")
        self.assertEqual(result["quotes"][0]["6509"], "R")
        self.assertGreater(result["quotes"][0]["_updated"], 0)
        self.assertIn("disconnect", calls)
        self.assertEqual(result["observed_open_order_count"], 1)
        self.assertEqual(len(result["account_values"]), 6)
        ledger = next(r for r in result["account_values"] if r["source"] == "CURRENCY_LEDGER" and r["tag"] == "SettledCash")
        self.assertEqual(ledger, {"tag": "SettledCash", "currency": "USD", "amount": "8000", "source": "CURRENCY_LEDGER"})
        self.assertEqual(result["executions"], [])
        self.assertEqual(result["calendar"]["status"], "UNAVAILABLE")
        self.assertFalse(any(row["amount"] == "999999" for row in result["account_values"]))
        self.assertEqual(calls.count("cancel_summary"), 2)

    def test_status_does_not_request_positions_or_quotes(self):
        result, calls = self.mock_read(action="status")
        self.assertTrue(result["authenticated"])
        self.assertNotIn("positions", result)
        self.assertNotIn("quote", calls)
        self.assertNotIn("summary", calls)
        self.assertNotIn("orders", calls)

    def test_delayed_data_is_never_relabelled_realtime(self):
        for kind in (None, 2, 4):
            result, _ = self.mock_read(data_type=kind)
            self.assertEqual(result["quotes"][0]["6509"], "U")
        for warning in (2187, 10090, 10091, 10167):
            result, _ = self.mock_read(data_type=3, quote_error=warning)
            self.assertEqual(result["quotes"][0]["6509"], "D")
            self.assertEqual(result["quotes"][0]["7308"], "0.4")
            self.assertEqual(result["quotes"][0]["error_codes"], [warning])

    def test_mixed_tick_types_and_hard_errors_fail_closed(self):
        for settings in ({"data_type": 3, "mismatched_ticks": True}, {"quote_error": 354}):
            result, _ = self.mock_read(**settings)
            self.assertEqual(result["quotes"][0]["6509"], "U")
            self.assertNotIn("7308", result["quotes"][0])

    def test_incomplete_cash_and_order_reads_stay_unknown(self):
        result, _ = self.mock_read(summary_complete=False, orders_complete=False)
        self.assertEqual(result["account_values"], [])
        self.assertIsNone(result["observed_open_order_count"])

    def test_no_partial_or_duplicate_portfolios(self):
        for config in ({"complete": False}, {"duplicate": True}, {"disconnect": True}):
            with self.assertRaises(bridge.BridgeError):
                self.mock_read(**config)

    def test_sdk_call_allowlist_contains_no_order_or_account_mutations(self):
        allowed = {"connect", "disconnect", "wait_for", "reqCurrentTime", "reqPositions", "cancelPositions",
                   "reqContractDetails", "reqMarketDataType", "reqMktData", "cancelMktData", "reqHistoricalData", "reqHistoricalTicks", "cancelHistoricalData", "reqAccountSummary",
                   "cancelAccountSummary", "reqAllOpenOrders", "reqAccountUpdatesMulti", "cancelAccountUpdatesMulti",
                   "reqExecutions", "reqWshMetaData", "cancelWshMetaData", "reqWshEventData", "cancelWshEventData", "reqSecDefOptParams"}
        tree = ast.parse(FILE.read_text())
        called = {node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name)
                  and node.func.value.id == "app"}
        self.assertLessEqual(called, allowed)

    def test_live_and_delayed_scans_are_bounded_and_qualified(self):
        for kind in (1, 3):
            result, calls = self.mock_read(scan=True, data_type=kind)
            self.assertEqual(len(result["screen"]), 12)
            self.assertEqual(calls.count("chain"), 4)
            self.assertEqual(len(result["candidate_positions"]), 8)
            self.assertTrue(all(p["right"] == "P" and p["multiplier"] == "100" for p in result["candidate_positions"]))
            self.assertEqual(len({q["conid"] for q in result["quotes"]}), len(result["quotes"]))

    def test_missing_market_access_does_not_invent_candidate_contracts(self):
        result, calls = self.mock_read(scan=True, quote_error=354)
        self.assertEqual(len(result["screen"]), 12)
        self.assertEqual(result["candidate_positions"], [])
        self.assertNotIn("chain", calls)

    def test_unready_account_does_not_publish_balances(self):
        result, _ = self.mock_read(account_ready=False)
        self.assertEqual(result["account_values"], [])
        self.assertFalse(result["collection_status"]["cash_detail"])

    def test_feed_switch_discards_old_model_inputs(self):
        result, _ = self.mock_read(scan=True, invalid_delta=True, change_feed=True)
        self.assertTrue(all(not q.get("estimated_greeks") and not q.get("model_inputs") for q in result["quotes"]))
        self.assertTrue(all(not q.get("independent_greeks") and not q["market_fields"]["fields"] for q in result["quotes"]))

    def test_independent_liquidity_and_iv_have_source_timestamps(self):
        result, calls = self.mock_read(data_type=3)
        fields = result["quotes"][0]["market_fields"]["fields"]
        self.assertEqual(fields["volume"]["value"], "0")
        self.assertEqual(fields["put_open_interest"]["value"], "250")
        self.assertEqual(fields["underlying_iv_30d"]["value"], "0.25")
        self.assertEqual(fields["underlying_iv_30d"]["data_type"], 3)
        self.assertGreater(fields["bid_size"]["received_at"], 0)
        self.assertEqual(calls.count("cancel_quote"), len(result["quotes"]))
        self.assertIn("cancel_history", calls)

    def test_held_option_underlying_is_requested_when_screen_is_off(self):
        result, _ = self.mock_read(held_option=True, no_bid_ask=True, data_type=3)
        self.assertEqual(result["screen"], [])
        self.assertEqual({q["conid"] for q in result["quotes"]}, {1, 2})
        option = next(q for q in result["quotes"] if q["conid"] == 2)
        self.assertEqual(option["6509"], "U")
        self.assertEqual(option["independent_greeks"]["values"]["delta"], "-0.4")
        self.assertIn("TEST", result["history"])

    def test_hard_quote_failure_does_not_publish_independent_fields(self):
        result, _ = self.mock_read(quote_error=354)
        self.assertEqual(result["quotes"][0]["market_fields"]["fields"], {})
        self.assertNotIn("independent_greeks", result["quotes"][0])

    def test_delayed_historical_quotes_and_iv_are_actual_dated_observations(self):
        result, _ = self.mock_read(held_option=True, no_bid_ask=True, data_type=3, history_success=True)
        option = next(q for q in result["quotes"] if q["conid"] == 2)
        self.assertEqual(option["84"], "0.5")
        self.assertEqual(option["6509"], "D")
        self.assertEqual(option["source"], "IBKR_HISTORICAL_TICKS")
        self.assertEqual(option["delay_upper_bound_seconds"], 0)
        self.assertAlmostEqual((time.time() * 1000 - option["_updated"]) / 1000, 1200, delta=2)
        underlying = next(q for q in result["quotes"] if q["conid"] == 1)
        self.assertEqual(underlying["market_fields"]["fields"]["underlying_iv_30d"]["timestamp_basis"], "IBKR_HISTORICAL")
        self.assertEqual(result["history"]["TEST"]["status"], "RETURNED")

    def test_historical_fallback_never_turns_old_or_future_ticks_into_fresh_prices(self):
        for age in (1800, -60, 900):
            result, _ = self.mock_read(held_option=True, no_bid_ask=True, data_type=3, history_success=True, historical_age=age)
            option = next(q for q in result["quotes"] if q["conid"] == 2)
            self.assertNotIn("source", option)

    def test_explicit_delayed_tick_types_work_without_a_separate_type_callback(self):
        result, _ = self.mock_read(data_type=3, missing_type_callback=True)
        self.assertEqual(result["quotes"][0]["6509"], "D")
        result, _ = self.mock_read(data_type=1, missing_type_callback=True)
        self.assertEqual(result["quotes"][0]["6509"], "U")

    def test_cancel_acknowledgements_do_not_discard_completed_data(self):
        result, _ = self.mock_read(data_type=3, history_success=True, cancel_notices=True)
        self.assertEqual(result["quotes"][0]["6509"], "D")
        self.assertEqual(result["history"]["TEST"]["status"], "RETURNED")

    def test_model_estimates_need_real_inputs_and_preserve_put_sign(self):
        result, _ = self.mock_read(scan=True, invalid_delta=True)
        estimates = [q["estimated_greeks"] for q in result["quotes"] if q.get("estimated_greeks")]
        self.assertEqual(len(estimates), 8)
        for value in estimates:
            self.assertLess(float(value["delta"]), 0)
            self.assertGreater(float(value["delta"]), -1)
            self.assertLessEqual(float(value["delta_low"]), float(value["delta"]))
            self.assertGreaterEqual(float(value["delta_high"]), float(value["delta"]))
        contract = stock()
        for inputs in (None, {}, {"iv": None, "spot": 50}, {"iv": .2, "spot": 50, "received_at": 1}):
            self.assertIsNone(bridge.model_greeks(contract, inputs))

    def test_dated_last_trade_can_select_chains_without_inventing_stock_spreads(self):
        result, calls = self.mock_read(scan=True, data_type=3, no_stock_bid_ask=True, history_success=True)
        self.assertEqual(calls.count("chain"), 4)
        self.assertEqual(len(result["candidate_positions"]), 8)
        self.assertTrue(any(r.get("spot_basis") == "HISTORICAL_LAST_TRADE" for r in result["screen"]))
        underlying = next(q for q in result["quotes"] if q["conid"] == 5000)
        self.assertNotIn("84", underlying)
        last = underlying["market_fields"]["fields"]["last"]
        self.assertEqual(last["value"], "52")
        self.assertEqual(last["timestamp_basis"], "IBKR_HISTORICAL")

    def test_stale_or_future_last_trade_cannot_select_chains(self):
        for age in (1800, -60, 900):
            result, calls = self.mock_read(scan=True, data_type=3, no_stock_bid_ask=True,
                                          history_success=True, historical_age=age)
            self.assertNotIn("chain", calls)
            self.assertEqual(result["candidate_positions"], [])

    def test_streamed_last_price_cannot_inherit_a_historical_timestamp(self):
        result, _ = self.mock_read(scan=True, data_type=3, no_stock_bid_ask=True,
                                   history_success=True, later_last_tick=True)
        fields = [q["market_fields"]["fields"].get("last") for q in result["quotes"]]
        latest = [f for f in fields if f and f["value"] == "53"]
        self.assertEqual(len(latest), 4)
        self.assertTrue(all("observed_at" not in f for f in latest))


if __name__ == "__main__":
    unittest.main()
