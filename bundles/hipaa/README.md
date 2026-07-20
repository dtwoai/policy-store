# HIPAA (Privacy & Security Rules) bundle

HIPAA governs how covered entities and their business associates use, disclose, and safeguard protected health information (PHI/ePHI) — the **Privacy Rule** (45 CFR Part 164, Subpart E) with its minimum-necessary standard, and the **Security Rule** (Subpart C) with its administrative and technical safeguards. This bundle is a starting posture for any organization that lets an AI agent reach PHI-bearing SaaS apps over the DTwo gateway. An agent that pulls broad context to answer a single question is in direct tension with minimum necessary, which applies per use and per disclosure — so the gateway is the natural place to scope each tool call, gate it by identity, and strip PHI on the way back out.

These policies **support alignment with HIPAA (Privacy & Security Rules) on the MCP path only.** They act on agent traffic that flows through the gateway; web-UI logins, native-API integrations, and in-app activity are outside their reach by design, and no policy or bundle makes an organization HIPAA compliant. Compliance is a property of your whole program.

## What this bundle covers

42 policies across 18 apps, grouped below by the HIPAA control they support. Every policy is single-purpose and composes with the others on the same pipeline direction. Policy bodies live under [`apps/`](../../apps/); this page only links to them — see the top-level [README](../../README.md#where-policies-live) for the rationale.

The per-decision audit log that records every one of these calls — principal, action, resource, context, decision — is a property of the gateway beneath the bundle, not a policy in it. That record is what supports §164.312(b) audit controls, §164.308(a)(1)(ii)(D) activity review, and the §164.528 accounting of disclosures for the agent-mediated slice of traffic.

### 1. Minimum necessary — cap the blast radius of a read (§164.502(b), §164.514(d))

Clamp bulk reads, exports, and search fan-out so a single agent call can't harvest a mailbox, a table, or a directory. These caps hold agents to the narrowest surface that answers the question.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [cap-bulk-export](../../apps/gmail/cap-bulk-export/) | gmail | ingress | Cap batch content reads and clamp search `maxResults` to throttle mass mailbox harvesting. |
| [cap-bulk-export](../../apps/google-drive/cap-bulk-export/) | google-drive | ingress | Clamp Drive search/listing page sizes to a ceiling (transform-only, never denies). |
| [cap-bulk-export](../../apps/salesforce/cap-bulk-export/) | salesforce | ingress | Cap SOQL row limits and gate org-wide SOSL search by IdP group. |
| [cap-bulk-export](../../apps/hubspot/cap-bulk-export/) | hubspot | ingress | Clamp bulk-read page sizes and batch-read arrays to 50 records. |
| [cap-search-export](../../apps/glean/cap-search-export/) | glean | ingress | Clamp bulk-export params (result ceiling, strip exhaustive) on Glean search. |
| [cap-contact-enumeration](../../apps/intercom/cap-contact-enumeration/) | intercom | ingress | Deny bulk-enumeration query shapes on contact search and clamp page size. |

### 2. De-identification support — redact PHI on the way out (§164.514(a)–(b), §164.530(c))

Egress redaction strips Safe-Harbor-class identifiers — names, contact info, SSNs, card and bank numbers — from responses before an agent carries them into its context or a downstream app. Transform-only where marked: they never deny, they clean.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [redact-pii-egress](../../apps/ms365/redact-pii-egress/) | ms365 | egress | Redact SSN, Luhn-validated PAN, IBAN, and US phone numbers from mail/Excel/SharePoint/transcript/Teams responses. |
| [redact-pii-egress](../../apps/google-drive/redact-pii-egress/) | google-drive | egress | Redact email/SSN/national-ID/phone from Drive content responses. |
| [redact-attendee-pii](../../apps/google-calendar/redact-attendee-pii/) | google-calendar | egress | Redact attendee PII/PHI and meeting join links from calendar reads. |
| [redact-pii](../../apps/salesforce/redact-pii/) | salesforce | egress | Redact contact PII fields and PAN/SSN/phone/email patterns in responses. |
| [redact-pii](../../apps/hubspot/redact-pii/) | hubspot | egress | Redact contact PII (phone/email/SSN) in tool responses. |
| [redact-pii-egress](../../apps/box/redact-pii-egress/) | box | egress | Redact SSN/PAN/bank/email/phone PII from Box content responses (group-exempt). |
| [redact-pii-egress](../../apps/confluence/redact-pii-egress/) | confluence | egress | Redact SSN/email/US-phone PII from Confluence page/comment/search reads (group-exempt). |
| [redact-pii-egress](../../apps/notion/redact-pii-egress/) | notion | egress | Redact email/phone PII from Notion reads for non-HR/legal callers. |
| [redact-pii-egress](../../apps/snowflake/redact-pii-egress/) | snowflake | egress | Mask SSN/email/phone in result sets (pii-cleared group exempt). |
| [redact-pii-egress](../../apps/databricks/redact-pii-egress/) | databricks | egress | Redact SSN/email/phone in response payloads outside the data-privacy group. |
| [redact-pii-egress](../../apps/bigquery/redact-pii-egress/) | bigquery | egress | Redact SSN/PAN/email in query results and optionally cap result rows (group exempt). |
| [redact-pii-egress](../../apps/glean/redact-pii-egress/) | glean | egress | Redact SSN/PAN/IBAN from Glean read responses before they reach agent context. |
| [redact-conversation-pii](../../apps/intercom/redact-conversation-pii/) | intercom | egress | Redact SSN/national-ID/email/phone/credential shapes from conversation and contact reads. |
| [redact-content-egress](../../apps/dropbox/redact-content-egress/) | dropbox | egress | Mask card PANs and redact SSN/email/phone/secrets in file-content responses. |
| [redact-pii-meeting-intelligence](../../apps/zoom/redact-pii-meeting-intelligence/) | zoom | egress | Redact email/phone/SSN in Zoom meeting-intelligence responses (transcripts, summaries, docs). |
| [redact-sensitive-info](../../apps/slack/redact-sensitive-info/) | slack | ingress | Redact PII/secrets/card numbers from outbound Slack message args. |

### 3. Access scoping — fence sensitive PHI to the roles that need it (§164.514(d)(2), §164.308(a)(4), §164.522(a))

Role-based limits on where an agent can look: HR, clinical, legal, and other regulated scopes are fenced to their owning IdP groups across reads, writes, and search. These are the agreed-to-restriction and least-privilege predicates that keep an agent out of a record class it has no business reaching.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [fence-restricted-folders](../../apps/google-drive/fence-restricted-folders/) | google-drive | ingress | Deny reads/writes/copies touching an admin denylist of restricted Drive IDs (HR, M&A, board, payroll). |
| [fence-sensitive-folders](../../apps/box/fence-sensitive-folders/) | box | ingress | Fence pinned sensitive Box folder/file IDs by IdP group (read/move/copy/search). |
| [fence-sensitive-paths](../../apps/dropbox/fence-sensitive-paths/) | dropbox | ingress | Fence protected path prefixes (HR/Finance/Legal/Customers) to mapped IdP team groups. |
| [fence-restricted-spaces](../../apps/confluence/fence-restricted-spaces/) | confluence | ingress | Fence restricted spaces (HR/LEGAL/SEC) out of search, listing, and lookup unless the group grants access. |
| [fence-sensitive-tables](../../apps/servicenow/fence-sensitive-tables/) | servicenow | ingress | Fence sys_user / HR / CMDB tables and user-directory reads behind owner IdP groups. |
| [fence-sensitive-schemas](../../apps/snowflake/fence-sensitive-schemas/) | snowflake | ingress | Group-gate PII/PHI/HR/FINANCE schema references and block `SELECT *` on fenced schemas. |
| [fence-sensitive-schemas](../../apps/databricks/fence-sensitive-schemas/) | databricks | ingress | Deny SQL/metadata access to sensitive namespaces (hr/payroll/pii/phi/comp) outside the data-privacy group. |
| [fence-sensitive-datasets](../../apps/bigquery/fence-sensitive-datasets/) | bigquery | ingress | Fence regulated dataset prefixes (phi_/finance_/pii_) by IdP group across SQL and metadata. |
| [fence-datasource-scope](../../apps/glean/fence-datasource-scope/) | glean | ingress | Restrict which indexed datasource a Glean search may target by IdP group. |
| [fence-contact-reads](../../apps/intercom/fence-contact-reads/) | intercom | ingress | Role-gate the structured-PII contact/company read surface to support/CRM groups. |
| [guard-transcripts-by-group](../../apps/zoom/guard-transcripts-by-group/) | zoom | ingress | Gate Zoom transcript/summary and recording-passcode retrieval by IdP group. |
| [deny-read-search-summarize-sensitive-channels](../../apps/slack/deny-read-search-summarize-sensitive-channels/) | slack | ingress | Deny read/search/summarize of a configured set of sensitive channels. |

### 4. Disclosure & export control — keep PHI from leaving the perimeter (§164.502(b), §164.502(e), §164.530(c))

The Privacy Rule's disclosure line, enforced on the agent channel: deny external sends and downgrade anonymous share links so an agent can't route PHI past the corporate boundary — including to apps or recipients with no BAA behind them.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [guard-external-send](../../apps/ms365/guard-external-send/) | ms365 | ingress | Deny agent email sends when any recipient is outside the corporate-domain allowlist. |
| [guard-share-links](../../apps/ms365/guard-share-links/) | ms365 | ingress | Downgrade anonymous share links to org scope, inject expiry, deny anonymous-edit and external invites. |
| [guard-external-send](../../apps/gmail/guard-external-send/) | gmail | ingress | Deny sends when any to/cc/bcc recipient is outside the corporate-domain allowlist; draft instead. |
| [guard-external-send](../../apps/slack/guard-external-send/) | slack | ingress | Deny agent posts to externally shared Slack Connect channels. |
| [guard-external-attendees](../../apps/google-calendar/guard-external-attendees/) | google-calendar | ingress | Block calendar invites to attendees outside the corporate-domain allowlist. |
| [guard-share-links-external](../../apps/box/guard-share-links-external/) | box | ingress | Block external collaborations to non-corp domains and anonymous public share links. |
| [guard-share-links-external](../../apps/dropbox/guard-share-links-external/) | dropbox | ingress | Deny public share links, download URLs, and file requests unless caller is in the dropbox-sharing group. |
| [guard-external-chat-invites](../../apps/zoom/guard-external-chat-invites/) | zoom | ingress | Block external contact invites and external history exposure in Zoom Team Chat channels. |

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `bundles: ["hipaa"]`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The policies compose by direction. The egress redaction policies (theme 2) attach to the response pipeline and are transform-only where marked, so they never deny and never collide with the ingress controls. The ingress policies are each single-purpose — a cap, a fence, a disclosure guard — so several attach to the same app on the same direction without interfering. Each policy is scoped to its own app, so cross-app members never collide.

## What this bundle does NOT cover

These policies act only on agent traffic over MCP, and only some HIPAA requirements reduce to a gateway decision. Out of scope by design:

- **The BAA itself.** A business associate contract (§164.502(e)) is a legal and procurement act. The gateway enforces the operational corollary — keeping PHI out of no-BAA apps and off external recipients — but it cannot sign a BAA, and it does not see the non-MCP channels into those apps.
- **Web-UI, native-API, and in-app access.** A clinician opening a record in the app's own UI, or a native integration writing to it, never passes through the gateway. Those paths stay governed by the app and your IdP.
- **Encryption and transmission security (§164.312(e)).** TLS between agent, gateway, and apps is infrastructure, not policy. Encryption at rest and in transit rest with the deployment and the apps.
- **Automatic logoff and log-in monitoring (§164.312(a)(2)(iii), §164.308(a)(5)(ii)(C)).** Session and token lifetime and failed-login detection are IdP and app functions; the gateway sees only authenticated sessions.
- **Physical safeguards (§164.310).** No bearing on the MCP path.
- **Retention.** HIPAA's six-year documentation retention (§164.316(b)(2)(i)) requires you to configure retention on the audit pipeline; clinical-record retention and legal hold are state-law and app concerns, not gateway policy.
- **A Safe Harbor de-identification determination (§164.514(a)–(b)).** The egress redaction here is best-effort pattern matching — it supports a de-identified working style but is not a formal Safe Harbor certification or an expert determination.
- **The accounting, the review, and the notification themselves.** The audit log supports §164.528 accounting, §164.308(a)(1)(ii)(D) activity review, and §164.404 breach notification, but performing the accounting, reviewing the logs, and issuing notifications are human and organizational duties.
- **Tenant-specific inputs.** Sensitive folder IDs, schema and dataset names, path prefixes, project keys, and channel lists are yours, not ours; supply them at import time. IdP group names in these policies are placeholders — map them to your directory's groups before relying on them.

---

> **Compliance note.** This bundle supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
