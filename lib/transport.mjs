import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./errors.mjs";

export async function requestJson(url, options = {}) {
  const attempts = options.method === "POST" || options.retry === false ? 1 : 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await requestOnce(url, options); }
    catch (error) {
      if (attempt === attempts - 1 || ![429, 502, 503, 504].includes(error.upstreamStatus)) throw error;
      // Never retry authentication failures, model calls, or an unbounded Retry-After.
      if (error.retryAfter > 3) throw error;
      await delay(Math.max(250, (error.retryAfter || 1) * 1000), undefined, { signal: options.signal });
    }
  }
}

function requestOnce(url, { method = "GET", headers = {}, body, ca, signal, timeoutMs = 20_000, maxBytes = 2_000_000, textResponse = false, errorMetadata } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, {
      method, signal, ca, minVersion: "TLSv1.2",
      headers: { ...headers, ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) }
    }, res => {
      const chunks = [];
      let length = 0;
      res.on("data", chunk => {
        length += chunk.length;
        if (length > maxBytes) {
          reject(new AppError("RESPONSE_TOO_LARGE", "Upstream response exceeded the size limit.", 502));
          res.destroy();
          req.destroy();
        }
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("aborted", () => reject(new AppError("TRUNCATED_RESPONSE", "Upstream connection ended before the response completed.", 502)));
      res.on("end", () => {
        const status = res.statusCode || 502;
        if (status < 200 || status >= 300) {
          const error = new AppError("UPSTREAM_HTTP", `Upstream service returned HTTP ${status}.`, 502);
          const retryHeader = res.headers["retry-after"];
          const retryAfter = /^\d+$/.test(retryHeader || "") ? Number(retryHeader)
            : retryHeader ? Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1000) : 0;
          Object.assign(error, { upstreamStatus: status, retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0 });
          // Preserve only explicitly allowed machine codes, never upstream text
          // that may contain credentials, account identifiers or prompt content.
          if (errorMetadata && String(res.headers["content-type"]).toLowerCase().includes("json")) {
            try {
              const detail = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
              if (errorMetadata.codes?.includes(detail?.code)) error.upstreamCode = detail.code;
              if (errorMetadata.types?.includes(detail?.type)) error.upstreamType = detail.type;
            } catch { /* HTTP failure remains usable when its body is not JSON. */ }
          }
          return reject(error);
        }
        const contentType = String(res.headers["content-type"]).toLowerCase();
        if (textResponse && /^(text\/(csv|plain)|application\/(csv|json|x-download))\b/.test(contentType)) {
          return resolve(Buffer.concat(chunks).toString("utf8"));
        }
        if (!contentType.includes("json")) {
          return reject(new AppError("NON_JSON_RESPONSE", "Upstream returned a login page or another non-JSON response.", 502));
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new AppError("INVALID_UPSTREAM_JSON", "Upstream returned invalid JSON.", 502)); }
      });
    });
    // An absolute deadline also catches slow responses that keep the socket active.
    const timer = setTimeout(() => {
      reject(new AppError("UPSTREAM_TIMEOUT", "Upstream request timed out.", 504));
      req.destroy();
    }, timeoutMs);
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", error => {
      if (error instanceof AppError || error.name === "AbortError") return reject(error);
      const tls = /CERT|TLS|SSL|SELF_SIGNED/.test(error.code || "");
      reject(new AppError(tls ? "GATEWAY_CERTIFICATE" : "UPSTREAM_UNREACHABLE",
        tls ? "The Gateway certificate could not be verified. Check the configured localhost certificate." : "The upstream service is not reachable.", 502));
    });
    req.end(payload);
  });
}

export function buildUrl(base, endpoint, query = {}) {
  const normalized = new URL(base);
  normalized.pathname = normalized.pathname.replace(/\/$/, "") + "/";
  const url = new URL(endpoint, normalized);
  if (url.origin !== normalized.origin || !url.pathname.startsWith(normalized.pathname)) throw new AppError("INVALID_ENDPOINT", "Endpoint escaped the configured service.");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}
