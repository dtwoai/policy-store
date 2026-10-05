# GTM Stack: Salesforce bundle

For sales, marketing, and RevOps teams who run their go-to-market on Salesforce and want to give reps an AI assistant over MCP. The goal is simple: let the agent read everything it needs to prep for and follow up on calls, while keeping it from changing the CRM in ways nobody asked for.

These policies act on agent traffic that flows through the gateway. Web-UI logins, native integrations, and in-app permissions are outside their reach by design.

## What this bundle covers

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [read-only-except-call-notes](../../apps/salesforce/read-only-except-call-notes/policy.md) | salesforce | ingress | Salesforce is read-only for the agent, except it can log a call note on a contact (a call Task or a classic Note). Opportunity, contact, account, delete, and every other write is blocked. |
| [cap-bulk-export](../../apps/salesforce/cap-bulk-export/policy.md) | salesforce | ingress | Requires a `LIMIT` of 200 or less on every SOQL query and 50 or less on org-wide SOSL search, so the agent can't bulk-export the CRM. No IdP groups needed. |
| [apollo/read-only](../../apps/apollo/read-only/policy.md) | apollo | ingress | Apollo is read-only for the agent: it can search and enrich prospects, but can't create or edit records, add anyone to a sequence, or send email. |
| [clay/subroutine-allowlist](../../apps/clay/subroutine-allowlist/policy.md) | clay | ingress | Only Clay's built-in enrichment functions can run. Custom Clay functions, which can push data into the CRM behind the CRM policies' back, are blocked. |
| [clay/cap-enrichment](../../apps/clay/cap-enrichment/policy.md) | clay | ingress | Caps each Clay enrichment call at 50 records and 5 data points, so one prompt can't burn the team's credits or pull contact data for a whole list at once. |
| [apollo/cap-search](../../apps/apollo/cap-search/policy.md) | apollo | ingress | Trims every Apollo search to 50 results per page. Transform-only — the agent just pages through. |

Policy bodies live under [`apps/`](../../apps/); this page only links to them.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `gtm-stack-salesforce` among its `bundles`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth.

## What's intentionally not in the bundle

- **Tenant-specific scoping.** The Salesforce server name prefix (`salesforce`) is a default — change it if your gateway registers the server under a different name.
- **Alternative write postures.** [`salesforce/read-only`](../../apps/salesforce/read-only/policy.md) and [`salesforce/role-gate-writes`](../../apps/salesforce/role-gate-writes/policy.md) conflict with the call-notes exception; attach one write posture, not several.

---

> **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
