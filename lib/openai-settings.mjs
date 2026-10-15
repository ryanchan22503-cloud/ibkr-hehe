import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.mjs";

const helper = fileURLToPath(new URL("../bridge/protect_settings.py", import.meta.url));
const python = fileURLToPath(new URL("../.tws-venv/Scripts/python.exe", import.meta.url));
const unavailable = () => new AppError("OPENAI_SETTINGS_UNAVAILABLE", "Saved AI settings could not be opened or saved. Local-only review is still available. You can replace or forget the saved settings.", 503);

export function validateOpenAiSettings(value) {
  const key = value?.openai_api_key;
  const model = value?.openai_model;
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,512}$/.test(key)) {
    throw new AppError("OPENAI_KEY_REQUIRED", "Enter an OpenAI API key, or turn off Include AI review.");
  }
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model) || model.startsWith("sk-") || model === key) {
    throw new AppError("OPENAI_MODEL_REQUIRED", "Enter an OpenAI model ID, not an API key.");
  }
  return { openai_api_key: key, openai_model: model };
}

// Only stdin/stdout carry the secret; no arguments, shell interpolation or logs.
export function windowsProtect(operation, bytes, maxBytes = 8192) {
  if (process.platform !== "win32") return Promise.reject(unavailable());
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 8192 || maxBytes > 512_000 || !["protect", "unprotect"].includes(operation) || bytes.length > maxBytes) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", "-u", helper], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
    });
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = () => { failed = true; child.kill(); };
    const timer = setTimeout(fail, 5000);
    child.on("error", () => { clearTimeout(timer); reject(unavailable()); });
    child.stdin.on("error", fail);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > Math.ceil(maxBytes / 3) * 4 + 8) fail();
      else chunks.push(chunk);
    });
    child.once("close", code => {
      clearTimeout(timer);
      const encoded = Buffer.concat(chunks).toString("utf8").trim();
      for (const chunk of chunks) chunk.fill(0);
      if (failed || code !== 0 || !encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return reject(unavailable());
      const result = Buffer.from(encoded, "base64");
      if (result.toString("base64") !== encoded || result.length > maxBytes) return reject(unavailable());
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ operation, data: bytes.toString("base64") }));
  });
}

export function createOpenAiSettingsStore({ directory = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "IBKROptionsAdvisor"), protect = windowsProtect } = {}) {
  const filename = directory && path.join(directory, "openai-settings.v1.dpapi");
  let pending = Promise.resolve();
  const serialized = action => {
    const result = pending.then(action);
    pending = result.catch(() => {});
    return result;
  };
  async function read() {
    if (!filename) throw unavailable();
    let data;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size > 8192) throw unavailable();
      data = await fs.readFile(filename);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw unavailable();
    }
    let plaintext;
    try {
      plaintext = await protect("unprotect", data);
      const value = JSON.parse(plaintext.toString("utf8"));
      if (value.version !== 1) throw unavailable();
      return validateOpenAiSettings(value);
    } catch { throw unavailable(); }
    finally { plaintext?.fill(0); }
  }
  const metadata = value => ({ saved: Boolean(value), model: value?.openai_model || "", storage: "windows-current-user" });
  return {
    read: () => serialized(read),
    metadata: () => serialized(async () => metadata(await read())),
    save: input => serialized(async () => {
      if (!input || Object.keys(input).some(key => !["openai_api_key", "openai_model"].includes(key))) {
        throw new AppError("INVALID_SETTINGS", "Only an OpenAI API key and model can be saved.");
      }
      const previous = input.openai_api_key === "" || input.openai_api_key === undefined ? await read() : null;
      const value = validateOpenAiSettings({ ...input, openai_api_key: input.openai_api_key || previous?.openai_api_key });
      if (!filename) throw unavailable();
      const plaintext = Buffer.from(JSON.stringify({ version: 1, ...value }));
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        const encrypted = await protect("protect", plaintext);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, filename);
        return metadata(value);
      } catch { throw unavailable(); }
      finally { plaintext.fill(0); await fs.unlink(temporary).catch(() => {}); }
    }),
    forget: () => serialized(async () => {
      if (!filename) throw unavailable();
      try { await fs.unlink(filename); }
      catch (error) { if (error.code !== "ENOENT") throw unavailable(); }
      return metadata(null);
    })
  };
}

export async function resolveOpenAiSettings(input, store) {
  if (input.use_ai !== undefined && typeof input.use_ai !== "boolean") throw new AppError("INVALID_SETTINGS", "Include AI review must be on or off.");
  if (input.use_ai === false) return null;
  const explicit = input.openai_api_key !== undefined && input.openai_api_key !== "";
  // Older clients with an empty key remain local-only even when settings exist.
  if (input.use_ai !== true && !explicit) return null;
  if (explicit) return validateOpenAiSettings(input);
  const saved = await store.read();
  return validateOpenAiSettings({ openai_api_key: saved?.openai_api_key, openai_model: input.openai_model || saved?.openai_model });
}
