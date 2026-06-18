# DTwo Policy Store

A public, curated catalog of reusable [DTwo](https://dtwo.ai) policies. Browse policies by app, industry, or bundle; import them into your gateway; and contribute your own.

## What's in here

DTwo policies are [OPA/Rego](https://www.openpolicyagent.org/) rules that the DTwo MCP Gateway evaluates on every tool call — to allow, deny, redact, or rewrite the request or response. This repo is the source of truth for the common policy catalog: reviewed, vetted policies that solve recurring security and governance problems for MCP-fronted tools (Slack, Jira, GitHub, databases, etc.).

The catalog is meant to be:

- **Browsable** — a human can read a policy's description, understand what it does, and decide whether it fits.
- **Importable** — a DTwo gateway can fetch a policy directly from this repo (by path) and create a tenant-local draft from it.
- **Composable** — policies are intentionally small and single-purpose. To build a comprehensive posture, attach several together (the gateway aggregates `allow`, `reasons`, and `transform` rules across attached policies).

All policies in this catalog must be **PARC-compatible**: they reference `input.resource`, `input.subject`, `input.action`, and `input.context` rather than the deprecated legacy aliases. This is the catalog's baseline input contract. The full input schema and authoring conventions are documented in the public [`dtwo-policy-rego` skill](https://github.com/dtwoai/plugins/blob/main/dtwo/skills/dtwo-policy-rego/SKILL.md) — a Markdown reference anyone can read in the [`dtwoai/plugins`](https://github.com/dtwoai/plugins) repo (and install as a Claude Code plugin).

## Repository layout

```text
apps/
  <app>/                      # one directory per MCP server / SaaS app (e.g. slack, jira, github)
    README.md                 # landing page listing policies for this app
    <policy>/
      policy.md               # metadata frontmatter plus the fenced Rego policy body
      tests/                  # optional sample inputs / expected outcomes
        allow.json
        deny.json

industries/
  <industry>/                 # one directory per industry (e.g. healthcare, finance)
    README.md                 # landing page linking to relevant policies in apps/

bundles/
  <bundle>/                   # one directory per themed bundle (e.g. im-messaging, devtools)
    README.md                 # landing page linking to policies in apps/

manifest.json                 # generated policy index consumed by downstream APIs
schema.json                   # schema contract for policy markdown and manifest entries
```

### Where policies live

**Policy bodies live exclusively under `apps/<app>/<policy>/`.** Industry and bundle directories never duplicate policy files — they only link to the canonical location under `apps/`. For example: A Slack secrets-redaction policy that fits both the `finance` industry and the `im-messaging` bundle has one definition and is referenced from both landing pages.

### Where policy metadata lives

**All policy metadata — name, description, direction, tags, apps/industries/bundles membership, schema version, and minimum gateway version — lives in each policy's `policy.md` frontmatter.** The generated `manifest.json` is the machine-readable index; do not edit it by hand except through the manifest generator.

A policy declares its grouping by listing app/industry/bundle slugs in its frontmatter (e.g. `bundles: ["im-messaging"]`). The same policy can belong to multiple apps, industries, and bundles without being duplicated.

## Browsing model

Three entry points, all backed by `manifest.json`:

- **By app** — start at `apps/<app>/README.md` if you know which MCP server you're protecting.
- **By industry** — start at `industries/<industry>/README.md` if you want a curated set of policies relevant to a regulatory or business domain.
- **By bundle** — start at `bundles/<bundle>/README.md` if you want a themed pack (e.g., all IM messaging hygiene policies).

The landing pages are human-readable curations; `manifest.json` is the generated machine-readable source the DTwo MCP and Hub consume.

## Import model

Catalog entries are addressed by **repository path** (e.g. `apps/slack/block-secrets/`), not by an ID assigned in this repo. A DTwo gateway or Hub:

1. Reads `manifest.json` to discover available policies and their metadata.
2. Fetches `apps/<app>/<policy>/policy.md` from the requested ref.
3. Validates the Rego (compile + PARC-compatible package), then creates a **tenant-local draft** through the existing policy-creation API.

Import is a copy operation, not a live subscription — imported policies remain tenant-scoped and editable. Catalog provenance (path, ref, checksum) is recorded on the imported policy so the gateway can later detect when an upstream update is available.

> Wiring details (CLI flags, gateway endpoints, auth) are documented in the DTwo gateway product docs, not here. This repo only owns the policy artifacts and the manifest.

## Contribution path

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process, and [GOVERNANCE.md](./GOVERNANCE.md) for how the catalog is run.

The catalog launches **curated-only**: because these policies run inside other people's decision paths, external pull requests are not merged directly yet. The short version:

1. **Open an issue** describing the policy you want to add (or the gap you want to fill) — the app, the intended `allow`/`deny`/`transform` behavior, and example inputs.
2. A **DTwo maintainer authors or transcribes** the policy under `apps/<app>/<policy-slug>/`, links it from any relevant app/industry/bundle landing page, regenerates `manifest.json`, and reviews it for correctness, PARC compliance, and catalog hygiene before merge. Proposers are credited.

All commits are made under the [Developer Certificate of Origin](./CONTRIBUTING.md#developer-certificate-of-origin-dco) (`git commit -s`). We will open the catalog to external DCO-signed pull requests once the automated trust gate (`opa check` + tests + security review in CI) is in place. By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

**Apache-2.0** — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). The license includes an express patent grant; policies are intended to be copied, modified, and redistributed.

"DTwo" is a trademark of DTwo, Inc. The license covers copyright only and does not grant rights to the DTwo marks. Third-party dependency notices are in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

These policies are reviewed examples and starting points, **not warranties**. They compile, pass their tests, and are maintainer-reviewed, but you are responsible for validating that any policy meets your requirements before relying on it. See [SECURITY.md](./SECURITY.md).
