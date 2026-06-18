import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const manifestPath = path.join(root, "manifest.json");
const schemaPath = path.join(root, "schema.json");
const checkOnly = process.argv.includes("--check");

const schema = readJson(schemaPath);
const schemaVersion = schema.schemaVersion;
const policyFields = schema.policy.fields;
const manifestPolicyFields = schema.manifest.policyEntry.fields;

const errors = [];

const policyPaths = findPolicyFiles(path.join(root, "apps"));
const policies = policyPaths.map((policyFilePath) => buildPolicyEntry(policyFilePath));

validateUniquePolicyPaths(policies);

const manifest = {
  policies: policies.sort((a, b) => compareStrings(a.path, b.path)),
  apps: buildFolderMap("apps"),
  industries: buildFolderMap("industries"),
  bundles: buildFolderMap("bundles"),
};

validateManifest(manifest);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const output = `${JSON.stringify(manifest, null, 2)}\n`;

if (checkOnly) {
  const current = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  if (current !== output) {
    console.error("manifest.json is out of date. Run `pnpm manifest` and commit the result.");
    process.exit(1);
  }

  console.log("manifest.json is up to date.");
} else {
  writeFileSync(manifestPath, output);
  const count = manifest.policies.length;
  console.log(`Wrote manifest.json with ${count} policy ${count === 1 ? "entry" : "entries"}.`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function findPolicyFiles(appsPath) {
  if (!existsSync(appsPath)) {
    return [];
  }

  const policyFiles = [];

  for (const appSlug of sortedDirectoryNames(appsPath)) {
    const appPath = path.join(appsPath, appSlug);

    for (const policySlug of sortedDirectoryNames(appPath)) {
      const policyFilePath = path.join(appPath, policySlug, "policy.md");
      if (existsSync(policyFilePath)) {
        policyFiles.push(policyFilePath);
      }
    }
  }

  return policyFiles;
}

function sortedDirectoryNames(directoryPath) {
  if (!existsSync(directoryPath)) {
    return [];
  }

  return readdirSync(directoryPath)
    .filter((entry) => {
      const entryPath = path.join(directoryPath, entry);
      return statSync(entryPath).isDirectory();
    })
    .sort(compareStrings);
}

function buildPolicyEntry(policyFilePath) {
  const relativePolicyPath = toPosix(path.relative(root, policyFilePath));
  const policyDirectory = path.dirname(policyFilePath);
  const relativePolicyDirectory = toPosix(path.relative(root, policyDirectory));
  const markdown = readFileSync(policyFilePath, "utf8");
  const parsedPolicy = parsePolicyMarkdown(markdown, relativePolicyPath);

  validatePolicyMetadata(parsedPolicy.metadata, relativePolicyPath);
  validateString(parsedPolicy.rego.trim(), `${relativePolicyPath}: policy`);

  const entry = {
    path: relativePolicyDirectory,
    name: parsedPolicy.metadata.name,
    direction: parsedPolicy.metadata.direction,
    publishedAt: parsedPolicy.metadata.publishedAt,
    apps: parsedPolicy.metadata.apps,
    industries: parsedPolicy.metadata.industries ?? [],
    bundles: parsedPolicy.metadata.bundles ?? [],
    tags: parsedPolicy.metadata.tags,
    policyChecksum: `sha256:${sha256(parsedPolicy.rego.trim())}`,
    schemaVersion: parsedPolicy.metadata.schemaVersion,
  };

  if (parsedPolicy.metadata.minimumGatewayVersion !== undefined) {
    entry.minimumGatewayVersion = parsedPolicy.metadata.minimumGatewayVersion;
  }

  validatePolicyReferences(entry, relativePolicyPath);
  validateManifestPolicyEntry(entry, `generated entry for ${relativePolicyPath}`);

  return entry;
}

function parsePolicyMarkdown(markdown, relativePolicyPath) {
  const frontmatterMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatterMatch) {
    errors.push(`${relativePolicyPath}: missing YAML frontmatter delimited by ---`);
    return { metadata: {}, rego: "" };
  }

  let metadata = {};
  try {
    metadata = parse(frontmatterMatch[1]) ?? {};
  } catch (error) {
    errors.push(`${relativePolicyPath}: invalid YAML frontmatter: ${error.message}`);
  }

  // Only look for the policy body AFTER the frontmatter, so a ```rego example
  // inside the `description` field can't be miscounted as the policy.
  const body = markdown.slice(frontmatterMatch[0].length);
  const regoBlocks = [...body.matchAll(/```rego\r?\n([\s\S]*?)\r?\n```/g)];
  if (regoBlocks.length !== 1) {
    errors.push(`${relativePolicyPath}: expected exactly one fenced rego block in the policy body, found ${regoBlocks.length}`);
  }

  return {
    metadata,
    rego: regoBlocks[0]?.[1] ?? "",
  };
}

function validatePolicyMetadata(metadata, context) {
  for (const field of Object.values(policyFields)) {
    if (field.name === "policy") {
      continue;
    }

    if (field.required && metadata[field.name] === undefined) {
      errors.push(`${context}: missing required frontmatter field '${field.name}'`);
    }
  }

  validateString(metadata.name, `${context}: name`);
  validateStringArray(metadata.tags, `${context}: tags`);
  validateIsoDate(metadata.publishedAt, `${context}: publishedAt`);
  validateString(metadata.description, `${context}: description`);
  validateDirection(metadata.direction, `${context}: direction`);
  validateStringArray(metadata.apps, `${context}: apps`);
  validateOptionalStringArray(metadata.industries, `${context}: industries`);
  validateOptionalStringArray(metadata.bundles, `${context}: bundles`);
  validateString(metadata.schemaVersion, `${context}: schemaVersion`);
  validateOptionalString(metadata.minimumGatewayVersion, `${context}: minimumGatewayVersion`);

  if (metadata.schemaVersion !== undefined && metadata.schemaVersion !== schemaVersion) {
    errors.push(`${context}: schemaVersion must be ${schemaVersion}`);
  }
}

function validatePolicyReferences(entry, context) {
  for (const app of entry.apps) {
    validateSlug(app, `${context}: apps`);
    validateFolderExists(path.join(root, "apps", app), `${context}: app '${app}'`);
  }

  for (const industry of entry.industries) {
    validateSlug(industry, `${context}: industries`);
    validateFolderExists(path.join(root, "industries", industry), `${context}: industry '${industry}'`);
  }

  for (const bundle of entry.bundles) {
    validateSlug(bundle, `${context}: bundles`);
    validateFolderExists(path.join(root, "bundles", bundle), `${context}: bundle '${bundle}'`);
  }
}

function validateManifest(manifest) {
  validateManifestMap(manifest.apps, "manifest.apps", "apps");
  validateManifestMap(manifest.industries, "manifest.industries", "industries");
  validateManifestMap(manifest.bundles, "manifest.bundles", "bundles");

  for (const entry of manifest.policies) {
    validateManifestPolicyEntry(entry, `manifest policy '${entry.path}'`);
  }
}

function validateManifestPolicyEntry(entry, context) {
  for (const field of Object.values(manifestPolicyFields)) {
    if (field.required && entry[field.name] === undefined) {
      errors.push(`${context}: missing required manifest field '${field.name}'`);
    }
  }

  validateString(entry.path, `${context}: path`);
  validateString(entry.name, `${context}: name`);
  validateStringArray(entry.tags, `${context}: tags`);
  validateIsoDate(entry.publishedAt, `${context}: publishedAt`);
  validateDirection(entry.direction, `${context}: direction`);
  validateStringArray(entry.apps, `${context}: apps`);
  validateOptionalStringArray(entry.industries, `${context}: industries`);
  validateOptionalStringArray(entry.bundles, `${context}: bundles`);
  validateChecksum(entry.policyChecksum, `${context}: policyChecksum`);
  validateString(entry.schemaVersion, `${context}: schemaVersion`);
  validateOptionalString(entry.minimumGatewayVersion, `${context}: minimumGatewayVersion`);
}

function buildFolderMap(directoryName) {
  const directoryPath = path.join(root, directoryName);
  const entries = {};

  for (const slug of sortedDirectoryNames(directoryPath)) {
    validateSlug(slug, `${directoryName} folder`);
    validateReadme(path.join(directoryPath, slug, "README.md"), `${directoryName}/${slug}`);
    entries[slug] = `${directoryName}/${slug}`;
  }

  return entries;
}

function validateManifestMap(value, context, directoryName) {
  if (!isPlainObject(value)) {
    errors.push(`${context}: must be an object`);
    return;
  }

  for (const [slug, relativePath] of Object.entries(value)) {
    validateSlug(slug, `${context} key`);
    validateString(relativePath, `${context}.${slug}`);
    validateFolderExists(path.join(root, relativePath), `${context}.${slug}`);

    const expectedPath = `${directoryName}/${slug}`;
    if (relativePath !== expectedPath) {
      errors.push(`${context}.${slug}: expected path '${expectedPath}', got '${relativePath}'`);
    }
  }
}

function validateUniquePolicyPaths(policyEntries) {
  const seen = new Set();
  for (const policy of policyEntries) {
    if (seen.has(policy.path)) {
      errors.push(`duplicate policy path '${policy.path}'`);
    }
    seen.add(policy.path);
  }
}

function validateFolderExists(folderPath, context) {
  if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
    errors.push(`${context}: missing directory ${toPosix(path.relative(root, folderPath))}`);
    return;
  }

  validateReadme(path.join(folderPath, "README.md"), context);
}

