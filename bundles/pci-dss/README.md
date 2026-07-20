# PCI DSS 4.0.1 bundle

The Payment Card Industry Data Security Standard (PCI DSS) v4.0.1 governs every entity that stores, processes, or transmits **cardholder data** — the Primary Account Number (PAN), cardholder name, expiry, and service code — or **sensitive authentication data** (CVV/CVC, full track data, PINs). Its costliest agent-era failure mode is scope creep: an agent copying a PAN out of a payment system or data warehouse into a chat, a ticket, or a doc drags that app into cardholder-data scope.

This bundle gathers policies that **support alignment with PCI DSS 4.0.1 on the MCP path only**. They act on the tool calls an AI agent makes through the DTwo gateway — masking PAN in responses, fencing agent queries against stored cardholder data, capping bulk pulls, gating payment operations by role, and keeping the least-privilege line on card-data-adjacent apps. Every decision is attributed to an authenticated individual and logged. These policies govern the agent channel; they do not touch web-UI, native-API, or in-app access, and no bundle makes an organization PCI DSS compliant.

## What this bundle covers

The policies are grouped by the PCI control theme they support. A policy appears once, under its primary theme; policy bodies live under [`apps/`](../../apps/) and this page only links to them.

### Mask cardholder data in responses

Egress transforms that detect Luhn-validated PAN in tool responses and mask it to BIN + last four, unless the caller carries a documented full-PAN group. They never deny a call. Supports **3.4.1** (PAN masked on display), **3.4.2** (prevent copy/relocation through the agent channel), and — by keeping PAN out of apps that should never hold it — **3.2.1** and **12.10.7**.

| Policy | App | Direction | Purpose |
| --- | --- | --- | --- |
| [mask-pan-egress](../../apps/slack/mask-pan-egress/policy.md) | slack | egress | Mask Luhn-validated PANs to BIN + last4 in Slack message and search responses; `pci-full-pan` group exempt. |
| [mask-pan-egress](../../apps/gmail/mask-pan-egress/policy.md) | gmail | egress | Mask card numbers in email content read by the agent; the full-PAN group is exempt, fail-closed. |
| [mask-pan-egress](../../apps/intercom/mask-pan-egress/policy.md) | intercom | egress | Mask card numbers in Intercom conversation responses where customers paste PANs into tickets. |
| [mask-pan-egress](../../apps/zapier/mask-pan-egress/policy.md) | zapier | egress | Mask PANs in Zapier aggregator read responses, which proxy finance-adjacent apps with no source DLP. |
| [mask-pan-egress](../../apps/databricks/mask-pan-egress/policy.md) | databricks | egress | Mask cardholder PANs in Databricks SQL, Genie, and AI-Search responses. |

### Restrict programmatic queries against stored cardholder data

Ingress controls that fence agent queries against warehouse schemas, datasets, and objects where transaction data lands, and block the DML/DDL/export constructs that would mutate or relocate it. This is the flagship PCI control for MCP access. Supports **7.2.6** (programmatic query access to stored CHD restricted by role) and **7.2.1 / 7.2.2** (least-privilege access model).

| Policy | App | Direction | Purpose |
| --- | --- | --- | --- |
| [fence-sensitive-schemas](../../apps/snowflake/fence-sensitive-schemas/policy.md) | snowflake | ingress | Group-gate PII/HR/finance schema references by data domain and block `SELECT *` on fenced schemas. |
| [guard-warehouse-sql](../../apps/snowflake/guard-warehouse-sql/policy.md) | snowflake | ingress | Block destructive and mutating SQL (DROP/DELETE/UPDATE/INSERT/MERGE/ALTER/GRANT); read-only default. |
| [guard-warehouse-export](../../apps/snowflake/guard-warehouse-export/policy.md) | snowflake | ingress | Block bulk export via COPY INTO external stage/URL, stage creation, shares, and off-perimeter PUT/GET. |
| [fence-sensitive-schemas](../../apps/databricks/fence-sensitive-schemas/policy.md) | databricks | ingress | Deny SQL/UC-metadata access to sensitive namespaces (hr/payroll/pii/comp) outside the data-privacy group. |
| [guard-warehouse-sql](../../apps/databricks/guard-warehouse-sql/policy.md) | databricks | ingress | Guard Databricks SQL against writes and DDL, forcing read-only for non data-engineering callers. |
| [fence-sensitive-datasets](../../apps/bigquery/fence-sensitive-datasets/policy.md) | bigquery | ingress | Fence regulated dataset prefixes (finance_/pii_/phi_) by IdP group across SQL and metadata tools. |
| [guard-warehouse-sql](../../apps/bigquery/guard-warehouse-sql/policy.md) | bigquery | ingress | Block destructive SQL (DML/DDL/GRANT/CALL/LOAD DATA/EXECUTE IMMEDIATE); read-only default. |
| [guard-warehouse-export](../../apps/bigquery/guard-warehouse-export/policy.md) | bigquery | ingress | Block EXPORT DATA/MODEL, EXTERNAL_QUERY, cross-project writes, and out-of-allowlist project IDs. |
| [query-allowlist](../../apps/salesforce/query-allowlist/policy.md) | salesforce | ingress | Restrict the SOQL `FROM` object to an allowlist (Account/Contact/Opportunity); other objects denied. |

### Minimize the data an agent can pull in one call

Ingress controls that clamp bulk-read levers — page sizes, unbounded list/search, and mass enumeration — so a single agent request cannot sweep an entire ledger, customer base, or contact list into context. Keeping the volume of retrieved cardholder-adjacent data to the minimum required supports **3.2.1** (minimize account-data storage / anti-sprawl), **7.2.6**, and **3.4.2**.

