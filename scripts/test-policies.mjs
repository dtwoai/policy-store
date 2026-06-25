// Compiles every catalog policy with `opa check --strict` and runs its test
// cases against the real OPA evaluator, asserting the documented outcome.
//
// Each policy ships a `tests.yaml` next to its `policy.md`: a YAML file
// holding a top-level array of test cases. Each entry:
//   - description: string                        // what the case demonstrates
//   - input:       { ...PARC decision object }   // input.resource/subject/action/...
//   - output:                                    // the published-schema outcome
//       expectedResult: "allow" | "deny"         // required: data.<pkg>.allow
//       expectedReason: "exact reason"           // optional: data.<pkg>.reason must equal it exactly
//   # Gate-only assertions below. These are NOT part of the published test
//   # schema (d2 strips them when importing tests.yaml); they let this runner keep
//   # checking transform behaviour, which expectedResult cannot express.
//   - transformApplied:       true | false       // optional: whether data.<pkg>.transform is present
//   - transform:              { ... }            // optional: asserted field by field
//   - transformedArgsContain: { ... }            // optional: data.<pkg>.transform.transformed_payload must contain these
//
// IMPORTANT: the test's PARC object lives under the `input` key, and this runner
// feeds ONLY that object to OPA as the input document. Do not hand OPA the whole
// test object — it would read input.input.*, every rule would miss, and a deny
// policy would wrongly report allow=true.
//
// Requires the `opa` binary (v1.x) on PATH, or set OPA_BIN to its path.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const appsDir = path.join(root, "apps");
const opa = process.env.OPA_BIN ?? "opa";

const failures = [];
let policyCount = 0;
let testCount = 0;

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

console.log(
	`\nOK: ${policyCount} ${plural(policyCount, "policy", "policies")}, ${testCount} ${plural(testCount, "test", "tests")} passed.`,
);

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

		const testsFile = path.join(policyDir, "tests.yaml");
		if (!existsSync(testsFile)) {
			failures.push(
				`${rel}: no tests.yaml alongside policy.md (at least one test is required)`,
			);
			return;
		}

		const testsRel = toPosix(path.relative(root, testsFile));
		const tests = parseTests(readFileSync(testsFile, "utf8"), testsRel);
		if (tests === null) {
			return;
		}
		if (tests.length === 0) {
			failures.push(`${testsRel}: contains no tests`);
			return;
		}

		tests.forEach((test, index) => {
			testCount += 1;
			runTest(test, `${testsRel} [${index}]`, regoFile, pkg);
		});
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// Parses a tests.yaml file into the array of test cases. Returns null (recording
// a failure) when the YAML is invalid or is not a top-level array.
function parseTests(yaml, context) {
	let data;
	try {
		data = parse(yaml);
	} catch (error) {
		failures.push(`${context}: invalid YAML: ${error.message}`);
		return null;
	}

	if (!Array.isArray(data)) {
		failures.push(`${context}: must be a YAML array of tests`);
		return null;
	}
	return data;
}

function runTest(test, rel, regoFile, pkg) {
	if (!isPlainObject(test)) {
		failures.push(`${rel}: test must be an object`);
		return;
	}
	if (test.input === undefined) {
		failures.push(`${rel}: missing "input" (the PARC decision object)`);
		return;
	}
	if (!isPlainObject(test.output)) {
		failures.push(`${rel}: missing "output" object`);
		return;
	}

	const expectedResult = test.output.expectedResult;
	if (expectedResult !== "allow" && expectedResult !== "deny") {
		failures.push(`${rel}: "output.expectedResult" must be "allow" or "deny"`);
		return;
	}

	let decision;
	try {
		const out = execFileSync(
			opa,
			[
				"eval",
				"--format",
				"json",
				"--data",
				regoFile,
				"--stdin-input",
				`data.${pkg}`,
			],
			{ input: JSON.stringify(test.input), stdio: ["pipe", "pipe", "pipe"] },
		);
		decision = JSON.parse(out).result?.[0]?.expressions?.[0]?.value ?? {};
	} catch (error) {
		failures.push(`${rel}: opa eval failed:\n    ${stderr(error)}`);
		return;
	}

	const expectAllow = expectedResult === "allow";
	if (decision.allow !== expectAllow) {
		failures.push(
			`${rel}: expected ${expectedResult} (allow=${expectAllow}), got allow=${JSON.stringify(decision.allow)}`,
		);
	}

	if (typeof test.output.expectedReason === "string") {
		if (decision.reason !== test.output.expectedReason) {
			failures.push(
				`${rel}: expected reason ${JSON.stringify(test.output.expectedReason)}, got ${JSON.stringify(decision.reason)}`,
			);
		}
	}

	// Gate-only transform assertions (not part of the published test schema).
	if (typeof test.transformApplied === "boolean") {
		const applied =
			isPlainObject(decision.transform) &&
			Object.keys(decision.transform).length > 0;
		if (applied !== test.transformApplied) {
			failures.push(
				`${rel}: expected transformApplied=${test.transformApplied}, got ${applied}`,
			);
		}
	}

	if (isPlainObject(test.transform)) {
		for (const [key, want] of Object.entries(test.transform)) {
			const got = decision.transform?.[key];
			if (JSON.stringify(got) !== JSON.stringify(want)) {
				failures.push(
					`${rel}: expected transform.${key}=${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
				);
			}
		}
	}

	// The transform rewrites the call's args under transform.transformed_payload;
	// assert the expected key/values survived the rewrite.
	if (isPlainObject(test.transformedArgsContain)) {
		const args = decision.transform?.transformed_payload;
		for (const [key, want] of Object.entries(test.transformedArgsContain)) {
			const got = args?.[key];
			if (JSON.stringify(got) !== JSON.stringify(want)) {
				failures.push(
					`${rel}: expected transformed_payload.${key}=${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
				);
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
		failures.push(
			`${context}: expected exactly one fenced rego block in the policy body, found ${blocks.length}`,
		);
		return null;
	}
	return blocks[0][1].trim();
}

function extractPackage(rego, context) {
	const match = rego.match(/^package\s+([A-Za-z0-9_.]+)/m);
	if (!match) {
		failures.push(
			`${context}: could not find a 'package' declaration in the rego block`,
		);
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
		console.error(
			`Could not run '${opa}'. Install the OPA CLI (v1.x) and put it on PATH, or set OPA_BIN to its path.`,
		);
		console.error(
			"Install instructions: https://www.openpolicyagent.org/docs/latest/#running-opa",
		);
		process.exit(1);
	}
}

function stderr(error) {
	return (
		error.stderr?.toString() ||
		error.stdout?.toString() ||
		error.message ||
		""
	)
		.trim()
		.replace(/\n/g, "\n    ");
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
