# DTwo Policy Store

A public, curated catalog of reusable [DTwo](https://dtwo.ai) policies. Browse policies by app, industry, or bundle; import them into your gateway; and contribute your own.

## What's in here

DTwo policies are [OPA/Rego](https://www.openpolicyagent.org/) rules that the DTwo MCP Gateway evaluates on every tool call — to allow, deny, redact, or rewrite the request or response. This repo is the source of truth for the common policy catalog: reviewed, vetted policies that solve recurring security and governance problems for MCP-fronted tools (Slack, Jira, GitHub, databases, etc.).

The catalog is meant to be:

- **Browsable** — a human can read a policy's README, understand what it does, and decide whether it fits.
- **Importable** — a DTwo gateway can fetch a policy directly from this repo (by path) and create a tenant-local draft from it.
- **Composable** — policies are intentionally small and single-purpose. To build a comprehensive posture, attach several together (the gateway aggregates `allow`, `reasons`, and `transform` rules across attached policies).

All policies in this catalog must be **PARC-compatible**: they reference `input.resource`, `input.subject`, `input.action`, and `input.context` rather than the deprecated legacy aliases. This is the catalog's baseline input contract — see the DTwo `dtwo-policy-rego` skill for the schema.

## Repository layout

```
apps/
  <app>/                      # one directory per MCP server / SaaS app (e.g. slack, jira, github)
    README.md                 # landing page listing policies for this app
    <policy>/
      policy.rego             # the policy body — the only required artifact
      README.md               # what it does, direction, assumptions, examples
      tests/                  # optional sample inputs / expected outcomes
        allow.json
        deny.json

industries/
  <industry>/                 # one directory per industry (e.g. healthcare, finance)
    README.md                 # landing page linking to relevant policies in apps/

bundles/
  <bundle>/                   # one directory per themed bundle (e.g. im-messaging, devtools)
    README.md                 # landing page linking to policies in apps/

catalog.json                  # single source of truth for policy metadata (see below)
```

### Where policies live

**Policy bodies live exclusively under `apps/<app>/<policy>/`.** Industry and bundle directories never duplicate policy files — they only link to the canonical location under `apps/`. For example: A Slack secrets-redaction policy that fits both the `finance` industry and the `im-messaging` bundle has one definition and is referenced from both landing pages.

### Where policy metadata lives

**All policy metadata — title, summary, package, direction, tags, apps/industries/bundles membership, version, minimum gateway version — lives in `catalog.json`.** Per-policy directories deliberately do not carry a `metadata.json`; one source of truth avoids drift between the manifest the gateway reads and a sidecar file a contributor might forget to update.

A policy declares its grouping by listing app/industry/bundle slugs in its catalog entry (e.g. `"bundles": ["im-messaging"]`). The same policy can belong to multiple apps, industries, and bundles without being duplicated.


## Browsing model

Three entry points, all backed by `catalog.json`:

- **By app** — start at `apps/<app>/README.md` if you know which MCP server you're protecting.
- **By industry** — start at `industries/<industry>/README.md` if you want a curated set of policies relevant to a regulatory or business domain.
- **By bundle** — start at `bundles/<bundle>/README.md` if you want a themed pack (e.g., all IM messaging hygiene policies).

The landing pages are human-readable curations; `catalog.json` is the machine-readable source the DTwo MCP and Hub consume.

## Import model

Catalog entries are addressed by **repository path** (e.g. `apps/slack/block-secrets/`), not by an ID assigned in this repo. A DTwo gateway or Hub:

1. Reads `catalog.json` to discover available policies and their metadata.
2. Fetches `apps/<app>/<policy>/policy.rego` from the requested ref.
3. Validates the Rego (compile + PARC-compatible package), then creates a **tenant-local draft** through the existing policy-creation API.

Import is a copy operation, not a live subscription — imported policies remain tenant-scoped and editable. Catalog provenance (path, ref, checksum) is recorded on the imported policy so the gateway can later detect when an upstream update is available.

> Wiring details (CLI flags, gateway endpoints, auth) are documented in the DTwo gateway product docs, not here. This repo only owns the policy artifacts and the manifest.

## Contribution path

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process. The short version:

1. Open an issue describing the policy you want to add (or the gap you want to fill).
2. Fork the repo, add your policy under `apps/<app>/<policy-slug>/`, and register it in `catalog.json`.
3. If the policy fits an existing app, industry, or bundle landing page, add a link from that page.
4. Open a PR. A DTwo maintainer reviews for policy correctness, PARC compliance, and catalog hygiene before merge.

## License

MIT — see [LICENSE](./LICENSE). Policies are intended to be copied, modified, and redistributed.
