# Data Sources and Calculation Boundaries

## TWS

The official IBKR Python API reads positions, account summaries, currency
ledgers, available executions and observed API orders. Optional datasets require
completed callbacks. Aggregate balances do not establish native settled cash or
the absence of all reservations and pending assignments.

The advisor requests delayed market-data type 3 and never requests paid regulatory
snapshots. Live data may be returned where the account is entitled. Missing
bid/ask does not discard independently dated broker Greeks or other fields.

Bounded historical requests can supply actual bid/ask ticks, underlying
minute-bar closes and IV observations ending twenty minutes before the request.
Actual timestamps must remain within the 25-minute planning window. Last-trade
references are labelled separately from executable spreads. Stale, future,
crossed, incomplete or ambiguous observations are rejected.

Completed prior-date daily bars support SMA50/SMA200, RSI14, ATR14, historical
volatility and observed ranges. Current UTC-date daily bars are excluded.

ETF research checks twelve underlyings and at most four option chains per run.
Only broker-qualified contracts enter the results. This is a bounded research
screen; it is not a complete stock universe or an approved trade list.

## Optional Providers

The Tradier connector supports read-only quotes, chains and history. Provider
credentials and eligibility are configured locally. It is not required for
the TWS workflow, and no provider account or subscription is included here.

The Alpha Vantage connector supports optional event, profile and headline
research when available within its request budget. It limits new research reads
to three per review and 25 per UTC day, with a six-hour memory cache retaining
original fetch times. Public provider data does not establish issuer-verified
event clearance. Free stock research alone does not supply missing option quotes.

## Local Math

Decimal.js handles financial arithmetic. QuantLib estimates option Greeks from
aligned observed prices or explicit broker IV/model inputs. Missing inputs do
not get filled by AI guesses. Underlying 30-day IV is explicitly a proxy and
uses wider sensitivity ranges. Historical volatility is not silently used as IV.

The European Black-Scholes approximation has explicit rate/dividend assumptions
and sensitivity scenarios. It does not model American early exercise or discrete
dividends. Delta ranges are neither confidence intervals nor assignment
probabilities. Estimated option values are not presented as market quotes.

Original credit and fees are required for profit-captured and return calculations.
Missing opening history does not block conditional DTE/delta discussion.
Cash security requires currency settlement, reservations and deliverable checks.
Contract identity alone does not confirm an unadjusted deliverable.

## Remaining Limitations

IV percentile requires additional IV history. Open-interest dates, event clearance,
opening fills/fees, adjusted deliverables and settled assignment funding can remain
unverified. Broader company valuation, universe screening and portfolio stress
approval are not fully implemented. The app does not stage orders or monitor
triggers between user-requested runs.

## Credentials

Saved settings are stored outside the project and protected for the current
Windows user. The browser receives credential metadata, not saved keys. Requests
use fixed official service hosts. Provider error text is not exposed, and paid
OpenAI requests are not automatically repeated.
