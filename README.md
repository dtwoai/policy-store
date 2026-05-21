# DTwo Policy Store

A public, curated catalog of reusable [DTwo MCP Gateway](https://dtwo.ai) policies. Browse policies by app, industry, or bundle; import them into your gateway; and contribute your own.

## What's in here

DTwo policies are [OPA/Rego](https://www.openpolicyagent.org/) rules that the DTwo MCP Gateway evaluates on every tool call — to allow, deny, redact, or rewrite the request or response. This repo is the source of truth for the common policy catalog: reviewed, vetted policies that solve recurring security and governance problems for MCP-fronted tools (Slack, Jira, GitHub, databases, etc.).

The catalog is meant to be:

- **Browsable** — a human can read a policy's README, understand what it does, and decide whether it fits.
- **Importable** — a DTwo gateway can fetch a policy directly from this repo (by app + policy slug) and attach it to a pipeline.
- **Composable** — policies are intentionally small and single-purpose. To build a comprehensive posture, attach several together (DTwo's gateway aggregates `allow`, `reasons`, and `transform` rules across all attached policies).

## Repository layout

```
apps/
  <app>/                      # one directory per MCP server / SaaS app (e.g. slack, jira, github)
    README.md                 # landing page listing policies for this app
    <policy>/
      policy.rego             # the policy body
      README.md               # what it does, direction, assumptions
      metadata.json           # machine-readable metadata for the catalog

industries/
  <industry>/                 # one directory per industry (e.g. healthcare, finance)
    README.md                 # landing page linking to relevant policies in apps/

bundles/
  <bundle>/                   # one directory per themed bundle (e.g. im-messaging, devtools)
    README.md                 # landing page linking to policies in apps/
    bundle.json               # machine-readable list of included policies

catalog.json                  # top-level index of every app, industry, and bundle
```

### Where policies live

**Policy bodies live exclusively under `apps/<app>/<policy>/`.** Industry and bundle directories never duplicate policy files — they only link to the canonical location under `apps/`. This keeps the catalog DRY: a Slack secrets-redaction policy that fits both the `finance` industry and the `im-messaging` bundle has one definition and two referrers.

## Browsing model

Three entry points, all driven by `catalog.json`:

- **By app** — start at `apps/<app>/README.md` if you know which MCP server you're protecting.
- **By industry** — start at `industries/<industry>/README.md` if you want a curated set of policies relevant to a regulatory or business domain.
- **By bundle** — start at `bundles/<bundle>/README.md` if you want a themed pack (e.g., all IM messaging hygiene policies).

`catalog.json` enumerates every app, industry, and bundle with stable IDs, descriptions, and file paths — it's what tooling and the DTwo gateway consume.

## Import model

A DTwo gateway imports a policy by its catalog ID (`<app>/<policy-slug>`). The gateway fetches `apps/<app>/<policy-slug>/policy.rego` and `metadata.json` from this repo's `main` branch, validates the Rego, and attaches the policy to the requested pipeline direction (ingress or egress) as defined in the policy's metadata.

Bundles are imported as a list: `bundles/<bundle>/bundle.json` enumerates policy IDs, and the gateway imports each one individually. There is no separate bundle artifact — a bundle is just a curated list of canonical app policies.

> Import wiring (CLI flags, gateway endpoints, auth) is documented in the DTwo gateway product docs, not here. This repo only owns the policy artifacts and their metadata.

## Contribution path

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the full process. The short version:

1. Open an issue describing the policy you want to add (or the gap you want to fill).
2. Fork the repo, add your policy under `apps/<app>/<policy-slug>/`, and register it in `catalog.json` (plus any relevant industry or bundle landing page).
3. Open a PR. A DTwo maintainer reviews for policy correctness, schema compliance, and catalog hygiene before merge.

## License

MIT — see [LICENSE](./LICENSE). Policies are intended to be copied, modified, and redistributed.
