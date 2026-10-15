import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";
import { windowsProtect } from "./openai-settings.mjs";

export const PROVIDERS = ["tradier", "alpha_vantage"];
const unavailable = () => new AppError("DATA_SETTINGS_UNAVAILABLE", "Saved data-source keys could not be opened. Use Forget all data-source keys to reset only these keys, then enter them again.", 503);
export function validateDataSetting(input) {
  if (!input || Object.keys(input).some(k => !["provider", "key", "mode", "enabled"].includes(k)) ||
      !PROVIDERS.includes(input.provider) || typeof input.key !== "string" || !/^[A-Za-z0-9._-]{8,512}$/.test(input.key) ||
      typeof input.enabled !== "boolean" || !["sandbox", "live"].includes(input.mode) || input.provider === "alpha_vantage" && input.mode !== "live") {
    throw new AppError("INVALID_DATA_SETTINGS", "Choose a data source, enter its API key or token, and select the matching environment.");
  }
  return { provider: input.provider, key: input.key, mode: input.mode, enabled: input.enabled };
}

export function createDataSettingsStore({ directory = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "IBKROptionsAdvisor"), protect = windowsProtect } = {}) {
  const filename = directory && path.join(directory, "data-sources.v1.dpapi");
  let pending = Promise.resolve();
  const serial = fn => { const next = pending.then(fn); pending = next.catch(() => {}); return next; };
  const meta = rows => Object.fromEntries(PROVIDERS.map(p => [p, { saved: Boolean(rows[p]), enabled: rows[p]?.enabled || false,
    mode: rows[p]?.mode || (p === "tradier" ? "sandbox" : "live"), storage: "windows-current-user" }]));
  async function read() {
    if (!filename) throw unavailable();
    let plain;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size > 8192) throw unavailable();
      plain = await protect("unprotect", await fs.readFile(filename));
      const saved = JSON.parse(plain.toString("utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.sources) || saved.sources.length > 2) throw unavailable();
      const rows = {};
      for (const source of saved.sources) {
        const value = validateDataSetting(source);
        if (rows[value.provider]) throw unavailable();
        rows[value.provider] = value;
      }
      return rows;
    } catch (error) { if (error.code === "ENOENT") return {}; throw unavailable(); }
    finally { plain?.fill(0); }
  }
  async function write(rows) {
    if (!filename) throw unavailable();
    const plain = Buffer.from(JSON.stringify({ version: 1, sources: Object.values(rows) }));
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      const encrypted = await protect("protect", plain);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temp, encrypted, { flag: "wx", mode: 0o600 });
      await fs.rename(temp, filename);
      return meta(rows);
    } catch { throw unavailable(); }
    finally { plain.fill(0); await fs.unlink(temp).catch(() => {}); }
  }
  return {
    read: () => serial(read), metadata: () => serial(async () => meta(await read())),
    reset: () => serial(async () => {
      if (!filename) throw unavailable();
      try { await fs.unlink(filename); } catch (error) { if (error.code !== "ENOENT") throw unavailable(); }
      return meta({});
    }),
    save: input => serial(async () => {
      if (!PROVIDERS.includes(input?.provider)) throw new AppError("INVALID_DATA_SETTINGS", "Unknown data source.");
      const rows = await read();
      const source = validateDataSetting({ ...input, key: input.key || rows[input.provider]?.key });
      rows[source.provider] = source;
      return write(rows);
    }),
    forget: provider => serial(async () => {
      if (!PROVIDERS.includes(provider)) throw new AppError("INVALID_DATA_SETTINGS", "Unknown data source.");
      const rows = await read();
      delete rows[provider];
      return write(rows);
    })
  };
}
