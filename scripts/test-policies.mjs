// Compiles every catalog policy with `opa check --strict` and runs its test
// fixtures against the real OPA evaluator, asserting the documented outcome.
//
// Fixture contract (apps/<app>/<policy>/tests/*.json):
//   {
//     "description": "...",
//     "input":    { ...the PARC decision input (input.resource/subject/action/...) },
//     "expected": {
//       "allow": true | false,                 // required
//       "reasonContains": "substring",         // optional: data.<pkg>.reason must contain it
//       "transformApplied": true | false,      // optional: whether data.<pkg>.transform is present
//       "transform": { "replacement": "..." }  // optional: asserted field-by-field
//     }
//   }
//
// IMPORTANT: the fixture's PARC object lives under the `input` key, and this
// runner feeds ONLY that object to OPA as the input document. Do not run
// `opa eval -i fixture.json` directly — OPA would treat the whole file
// (including `expected`) as input, so the policy would read input.input.* ,
// every rule would miss, and a deny policy would wrongly report allow=true.
//
// Requires the `opa` binary (v1.x) on PATH, or set OPA_BIN to its path.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const appsDir = path.join(root, "apps");
const opa = process.env.OPA_BIN ?? "opa";

const failures = [];
let policyCount = 0;
let fixtureCount = 0;

assertOpaAvailable();

for (const policyFilePath of findPolicyFiles(appsDir)) {
  policyCount += 1;
  runPolicy(policyFilePath);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`\nOK: ${policyCount} ${plural(policyCount, "policy", "policies")}, ${fixtureCount} ${plural(fixtureCount, "fixture", "fixtures")} passed.`);

function runPolicy(policyFilePath) {
  const rel = toPosix(path.relative(root, policyFilePath));
  const policyDir = path.dirname(policyFilePath);
  const markdown = readFileSync(policyFilePath, "utf8");

  const rego = extractRego(markdown, rel);
  if (rego === null) {
    return;
  }

  const pkg = extractPackage(rego, rel);
  const work = mkdtempSync(path.join(tmpdir(), "policy-test-"));
  const regoFile = path.join(work, "policy.rego");

  try {
    writeFileSync(regoFile, `${rego}\n`);

    try {
      execFileSync(opa, ["check", "--strict", regoFile], { stdio: "pipe" });
    } catch (error) {
      failures.push(`${rel}: opa check failed:\n    ${stderr(error)}`);
      return;
    }

    if (pkg === null) {
      return;
    }

    const testsDir = path.join(policyDir, "tests");
    if (!existsSync(testsDir)) {
      failures.push(`${rel}: no tests/ directory (at least one fixture is required)`);
      return;
    }

    const fixtures = readdirSync(testsDir)
      .filter((name) => name.endsWith(".json"))
      .sort(compareStrings);

    if (fixtures.length === 0) {
      failures.push(`${rel}: tests/ contains no .json fixtures`);
      return;
    }

    for (const fixtureName of fixtures) {
      fixtureCount += 1;
      runFixture(path.join(testsDir, fixtureName), regoFile, pkg);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function runFixture(fixturePath, regoFile, pkg) {
  const rel = toPosix(path.relative(root, fixturePath));

  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (error) {
    failures.push(`${rel}: invalid JSON: ${error.message}`);
    return;
  }

  if (fixture.input === undefined) {
    failures.push(`${rel}: missing "input" (the PARC decision object)`);
    return;
  }
  if (!isPlainObject(fixture.expected)) {
    failures.push(`${rel}: missing "expected" object`);
    return;
  }

  let decision;
  try {
    const out = execFileSync(
      opa,
      ["eval", "--format", "json", "--data", regoFile, "--stdin-input", `data.${pkg}`],
      { input: JSON.stringify(fixture.input), stdio: ["pipe", "pipe", "pipe"] },
    );
    decision = JSON.parse(out).result?.[0]?.expressions?.[0]?.value ?? {};
  } catch (error) {
    failures.push(`${rel}: opa eval failed:\n    ${stderr(error)}`);
    return;
  }

  const expected = fixture.expected;

  if (typeof expected.allow !== "boolean") {
    failures.push(`${rel}: missing "expected.allow" boolean`);
    return;
  }

  if (decision.allow !== expected.allow) {
    failures.push(`${rel}: expected allow=${expected.allow}, got ${JSON.stringify(decision.allow)}`);
  }

  if (typeof expected.reasonContains === "string") {
    if (typeof decision.reason !== "string" || !decision.reason.includes(expected.reasonContains)) {
      failures.push(`${rel}: expected reason to contain "${expected.reasonContains}", got ${JSON.stringify(decision.reason)}`);
    }
  }

  if (typeof expected.transformApplied === "boolean") {
    const applied = isPlainObject(decision.transform) && Object.keys(decision.transform).length > 0;
    if (applied !== expected.transformApplied) {
      failures.push(`${rel}: expected transformApplied=${expected.transformApplied}, got ${applied}`);
    }
  }

  if (isPlainObject(expected.transform)) {
    for (const [key, want] of Object.entries(expected.transform)) {
      const got = decision.transform?.[key];
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        failures.push(`${rel}: expected transform.${key}=${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
    }
  }
}

function extractRego(markdown, context) {
  // Mirror the manifest generator: extract from the body AFTER the frontmatter,
  // so a ```rego example inside the `description` isn't miscounted as the policy.
  const fmMatch = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const body = fmMatch ? markdown.slice(fmMatch[0].length) : markdown;
  const blocks = [...body.matchAll(/```rego\r?\n([\s\S]*?)\r?\n```/g)];
  if (blocks.length !== 1) {
    failures.push(`${context}: expected exactly one fenced rego block in the policy body, found ${blocks.length}`);
    return null;
  }
  return blocks[0][1].trim();
}

function extractPackage(rego, context) {
  const match = rego.match(/^package\s+([A-Za-z0-9_.]+)/m);
  if (!match) {
    failures.push(`${context}: could not find a 'package' declaration in the rego block`);
    return null;
  }
  return match[1];
}

function findPolicyFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const files = [];
  for (const appSlug of sortedDirNames(dir)) {
    const appPath = path.join(dir, appSlug);
    for (const policySlug of sortedDirNames(appPath)) {
      const policyFilePath = path.join(appPath, policySlug, "policy.md");
      if (existsSync(policyFilePath)) {
        files.push(policyFilePath);
      }
    }
  }
  return files;
}

function sortedDirNames(dir) {
  return readdirSync(dir)
    .filter((entry) => statSync(path.join(dir, entry)).isDirectory())
    .sort(compareStrings);
}

function assertOpaAvailable() {
  try {
    execFileSync(opa, ["version"], { stdio: "pipe" });
  } catch {
    console.error(`Could not run '${opa}'. Install the OPA CLI (v1.x) and put it on PATH, or set OPA_BIN to its path.`);
    console.error("Install instructions: https://www.openpolicyagent.org/docs/latest/#running-opa");
    process.exit(1);
  }
}

function stderr(error) {
  return (error.stderr?.toString() || error.stdout?.toString() || error.message || "").trim().replace(/\n/g, "\n    ");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

// Deterministic, locale-independent ordering by UTF-16 code unit.
function compareStrings(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
