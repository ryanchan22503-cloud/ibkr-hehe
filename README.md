# Local IBKR Options Advisor
committing changes

A local, read-only options position reviewer using Node.js, the official IBKR
Python API and optional OpenAI analysis. It supports covered-call and conditional
short-put risk reviews, delayed market data, and local calculations.

The application has no trade-placement or order-change functions. Missing data
remains unavailable. AI output is restricted to validated review actions and
topics; prices and mathematical results are computed locally.

## Requirements

- Windows, Node.js 20 or newer, Python 3.12, and Trader Workstation.
- The official IBKR Python SDK, installed separately in a local Python environment.
- An OpenAI API key only when requesting the optional AI review.

Create the Python environment inside this project:

```powershell
python -m venv .tws-venv
.\.tws-venv\Scripts\python.exe -m pip install -r bridge\requirements-market.txt
```

Install the official IBKR Python SDK into the same environment using the SDK's
`IBJts/source/pythonclient` folder. The source was tested with IBKR SDK 10.50.2
and protobuf 5.29.5. The SDK and local environment are excluded from this repository.

```powershell
.\.tws-venv\Scripts\python.exe -m pip install protobuf==5.29.5
.\.tws-venv\Scripts\python.exe -m pip install "<SDK folder>\IBJts\source\pythonclient"
```

Decimal.js is vendored with its original license in `vendor/LICENCE.md`.

## Run

Open TWS and finish logging in. In its API settings, enable socket clients,
retain Read-Only API, restrict access to localhost, and use port 7496 for live
or 7497 for paper trading.

From this project folder:

```powershell
$env:IBKR_CONNECTION = 'tws'
node server.mjs
```

Open http://127.0.0.1:3210/. Enter credentials through the local page. Save AI
settings and a question there when desired. Do not put keys in source files,
test fixtures, GitHub issues or the question text.

Client Portal Gateway is also supported. Its local certificate must be configured
separately using `IBKR_CA_FILE`; no certificate, private key or Gateway session
is distributed with this source.

## Data and Limits

See `DATA_SOURCES.md` for the collection rules and remaining limitations.
Quotes must pass source, value and age checks. Estimates use observed inputs and
are explicitly labelled. Conditional DTE/delta review can run without original
opening history; profit calculations still require verified fills and fees.

API credit does not remove API rate or spending limits. Recognized OpenAI error
codes produce specific messages. Unknown quota reasons remain unknown. Paid model
requests are not automatically retried, and local results remain available if
the AI request fails.

## Privacy

This source distribution excludes real credentials, account records, saved
questions, screenshots, live reports, logs, certificates and local environments.
Test credentials and account identifiers are synthetic fixtures.

On Windows, saved settings are encrypted for the current user under
`%LOCALAPPDATA%\IBKROptionsAdvisor`, outside the project. They are not included in
this repository. Known account identifiers and supplied secrets are removed from
the optional model request. Portfolio data still goes to OpenAI when AI review
is requested; inspect the displayed request before sharing its contents.

The `.gitignore` file excludes common sensitive and generated files. Scan new
files before publishing them. It cannot remove secrets from existing Git history.

## Tests

```powershell
node --test tests/*.test.mjs
.\.tws-venv\Scripts\python.exe -m unittest discover -s tests -p test_tws_bridge.py
```

Tests use synthetic broker/provider responses and local calculations. They do
not prove that a particular account has current market-data access. Actual TWS
and OpenAI checks require local credentials and a separate live test.
