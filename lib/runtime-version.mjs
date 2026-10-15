import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// The server imports JS once, but launches the Python reader afresh for each read.
// Refuse a mixed deployment instead of interpreting new data with old validators.
export async function sourceVersion(root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const full = path.join(root, relative);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile() && /\.(mjs|js|py|html|css)$/.test(entry.name)) await visit(path.join(relative, entry.name));
      }
    } else {
      hash.update(relative);
      hash.update(await fs.readFile(full));
    }
  }
  for (const relative of ["server.mjs", "lib", "bridge", "public"]) await visit(relative);
  return hash.digest("hex").slice(0, 16);
}
