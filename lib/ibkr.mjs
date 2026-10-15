import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./errors.mjs";
import { buildUrl, requestJson } from "./transport.mjs";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const allowedGet = /^(iserver\/accounts|portfolio\/accounts|portfolio\/[A-Za-z0-9_-]+\/(summary|positions\/\d+)|iserver\/account\/(orders|trades)|iserver\/marketdata\/snapshot)$/;
let queue = Promise.resolve();
let lastRequestAt = 0;
const lastByEndpoint = new Map();

export async function makeIbkrClient(input, { defaultBase, caFile, allowTests = false, signal } = {}) {
  let base;
  try { base = new URL(input.ibkr_base_url || defaultBase); }
  catch { throw new AppError("INVALID_IBKR_URL", "Enter a valid IBKR API URL."); }
  const local = loopback.has(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, "") !== "/v1/api" ||
      !(local || base.hostname === "api.ibkr.com") ||
      !(base.protocol === "https:" || (allowTests && local && base.protocol === "http:")) ||
      (!local && base.port && base.port !== "443")) {
    throw new AppError("INVALID_IBKR_URL", "Use https://localhost:5000/v1/api for the Gateway or https://api.ibkr.com/v1/api for OAuth.");
  }
  const token = typeof input.ibkr_bearer_token === "string" ? input.ibkr_bearer_token.trim() : "";
  if (local && token) throw new AppError("AUTH_MODE_MISMATCH", "Leave the OAuth token empty when using the local Gateway.");
  if (!local && !token) throw new AppError("OAUTH_TOKEN_REQUIRED", "Remote IBKR access requires an issued OAuth bearer token. This app does not perform OAuth registration or token exchange.");
  let ca;
  if (local && base.protocol === "https:" && caFile) {
    try { ca = await fs.readFile(caFile); }
    catch { throw new AppError("GATEWAY_CERTIFICATE", "The configured Gateway certificate file is missing.", 503); }
  }
  const client = {
    local, base: base.href, loginUrl: local ? base.origin + "/" : null, signal,
    async request(method, endpoint, query = {}, body) {
      if (!(method === "GET" && allowedGet.test(endpoint)) && !(method === "POST" && ["iserver/auth/status", "iserver/auth/ssodh/init", "tickle"].includes(endpoint))) {
        throw new AppError("READ_ONLY_BOUNDARY", "This IBKR operation is not permitted.", 403);
      }
      if (endpoint === "iserver/auth/ssodh/init" && (!body || body.publish !== true || body.compete !== false || Object.keys(body).sort().join() !== "compete,publish")) {
        throw new AppError("SESSION_TAKEOVER_BLOCKED", "Brokerage initialization must not take over another session.", 403);
      }
      const work = async () => {
        signal?.throwIfAborted();
        const paced = ["portfolio/accounts", "iserver/account/orders", "iserver/account/trades"].includes(endpoint);
        const waitMs = Math.max(0, lastRequestAt + 125 - Date.now(), paced ? (lastByEndpoint.get(endpoint) || 0) + 5100 - Date.now() : 0);
        if (waitMs) await delay(waitMs, undefined, { signal });
        lastRequestAt = Date.now();
        if (paced) lastByEndpoint.set(endpoint, lastRequestAt);
        try {
          const value = await requestJson(buildUrl(base, endpoint, query), {
            method, body, ca, signal, retry: !paced,
            headers: { "User-Agent": "IBKR Options Advisor/1.1", Accept: "*/*", Connection: "close", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
          });
          if (value && !Array.isArray(value) && typeof value === "object" && value.error) throw new AppError("IBKR_RESPONSE_ERROR", "IBKR returned an error instead of the requested data.", 502);
          return value;
        } catch (error) {
          if ([401, 403].includes(error.upstreamStatus)) {
            throw new AppError(error.upstreamStatus === 401 ? "IBKR_LOGIN_REQUIRED" : "IBKR_ACCESS_DENIED",
              local ? error.upstreamStatus === 401
                ? "The Gateway is reachable, but IBKR rejected its API session (401). The Gateway's 'Client login succeeds' page does not confirm API access."
                : "The Gateway is reachable, but IBKR denied API access for this session (403). Account permissions may need review."
                : "IBKR rejected the OAuth token or its access permissions.", error.upstreamStatus,
              { login_url: client.loginUrl, auth_mode: local ? "gateway" : "oauth_token", upstream_status: error.upstreamStatus });
          }
          throw error;
        }
      };
      const next = queue.then(work, work);
      queue = next.catch(() => {});
      return next;
    }
  };
  return client;
}

