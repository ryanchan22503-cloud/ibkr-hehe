import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.mjs";

export function marketMath(input, { signal } = {}) {
  signal?.throwIfAborted();
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload) > 2500000) throw new AppError("MARKET_MATH_LIMIT", "Market calculation input is too large.");
  return new Promise((resolve, reject) => {
    const child = spawn(fileURLToPath(new URL("../.tws-venv/Scripts/python.exe", import.meta.url)),
      ["-I", "-u", fileURLToPath(new URL("../bridge/market_math.py", import.meta.url))], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "", failure;
    const fail = () => { failure = new AppError("MARKET_MATH_UNAVAILABLE", "Local market calculations were unavailable.", 503); child.kill(); };
    const abort = () => { failure = signal.reason; child.kill(); };
    const timer = setTimeout(fail, 15000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", data => { output += data; if (output.length > 512000) fail(); });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.ok !== true) throw new Error();
        resolve(result);
      } catch { reject(new AppError("MARKET_MATH_UNAVAILABLE", "Local market calculations were unavailable.", 503)); }
    });
    child.stdin.end(payload);
  });
}
