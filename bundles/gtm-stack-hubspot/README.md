# GTM Stack: HubSpot bundle

For sales, marketing, and RevOps teams who run their go-to-market on HubSpot and want to give reps an AI assistant over MCP. The goal is simple: let the agent read everything it needs to prep for and follow up on calls, while keeping it from changing the CRM in ways nobody asked for.

These policies act on agent traffic that flows through the gateway. Web-UI logins, native integrations, and in-app permissions are outside their reach by design.

## What this bundle covers

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [read-only-except-call-notes](../../apps/hubspot/read-only-except-call-notes/policy.md) | hubspot | ingress | HubSpot is read-only for the agent, except it can log a call note (a Note or Call record) on a contact. Deal, contact, campaign, and every other write is blocked. |
| [cap-bulk-export](../../apps/hubspot/cap-bulk-export/policy.md) | hubspot | ingress | Caps reads at 200 records per call (lists, batch reads, and SQL via `query_crm_data`) and 50 for free-text search, so the agent can't pull the whole contact base in one go. Transform-only — reads still work, just in bounded pages. |
| [apollo/read-only](../../apps/apollo/read-only/policy.md) | apollo | ingress | Apollo is read-only for the agent: it can search and enrich prospects, but can't create or edit records, add anyone to a sequence, or send email. |
| [clay/subroutine-allowlist](../../apps/clay/subroutine-allowlist/policy.md) | clay | ingress | Only Clay's built-in enrichment functions can run. Custom Clay functions, which can push data into the CRM behind the CRM policies' back, are blocked. |
| [clay/cap-enrichment](../../apps/clay/cap-enrichment/policy.md) | clay | ingress | Caps each Clay enrichment call at 50 records and 5 data points, so one prompt can't burn the team's credits or pull contact data for a whole list at once. |
| [apollo/cap-search](../../apps/apollo/cap-search/policy.md) | apollo | ingress | Trims every Apollo search to 50 results per page. Transform-only — the agent just pages through. |

Policy bodies live under [`apps/`](../../apps/); this page only links to them.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `gtm-stack-hubspot` among its `bundles`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth.

## What's intentionally not in the bundle

- **Tenant-specific scoping.** The HubSpot server name prefix (`hubspot`) is a default — change it if your gateway registers the server under a different name.
- **Alternative write postures.** [`hubspot/read-only`](../../apps/hubspot/read-only/policy.md) and [`hubspot/role-gate-writes`](../../apps/hubspot/role-gate-writes/policy.md) conflict with the call-notes exception; attach one write posture, not several.

---

> **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
