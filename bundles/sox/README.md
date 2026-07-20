# SOX (ICFR / ITGC) bundle

The Sarbanes-Oxley Act of 2002 governs U.S. public companies and their auditors. It has no numbered technical checklist; what it demands is **internal control over financial reporting (ICFR)** — that transactions are recorded only with management's authorization (Exchange Act Rule 13a-15(f)(2)), that assets are safeguarded against unauthorized use or disposition (Rule 13a-15(f)(3)), that records are not destroyed, altered, or falsified (§802 / 18 U.S.C. §1519), and that IT general controls over the systems feeding the financial statements are sound (COSO Principle 11, tested under PCAOB AS 2201). When an employee connects NetSuite, QuickBooks, Stripe, a data warehouse, or GitHub to an AI agent over MCP, the agent inherits that user's credential and becomes a new automated actor inside ICFR scope — one whose access, actions, and audit trail an auditor will expect to see controlled. The PCAOB has said as much: when AI touches journal entries, estimates, or disclosures, it becomes part of ICFR and must be governed with access controls, change management, monitoring, and documented human oversight. This bundle is a starting posture for that path: a DTwo policy can *be* the preventive control an issuer puts in its §404 control population for the agent channel, and the gateway's per-decision log its test evidence.

These policies **support alignment with SOX (ICFR/ITGC) on the MCP path only.** They act on agent traffic that flows through the gateway; web-UI logins, native-API integrations, in-app roles and period locks, and human processes are outside their reach by design, and no policy or bundle makes an issuer SOX compliant. §404 effectiveness is management's assessment over the entire control environment — the agent channel is one control population among the many an auditor tests.

## What this bundle covers

17 policies across 8 apps, grouped below by the SOX control theme they support. A policy appears once, under its primary theme. Every policy is single-purpose and composes with the others on the same pipeline direction; policy bodies live under [`apps/`](../../apps/) and this page only links to them.

The per-decision audit log beneath the bundle — principal, action, resource, arguments, decision — is a property of the gateway, not a policy in it. That record is itself §404 test evidence: the denies show the control operating, and the allows are the population of what the agent did. Every allow, deny, and transform below lands in it, attributed to an authenticated user — the "records in reasonable detail" of Rule 13a-15(f)(1) for the automated actor.

### 1. Least-privilege access to financial systems (ITGC access-to-programs-and-data; COSO Principle 11)

The ITGC access baseline on the agent channel: reads stay open, writes require the matching IdP group, and unrecognized verbs fail closed. This is the per-app least-privilege floor that keeps an agent from mutating a financially relevant system just because a user connected it.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [role-gate-writes](../../apps/ms365/role-gate-writes/) | ms365 | ingress | Reads pass for everyone; every send/create/update/delete/upload/share and any unrecognized verb requires the m365-writers IdP group (fail-closed). |
| [role-gate-writes-engineering](../../apps/github/role-gate-writes-engineering/) | github | ingress | Read-only GitHub for non-engineers; the enumerated write/destructive tools are denied outside the engineering IdP group. |
| [role-gate-writes-billing](../../apps/stripe/role-gate-writes-billing/) | stripe | ingress | Read-only Stripe by default; named billing write and destructive tools require the finance or billing-admin group. |

### 2. Safeguarding of assets — money movement & vendor banking (Rule 13a-15(f)(3))

The highest-blast-radius surface: money leaving the company. These gate or cap agent-initiated payments, refunds, and transfers to finance groups and block the anti-BEC vendor-banking edit that redirects a legitimate payment to a fraudulent account.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [gate-money-movement](../../apps/quickbooks/gate-money-movement/) | quickbooks | ingress | Deny QuickBooks payment/bill-payment/refund/transfer creation unless the caller is in a finance group and the amount is under the ceiling. |
| [guard-vendor-banking](../../apps/quickbooks/guard-vendor-banking/) | quickbooks | ingress | Block vendor create/update calls that carry bank/routing/ACH payment coordinates (anti-BEC). |
| [guard-vendor-banking](../../apps/netsuite/guard-vendor-banking/) | netsuite | ingress | Deny NetSuite vendor banking/payment-detail edits; everything else passes through (anti-BEC). |
| [gate-money-movement-refund-cap](../../apps/stripe/gate-money-movement-refund-cap/) | stripe | ingress | Deny Stripe refunds unless the caller is in finance or billing-admin, and cap the amount even for those groups. |

### 3. Record integrity & anti-destruction (SOX §802 / 18 U.S.C. §1519; Rule 13a-15(f)(1))