export async function checkConnection(ibkr) {
  let status = await ibkr.request("POST", "iserver/auth/status", {}, {});
  if (!status || typeof status.authenticated !== "boolean" || typeof status.connected !== "boolean") {
    throw new AppError("INVALID_AUTH_RESPONSE", "IBKR did not return a recognizable session status.", 502);
  }
  if (status.competing === true) throw new AppError("IBKR_COMPETING_SESSION", "IBKR reports another active brokerage session for this username.", 409, { login_url: ibkr.loginUrl });
  if (!status.connected || !status.authenticated) {
    // Browser SSO and the brokerage session are separate. Never compete with another login.
    const initialized = await ibkr.request("POST", "iserver/auth/ssodh/init", {}, { publish: true, compete: false });
    if (initialized?.competing) throw new AppError("IBKR_COMPETING_SESSION", "Another IBKR brokerage session is active; it was left connected.", 409);
    await delay(2000, undefined, { signal: ibkr.signal });
    status = await ibkr.request("POST", "iserver/auth/status", {}, {});
    if (status?.competing) throw new AppError("IBKR_COMPETING_SESSION", "Another IBKR brokerage session is active; it was left connected.", 409);
    if (status?.connected !== true || status?.authenticated !== true) {
      throw new AppError("IBKR_BROKERAGE_NOT_READY", "Browser login was accepted, but IBKR has not established the brokerage connection. A session conflict, account permission or broker-side issue may need review.", 409,
        { connected: status?.connected === true, authenticated: status?.authenticated === true, login_url: ibkr.loginUrl });
    }
  }
  const accounts = accountIds(await ibkr.request("GET", "iserver/accounts"));
  if (!accounts.length) throw new AppError("IBKR_NO_ACCOUNTS", "IBKR is authenticated but has not made an account available.", 409);
  return accounts;
}

export async function inspectConnection(ibkr) {
  const accounts = accountIds(await ibkr.request("GET", "portfolio/accounts"));
  if (!accounts.length) throw new AppError("IBKR_NO_ACCOUNTS", "Browser login has no accessible portfolio account.", 409);
  try {
    const brokerageAccounts = await checkConnection(ibkr);
    const shared = accounts.filter(account => brokerageAccounts.includes(account));
    if (!shared.length) throw new AppError("ACCOUNT_MISMATCH", "Portfolio and brokerage accounts do not match.", 409);
    return { accounts: shared, brokerage: true, portfolio_initialized: true };
  }
  catch (error) {
    if (!["IBKR_LOGIN_REQUIRED", "IBKR_ACCESS_DENIED", "IBKR_BROKERAGE_NOT_READY", "IBKR_COMPETING_SESSION", "IBKR_RESPONSE_ERROR"].includes(error.code)) throw error;
    // A valid browser session can still read the portfolio while brokerage/quotes are unavailable.
    // Do not tell the user to enter their password again when that outer session already works.
    return { accounts, brokerage: false, portfolio_initialized: true, brokerage_error: error.code };
  }
}

export function accountIds(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.accounts;
  if (!Array.isArray(rows)) throw new AppError("INVALID_ACCOUNTS", "IBKR returned malformed account data.", 502);
  const ids = rows.map(row => typeof row === "string" ? row : row?.accountId || row?.id);
  if (ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))) throw new AppError("INVALID_ACCOUNTS", "IBKR returned malformed account identifiers.", 502);
  return [...new Set(ids)];
}

export async function readAllPositions(ibkr, accountId, maxPages = 20) {
  const all = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const rows = await ibkr.request("GET", `portfolio/${accountId}/positions/${page}`);
    if (!Array.isArray(rows)) throw new AppError("INVALID_POSITIONS", "IBKR returned malformed positions; analysis was stopped.", 502);
    if (rows.length === 0) return all;
    for (const row of rows) {
      const id = row?.conid;
      if (id !== undefined && seen.has(String(id))) throw new AppError("UNSTABLE_POSITIONS", "Duplicate positions appeared during pagination. Refresh the portfolio before analyzing.", 409);
      if (id !== undefined) seen.add(String(id));
      if (row?.acctId && row.acctId !== accountId || row?.accountId && row.accountId !== accountId) throw new AppError("ACCOUNT_MISMATCH", "IBKR returned positions for a different account.", 502);
      all.push(row);
    }
  }
  throw new AppError("POSITION_LIMIT", "Position paging reached the safety limit. A partial portfolio will not be analyzed.", 422);
}

export async function readSnapshots(ibkr, conids, { signal } = {}) {
  const ids = [...new Set(conids)];
  const all = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const query = { conids: ids.slice(offset, offset + 100).join(","), fields: "31,84,86,6509,7308,7309,7310,7311" };
    let rows;
    for (let attempt = 0; attempt < 3; attempt++) {
      rows = await ibkr.request("GET", "iserver/marketdata/snapshot", query);
      if (!Array.isArray(rows)) throw new AppError("INVALID_QUOTES", "IBKR returned malformed market snapshots.", 502);
      if (rows.length === query.conids.split(",").length && rows.every(row => row[84] !== undefined && row[86] !== undefined && row._updated)) break;
      if (attempt < 2) await delay(600, undefined, { signal });
    }
    all.push(...rows);
  }
  return all;
}
