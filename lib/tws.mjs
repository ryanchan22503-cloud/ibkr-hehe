import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.mjs";
import { accountIds } from "./ibkr.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let busy = false;
const errors = {
  TWS_NOT_READY: "Open Trader Workstation and finish its login. In TWS API Settings, enable socket clients, keep Read-Only API checked, and match the dashboard port.",
  TWS_DISCONNECTED: "TWS lost its IBKR connection. No partial portfolio was analyzed. Reconnect TWS and test again.",
  TWS_CLIENT_IN_USE: "Another connection is using the advisor's TWS client ID. Close that connection and try again.",
  TWS_ACCOUNTS: "TWS did not supply a valid account list.",
  ACCOUNT_SELECTION_REQUIRED: "TWS returned multiple accounts. Enter the account ID to review.",
  INVALID_ACCOUNT: "The requested account is not available in the TWS session.",
  TWS_POSITIONS_INCOMPLETE: "TWS did not finish sending the portfolio. A partial portfolio will not be analyzed.",
  TWS_POSITION_LIMIT: "The TWS portfolio exceeds this advisor's safety limit. No partial review was made.",
  TWS_CONTRACT_MISMATCH: "TWS supplied ambiguous or inconsistent contract details. Analysis was stopped.",
  TWS_DEPENDENCY: "The local TWS connector runtime is missing. Run the TWS connector setup first.",
  TWS_WORKER: "The TWS connector stopped unexpectedly. No partial data was used.",
  INVALID_TWS_INPUT: "TWS connection settings are invalid."
};

export function brokerMode(input, defaultMode = "gateway") {
  const mode = input.broker_mode === undefined ? defaultMode : input.broker_mode;
  if (!["gateway", "tws"].includes(mode)) throw new AppError("INVALID_BROKER_MODE", "Choose TWS or Client Portal Gateway.");
  return mode;
}

export function twsSettings(input, action) {
  const port = input.tws_port === undefined ? 7496 : input.tws_port;
  if (!Number.isInteger(port) || ![7496, 7497].includes(port) || !["status", "portfolio"].includes(action)) {
    throw new AppError("INVALID_TWS_INPUT", "Choose the TWS live port (7496) or paper port (7497).");
  }
  if (input.tws_host !== undefined && input.tws_host !== "127.0.0.1") throw new AppError("INVALID_TWS_INPUT", "TWS must run on this laptop.");
  const account = input.account_id === undefined ? "" : input.account_id;
  if (typeof account !== "string" || account.length > 64 || account && !/^[A-Za-z0-9_-]+$/.test(account)) throw new AppError("INVALID_ACCOUNT", "Account ID must be valid text.");
  if (input.scan_ideas !== undefined && typeof input.scan_ideas !== "boolean") throw new AppError("INVALID_TWS_INPUT", "Candidate screening must be on or off.");
  return { action, port, account_id: account, ...(action === "portfolio" && input.scan_ideas ? { scan_ideas: true } : {}) };
}

export function validateTwsReply(data, action) {
  if (!data || data.ok !== true || data.authenticated !== true || data.complete !== true) throw new AppError("TWS_WORKER", errors.TWS_WORKER, 502);
  const accounts = accountIds(data.accounts);
  if (!accounts.length) throw new AppError("TWS_ACCOUNTS", errors.TWS_ACCOUNTS, 502);
  if (action === "portfolio") {
    if (!accounts.includes(data.account_id) || !Array.isArray(data.positions) || data.positions.length > 500 || !Array.isArray(data.quotes) || data.quotes.length > 150) {
      throw new AppError("TWS_WORKER", errors.TWS_WORKER, 502);
    }
    if (data.positions.some(row => !row || row.accountId !== data.account_id)) throw new AppError("ACCOUNT_MISMATCH", "TWS portfolio account mismatch.", 502);
    if (data.account_values !== undefined && (!Array.isArray(data.account_values) || data.account_values.length > 200)) throw new AppError("TWS_WORKER", errors.TWS_WORKER, 502);
    if (data.observed_open_order_count != null && (!Number.isInteger(data.observed_open_order_count) || data.observed_open_order_count < 0 || data.observed_open_order_count > 500)) throw new AppError("TWS_WORKER", errors.TWS_WORKER, 502);
    for (const [key, max] of [["orders", 500], ["executions", 2000], ["candidate_positions", 8], ["screen", 12]]) {
      if (data[key] != null && (!Array.isArray(data[key]) || data[key].length > max)) throw new AppError("TWS_WORKER", errors.TWS_WORKER, 502);
    }
    if (data.candidate_positions?.some(row => row.accountId !== data.account_id)) throw new AppError("ACCOUNT_MISMATCH", "Candidate account mismatch.", 502);
  }
  return { ...data, accounts };
}

export async function readTws(input, action, { signal, python = process.env.TWS_PYTHON || path.join(root, ".tws-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
  worker = path.join(root, "bridge/tws_bridge.py"), timeoutMs = 120_000 } = {}) {
  const settings = twsSettings(input, action);
  signal?.throwIfAborted();
  if (busy) throw new AppError("TWS_BUSY", "A TWS read is already running. Wait for it or cancel the analysis.", 409);
  busy = true;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(python, ["-I", "-u", worker], { cwd: root, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] });
      let output = "";
      let bytes = 0;
      let failure;
      const fail = error => { failure ||= error; child.kill(); };
      const abort = () => fail(new DOMException("Cancelled", "AbortError"));
      const timer = setTimeout(() => fail(new AppError("TWS_TIMEOUT", "TWS did not finish in time. No partial portfolio was used.", 504)), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.on("error", () => { failure ||= new AppError("TWS_DEPENDENCY", errors.TWS_DEPENDENCY, 503); });
      child.stdout.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 2_000_000) return fail(new AppError("TWS_RESPONSE_LIMIT", "TWS response exceeded the safety limit.", 502));
        output += chunk.toString("utf8");
      });
      child.stdin.on("error", () => {});
      child.once("close", code => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure) return reject(failure);
        try {
          if (code !== 0) throw new AppError("TWS_WORKER", errors.TWS_WORKER, 502);
          const data = JSON.parse(output);
          if (data?.ok === false) {
            const known = Object.hasOwn(errors, data.code) ? data.code : "TWS_WORKER";
            throw new AppError(known, errors[known], 503);
          }
          const validated = validateTwsReply(data, action);
          if (action === "portfolio" && settings.account_id && validated.account_id !== settings.account_id) throw new AppError("ACCOUNT_MISMATCH", "TWS returned another account.", 502);
          resolve(validated);
        } catch (error) { reject(error instanceof AppError ? error : new AppError("TWS_WORKER", errors.TWS_WORKER, 502)); }
      });
      child.stdin.end(JSON.stringify(settings));
    });
  } finally { busy = false; }
}
