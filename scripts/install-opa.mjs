// Downloads a pinned OPA binary into .opa/ (gitignored) and verifies its
// SHA-256, so `pnpm test` is fully self-contained and version-controlled —
// contributors do not need to install OPA themselves.
//
// Used two ways:
//   - `pnpm i` runs it via the package.json "prepare" script (local installs).
//   - scripts/test-policies.mjs imports ensureOpa() and self-provisions, so it
//     works even in CI where the dependency install runs with --ignore-scripts.
//
// Set OPA_BIN to use your own OPA binary instead of the pinned download.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPA_VERSION = "v1.17.1";

// SHA-256 of each pinned OPA release artifact, keyed by `${platform}-${arch}`.
// Source: https://openpolicyagent.org/downloads/<OPA_VERSION>/<file>
const ARTIFACTS = {
  "darwin-arm64": { file: "opa_darwin_arm64", sha256: "6ebb6e2cb9af89c5c0b35769e4d17282e421580d2f6d177d052d604da6f7428a" },
  "darwin-x64": { file: "opa_darwin_amd64", sha256: "a94988f2a8eecad499e9f3c287074802c90b7f05a6c6e7e33742a0a538186282" },
  "linux-x64": { file: "opa_linux_amd64_static", sha256: "3d4bb88482958d990351ec5d2f7558509992776bc473bc1b78d86d76cb993ca3" },
  "linux-arm64": { file: "opa_linux_arm64_static", sha256: "2733c6cb81ce26b5b0d42efc3f55860ce0e3470e7077d795d4b219a54052db74" },
};

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const opaDir = path.join(repoRoot, ".opa");
const opaBin = path.join(opaDir, process.platform === "win32" ? "opa.exe" : "opa");

// Returns a path to a usable OPA binary, downloading + verifying the pinned
// version into .opa/ if necessary. Honors OPA_BIN.
export async function ensureOpa() {
  if (process.env.OPA_BIN) {
    return process.env.OPA_BIN;
  }

  const key = `${process.platform}-${process.arch}`;
  const artifact = ARTIFACTS[key];
  if (!artifact) {
    throw new Error(
      `No pinned OPA build for platform '${key}'. ` +
        `Install OPA ${OPA_VERSION} yourself and set OPA_BIN to its path.`,
    );
  }

  if (existsSync(opaBin) && sha256File(opaBin) === artifact.sha256) {
    return opaBin; // already present and verified — nothing to do
  }

  const url = `https://openpolicyagent.org/downloads/${OPA_VERSION}/${artifact.file}`;
  process.stderr.write(`Downloading OPA ${OPA_VERSION} (${artifact.file})...\n`);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download OPA from ${url}: HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(
      `OPA checksum mismatch for ${artifact.file}:\n` +
        `  expected ${artifact.sha256}\n  actual   ${actual}`,
    );
  }

  mkdirSync(opaDir, { recursive: true });
  const tmp = `${opaBin}.download`;
  writeFileSync(tmp, bytes);
  chmodSync(tmp, 0o755);
  renameSync(tmp, opaBin); // atomic swap so a partial download is never used
  process.stderr.write(`OPA ${OPA_VERSION} ready at ${path.relative(repoRoot, opaBin)}\n`);
  return opaBin;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Allow running directly: `node scripts/install-opa.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureOpa().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