| Policy | App | Direction | Purpose |
| --- | --- | --- | --- |
| [cap-bulk-export](../../apps/quickbooks/cap-bulk-export/policy.md) | quickbooks | ingress | Clamp the bulk-read levers on QBO `search_*` tools so the agent cannot pull the whole general ledger or full lists. |
| [cap-bulk-export](../../apps/netsuite/cap-bulk-export/policy.md) | netsuite | ingress | Clamp or require `pageSize` on `ns_runCustomSuiteQL`, capping bulk SuiteQL reads over the ERP. |
| [cap-bulk-export](../../apps/salesforce/cap-bulk-export/policy.md) | salesforce | ingress | Block bulk PII extraction by inspecting the SOQL/SOSL query string on Salesforce query tools. |
| [cap-bulk-export](../../apps/hubspot/cap-bulk-export/policy.md) | hubspot | ingress | Clamp the page size of covered HubSpot bulk-read tools so one call can never return more than 50 records. |
| [cap-contact-enumeration](../../apps/intercom/cap-contact-enumeration/policy.md) | intercom | ingress | Cap Intercom contact enumeration on `search_contacts` and generic contact search to stop full-base sweeps. |

### Least-privilege access to card-data-adjacent apps

Ingress controls that fence the structured-PII read surface of support and service apps behind matching IdP groups — narrowing the effective privilege of the agent's OAuth grant regardless of how broad the underlying token is. Supports **7.2.1 / 7.2.2** (access by job function, least privilege) and **7.2.5** (application/system account least privilege).

| Policy | App | Direction | Purpose |
| --- | --- | --- | --- |
| [fence-contact-reads](../../apps/intercom/fence-contact-reads/policy.md) | intercom | ingress | Role-gate Intercom's structured-PII contact and company read surface to documented support/CRM groups. |
| [fence-sensitive-tables](../../apps/servicenow/fence-sensitive-tables/policy.md) | servicenow | ingress | Fence the most sensitive ServiceNow tables (sys_user, HR, CMDB) behind owner IdP groups across Table-API routes. |

### Gate payment and money-movement operations

Ingress controls that keep the agent read-only against payment systems by default and gate refunds, payouts, and billing mutations to finance groups with amount ceilings. Supports **7.2.1 / 7.2.2** and **7.2.5** (application-account least privilege), and **3.4.2** by keeping stored payment data from being relocated.

| Policy | App | Direction | Purpose |
| --- | --- | --- | --- |
| [role-gate-writes-billing](../../apps/stripe/role-gate-writes-billing/policy.md) | stripe | ingress | Read-only Stripe by default; gate named billing write/destructive tools to finance/billing-admin groups. |
| [gate-money-movement-refund-cap](../../apps/stripe/gate-money-movement-refund-cap/policy.md) | stripe | ingress | Gate Stripe refunds to finance/billing-admin and deny any refund whose amount exceeds the configured cap. |
| [gate-money-movement](../../apps/quickbooks/gate-money-movement/policy.md) | quickbooks | ingress | Gate QBO money-movement tools behind finance-group membership and an amount ceiling. |

> Policy bodies live under [`apps/`](../../apps/). This page only links to them — see the top-level [README](../../README.md#where-policies-live) for the rationale.

## How this bundle composes

The egress masking policies are transform-only (`default allow := true`), scoped to their own app, and attach to the response pipeline — so they never deny a call and never collide with each other or with the ingress controls. The ingress policies (query fencing, bulk caps, role gates, money-movement gates) run on the request pipeline, are each single-purpose, and fail closed when identity claims or arguments are missing. Attach the egress guards everywhere PAN can surface and the ingress guards on the payment systems and warehouses where cardholder data actually lives; they are designed to stack.

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `pci-dss` among its `bundles`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

## What it does NOT cover

PCI DSS is far broader than the agent channel, and several requirements are out of the gateway's reach by design. These policies do **not**:

- **Encrypt or tokenize stored PAN (3.5.1) or protect it in transit (4.2.1).** Rendering PAN unreadable at rest and strong cryptography on the wire are properties of each app, its tokenization provider, and the HTTPS/API stack — not a per-call policy decision. The bundle reduces the number of places PAN lands; it does not encrypt data.
- **Perform authentication or MFA (8.3.x).** DTwo consumes the identity claims your IdP (Okta/Entra) and each app produce; it does not perform authentication factors.
- **Manage retention or secure deletion (3.2.1).** Retention schedules and secure disposal inside each app are app and process controls.
- **Run the access reviews, log reviews, or scope-confirmation processes (7.2.4, 10.4.1, 12.5.2).** The decision log is strong evidence for these reviews, but the reviews themselves — and remediation of app/IdP entitlements — are organizational processes.
- **Meet log-retention profiles on their own (10.5.1).** The gateway emits complete decision records; retaining them for 12 months with the most recent 3 immediately available depends on your downstream log storage.
- **Manage third-party service providers (12.8.x).** Vendor due diligence, contracts, and the responsibility matrix are a governance process.
- **Cover non-MCP access.** Web-UI, native-API, clipboard, and screen channels, and PAN or secrets that pre-date the gateway, need endpoint, app, and secret-scanning controls. These policies see only agent traffic over MCP.
- **Address the PCI requirements outside the agent path entirely** — network security controls (Req 1–2), anti-malware (Req 5), secure development and patching (Req 6), physical security (Req 9), and scanning/penetration testing (Req 11).

Nothing here catches every path to a PCI outcome; the bundle is the strongest available technical control on the agent channel, layered on top of the controls you already run beneath it.

---

> **Compliance note.** This bundle supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