The §802 story: an agent should be able to draft, but never destroy or silently rewrite the record. These deny delete/void/cancel-class tools and lock direct writes to posted transactions, journal entries, and closed-period records.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [freeze-destructive-ops](../../apps/ms365/freeze-destructive-ops/) | ms365 | ingress | Deny Microsoft 365 tool calls whose verb is delete- or cancel- unless the caller is in the m365-admin group. |
| [freeze-destructive-ops](../../apps/quickbooks/freeze-destructive-ops/) | quickbooks | ingress | Deny destructive QuickBooks tool calls (a QBO delete is an irreversible transaction removal). |
| [protect-closed-periods-journal-entries](../../apps/quickbooks/protect-closed-periods-journal-entries/) | quickbooks | ingress | Lock direct journal-entry create/update writes to the controller group. |
| [protect-closed-periods](../../apps/netsuite/protect-closed-periods/) | netsuite | ingress | Deny NetSuite financial-transaction record writes (journal entries and postings) outside a finance/controller group. |

### 4. Financial-data-platform integrity — warehouse SQL guard (Rule 13a-15(f)(1)–(2))

Warehouses and lakehouses feed management reporting and information produced by the entity (IPE). These inspect the SQL argument and deny DML/DDL/GRANT and export constructs, forcing the agent onto read-only analytics while failing closed on SQL they cannot parse.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [guard-warehouse-sql](../../apps/snowflake/guard-warehouse-sql/) | snowflake | ingress | Deny mutating/destructive Snowflake SQL; allow read-only queries. |
| [guard-warehouse-sql](../../apps/bigquery/guard-warehouse-sql/) | bigquery | ingress | Block destructive/DDL SQL in BigQuery queries; fail closed on unreadable SQL. |
| [guard-warehouse-sql](../../apps/databricks/guard-warehouse-sql/) | databricks | ingress | Deny write/DDL/permission/export statements in Databricks SQL; fail closed on a missing SQL argument. |

### 5. Human-in-the-loop & segregation of duties (COSO Principle 10; PCAOB genAI human-in-the-loop; ITGC program changes)

The initiate-vs-consummate separation the PCAOB expects for AI in ICFR: let the agent draft, but keep the step that makes it real — a merge, an approval, a one-shot dispute submission — off the agent path.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [require-human-approval-merge](../../apps/github/require-human-approval-merge/) | github | ingress | Deny agent PR merges and PR approvals — the two actions that consummate a change to a financial system's code. |
| [require-human-approval-dispute-submit](../../apps/stripe/require-human-approval-dispute-submit/) | stripe | ingress | Strip the irreversible `submit` flag from Stripe dispute updates; the agent drafts evidence, a human files it. Transform-only. |

### 6. Closing the escape hatch (least-privilege backstop for §§1–5)

Raw-API passthrough tools execute arbitrary methods and bypass every named-tool policy above. This closes that hole so the theme-specific controls can't be routed around.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [deny-escape-hatches-api-write](../../apps/stripe/deny-escape-hatches-api-write/) | stripe | ingress | Deny the `stripe_api_write` meta-tool — a raw passthrough that would otherwise execute any Stripe write and bypass the named-tool gates. |

## What this bundle does NOT cover

SOX ICFR is far broader than the agent channel. These controls are real and required — they simply live outside a gateway policy, in the app, the IdP, or a human process:

- **Program development & computer operations.** SDLC governance, job scheduling, batch processing, and backup/recovery for financial systems are app and infrastructure controls with no meaningful MCP-path surface (framework: *Out of scope*).
- **User access provisioning, deprovisioning & periodic access reviews.** Joiner/mover/leaver workflow and access recertification live in the IdP and each app. DTwo *consumes* live IdP claims — so deprovisioning immediately removes the agent's entitlements — but the provisioning workflow and the reviews themselves are IdP/process controls.
- **In-app immutability.** Period locks, posting-date controls, and WORM/immutable storage are app configuration; the gateway blocks the agent's *attempt*, but the durable lock belongs in the app.
- **Full segregation of duties.** The gateway sees only MCP traffic; it cannot detect the same user completing a conflicting step in the app UI. SoD role design stays in the app.
- **The authorization workflow itself, and the quality of human review.** A gateway can force draft-only and require an approval reference, but it cannot perform the approval workflow or judge whether the human review was diligent — those are management review controls.
- **Non-MCP channels.** Web-UI sessions, native API integrations, and direct database access are entirely outside the gateway's reach. App-side logging and controls remain necessary for that activity.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `sox` among its `bundles`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

A policy earns the `sox` tag only when its description cites at least one concrete SOX/ICFR control, so several of these policies also carry other bundle tags (`soc2`, `pci-dss`) where the same control supports more than one framework.

## What's intentionally not in the bundle

- **Tenant-specific scoping.** IdP group names (`finance`, `controller`, `m365-writers`, `engineering`, `billing-admin`), amount ceilings, closed-period dates, and repo/schema labels are placeholders — replace them with your own values at import time. Custom pipeline names, close-package paths, and financial-system repo tags belong in your private policy repo.
- **Framework-agnostic egress redaction.** PII/financial-ID redaction on read responses (e.g. the per-app `redact-*` policies in the catalog) supports SOX disclosure/MNPI containment but ships under the privacy-framework bundles; add it alongside these if pre-filing egress control is in scope for you.

---

> **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