function validateReadme(readmePath, context) {
  if (!existsSync(readmePath)) {
    errors.push(`${context}: missing README.md`);
  }
}

function validateString(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${context}: must be a non-empty string`);
  }
}

function validateOptionalString(value, context) {
  if (value !== undefined) {
    validateString(value, context);
  }
}

function validateStringArray(value, context) {
  if (!Array.isArray(value)) {
    errors.push(`${context}: must be an array of strings`);
    return;
  }

  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${context}: must contain only non-empty strings`);
      return;
    }
  }
}

function validateOptionalStringArray(value, context) {
  if (value !== undefined) {
    validateStringArray(value, context);
  }
}

function validateIsoDate(value, context) {
  validateString(value, context);
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${context}: must be an ISO 8601 date in YYYY-MM-DD format`);
  }
}

function validateDirection(value, context) {
  validateString(value, context);
  if (typeof value === "string" && !["egress", "ingress"].includes(value)) {
    errors.push(`${context}: must be one of egress, ingress`);
  }
}

function validateChecksum(value, context) {
  validateString(value, context);
  if (typeof value === "string" && !/^sha256:[a-f0-9]{64}$/.test(value)) {
    errors.push(`${context}: must match sha256:<64 lowercase hex chars>`);
  }
}

function validateSlug(value, context) {
  if (typeof value === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    errors.push(`${context}: '${value}' must be a lowercase kebab-case slug`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

// Deterministic, locale-independent ordering by UTF-16 code unit. Using
// String.prototype.localeCompare here would let manifest.json ordering vary
// across environments and cause spurious `manifest:check` failures.
function compareStrings(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
