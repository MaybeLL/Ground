import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const cliVersion = (): string => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(moduleDirectory, "../package.json"), resolve(moduleDirectory, "../../package.json")]) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof manifest.version === "string" && manifest.version) return manifest.version;
    } catch { /* try the next candidate */ }
  }
  return "0.0.0";
};
