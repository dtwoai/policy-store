# Zapier policies

Reusable DTwo policies for the Zapier MCP server — the official, hosted aggregator at `mcp.zapier.com` that proxies 40,000+ actions across 9,000+ apps (Gmail, Slack, HubSpot, Salesforce, QuickBooks, Stripe, HR and e-signature apps) through a single MCP endpoint. It runs in one of two modes: the default **agentic** mode exposes 15 static meta-tools where every write funnels through `execute_zapier_write_action` and the agent can grant itself new capabilities mid-session; **classic** mode exposes one snake_case `<app>_<action>` tool per action the owner enabled. Its risk profile is the most concentrated in the catalog: one connector behind the gateway reaches email, CRM, finance, HR, and storage apps at once; writes are externally visible and irreversible; the agent can widen its own blast radius (`enable_zapier_action`, `auto_provision_mcp`, `write_code_action`); and because every tool accepts a free-text `instructions` string that Zapier's server-side AI resolves into recipients and record IDs *after* the gateway has passed the call, structured-field-only policies are bypassable by construction.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Allowlist audited Zapier tool-name suffixes and deny anything else, so upstream toolset drift is blocked before it reaches the agent. | soc2, gdpr-ccpa |
| [freeze-toolset](./freeze-toolset/policy.md) | ingress | Deny the self-expansion meta-tools (`enable_zapier_action`, `auto_provision_mcp`, `write_code_action`, `*_zapier_skill`) so the agent cannot widen its own blast radius mid-session. | soc2 |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Gate every write across all proxied apps (the `execute_zapier_write_action` funnel and classic-mode write verbs) behind an IdP writers group; read-only by default. | soc2, pci-dss, hipaa, gdpr-ccpa, sox |
| [guard-external-send](./guard-external-send/policy.md) | ingress | Deny write calls whose `instructions` or params carry an external recipient (non-corporate email domain), closing the fill-in-the-blanks bypass. | soc2, gdpr-ccpa, hipaa |
| [mask-pan-egress](./mask-pan-egress/policy.md) | egress | Mask payment-card numbers (PANs) in Zapier read responses before they reach the agent (transform-only). | pci-dss, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Zapier MCP server registered as `zapier` surfaces the agentic meta-tools as `zapier-execute_zapier_write_action`, `zapier-enable_zapier_action`, and so on; classic mode surfaces `zapier-gmail_send_email`, `zapier-slack_send_message`, etc. The policies in this directory match on the tool-name **suffix** so they stay portable across naming conventions, and cover both modes (suffix-matching works well in classic mode and collapses to the two `execute_zapier_*_action` funnels in agentic mode). Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. The 15 agentic meta-tool names are verified from Zapier's docs; classic-mode `<app>_<action>` names are per-account and largely unverified — treat any name not observed on your live server as unverified.

## Identity claims

The identity-gated policies (`freeze-toolset`, `role-gate-writes`, and the exemption branch of `guard-external-send`) read `input.subject.claims.groups` with **placeholder** group names (e.g. `automation-admins`, `zapier-writers`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt). The remaining policies are single-purpose and require no IdP claims.

## Contributing

To add a Zapier policy:

1. Create `apps/zapier/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["zapier"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle, link to it from the matching bundle landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
