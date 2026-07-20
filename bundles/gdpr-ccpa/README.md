# GDPR & CCPA/CPRA bundle

The **General Data Protection Regulation** (Regulation (EU) 2016/679) governs any processing of EU personal data; the **California Consumer Privacy Act, as amended by the CPRA** (Cal. Civ. Code §1798.100 et seq.) governs California consumers' personal information — including employees' and B2B contacts' — with a distinct category of *sensitive personal information* and new rules on automated decision-making. When an AI agent reads and writes customer, employee, and prospect data across connected SaaS apps, that is processing attributable to the controller under GDPR and collection, use, and disclosure by the business under CCPA. Every over-broad query, every field returned to the model, every agent-initiated disclosure is a compliance event on that path. This bundle is a starting posture for it: scope each tool call, gate it by identity, minimise what comes back, and block the disclosures the frameworks care about.

These policies **support alignment with GDPR & CCPA/CPRA on the MCP path only.** They act on the tool calls an AI agent makes through the DTwo gateway; web-UI logins, native-API integrations, and in-app activity are outside their reach by design, and no policy or bundle makes an organization GDPR- or CCPA-compliant. Both frameworks impose obligations — legal bases, contracts, notices, data-subject-request fulfilment, retention, encryption at rest, residency — that no gateway can satisfy. Compliance is a property of your whole program.

## What this bundle covers

100 policies across 31 apps, grouped below by the GDPR/CCPA control they support. Every policy is single-purpose and composes with the others on the same pipeline direction. Policy bodies live under [`apps/`](../../apps/); this page only links to them.

The per-decision audit log that records every one of these calls — principal, action, resource, context, decision — is a property of the gateway beneath the bundle, not a policy in it. That record is what supports the accountability and records duties for the agent-mediated slice of traffic: GDPR Art. 5(2)/24 (demonstrability), Art. 30 (records of processing activities), Arts. 33/34 (breach forensics), and the "reasonable security" and audit expectations under CCPA §1798.100(e) and 11 CCR §§7120–7124.

### 1. Data minimisation — cap the blast radius of a read (Art. 5(1)(c); 11 CCR §7002)

Clamp bulk reads, exports, and search fan-out, and hold agents to read-only or allowlisted queries, so a single call can't harvest a table, a mailbox, or a roster. Personal data must be adequate, relevant, and limited to what is necessary — enforced per call.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [cap-bulk-export](../../apps/gmail/cap-bulk-export/) | gmail | ingress | Cap batch content reads and clamp search `maxResults` to throttle mass mailbox harvesting. |
| [cap-bulk-export](../../apps/google-drive/cap-bulk-export/) | google-drive | ingress | Clamp Drive search/listing page sizes to a ceiling (transform-only, never denies). |
| [cap-bulk-export](../../apps/salesforce/cap-bulk-export/) | salesforce | ingress | Cap SOQL row limits and gate org-wide SOSL search by IdP group. |
| [query-allowlist](../../apps/salesforce/query-allowlist/) | salesforce | ingress | Restrict the SOQL `FROM` object to an allowlist (Account/Contact/Opportunity). |
| [read-only](../../apps/salesforce/read-only/) | salesforce | ingress | Allowlist-based read-only posture; all write tools fail closed. |
| [cap-bulk-export](../../apps/hubspot/cap-bulk-export/) | hubspot | ingress | Clamp bulk-read page sizes and batch-read arrays to 50 records. |
| [read-only](../../apps/hubspot/read-only/) | hubspot | ingress | Deny the write tool to enforce a read-only HubSpot posture. |
| [cap-read-field-exposure](../../apps/jira/cap-read-field-exposure/) | jira | ingress | Strip over-broad field tokens and clamp search `maxResults` to 50. |
| [cap-directory-and-document-egress](../../apps/docusign/cap-directory-and-document-egress/) | docusign | egress | Truncate account-wide user-directory listings for non-admins and gate signed-document downloads. |
| [cap-bulk-export](../../apps/netsuite/cap-bulk-export/) | netsuite | ingress | Clamp SuiteQL `pageSize` to bound per-call ERP bulk export. |
| [cap-search-export](../../apps/glean/cap-search-export/) | glean | ingress | Clamp bulk-export params (result ceiling, strip exhaustive) on Glean search. |
| [cap-contact-enumeration](../../apps/intercom/cap-contact-enumeration/) | intercom | ingress | Deny bulk-enumeration query shapes on contact search and clamp page size. |
| [cap-bulk-export](../../apps/quickbooks/cap-bulk-export/) | quickbooks | ingress | Clamp `fetchAll`/`limit` on QBO search tools to prevent whole-ledger/roster export. |
| [cap-roster-export](../../apps/gusto/cap-roster-export/) | gusto | ingress | Clamp `per` and strip `include=custom_fields` on employee/contractor listings for non-admins. |
| [cap-bulk-record-reads](../../apps/airtable/cap-bulk-record-reads/) | airtable | ingress | Cap `maxRecords` to 50 and strip raw `filterByFormula` for non-analysts. |
| [guard-warehouse-sql-dax](../../apps/power-bi/guard-warehouse-sql-dax/) | power-bi | ingress | Deny bare full-table `EVALUATE` DAX (whole-table dumps) to prevent wholesale read-back. |

### 2. Egress minimisation — redact PII, sensitive PI, and secrets on the way out (Art. 5(1)(c), Art. 9; §1798.121, §1798.150)

Egress redaction strips personal data, special-category and sensitive-PI patterns (SSNs, financial-account and card numbers, national IDs), and live credentials from responses before an agent carries them into its context or a downstream app. Transform-only where marked — they clean, they don't deny. Reducing what reaches the model directly shrinks the "nonredacted PI exposed" surface that CCPA §1798.150 attaches statutory damages to.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [redact-pii-egress](../../apps/ms365/redact-pii-egress/) | ms365 | egress | Redact SSN, Luhn-validated PAN, IBAN, and US phone numbers from mail/Excel/SharePoint/transcript/Teams responses. |
| [mask-pan-egress](../../apps/gmail/mask-pan-egress/) | gmail | egress | Mask payment-card numbers in Gmail mailbox-read responses (full-PAN group exempt). |
| [redact-pii-egress](../../apps/google-drive/redact-pii-egress/) | google-drive | egress | Redact email/SSN/national-ID/phone from Drive content responses. |
| [redact-attendee-pii](../../apps/google-calendar/redact-attendee-pii/) | google-calendar | egress | Redact attendee PII/PHI and meeting join links from calendar reads. |
| [mask-pan-egress](../../apps/slack/mask-pan-egress/) | slack | egress | Luhn-validated PAN masking to BIN+last4 in Slack read/search responses. |
| [redact-profile-pii](../../apps/slack/redact-profile-pii/) | slack | egress | Redact email/phone/custom-field PII from Slack user-lookup responses. |
| [redact-sensitive-info](../../apps/slack/redact-sensitive-info/) | slack | ingress | Redact PII/secrets/card numbers from outbound Slack message args. |
| [redact-pii](../../apps/salesforce/redact-pii/) | salesforce | egress | Redact contact PII fields and PAN/SSN/phone/email patterns in responses. |
| [redact-pii-egress](../../apps/box/redact-pii-egress/) | box | egress | Redact SSN/PAN/bank/email/phone PII from Box content responses (group-exempt). |
| [redact-pii](../../apps/hubspot/redact-pii/) | hubspot | egress | Redact contact PII (phone/email/SSN) in tool responses. |
| [redact-sensitive-info](../../apps/jira/redact-sensitive-info/) | jira | egress | Redact PII/secrets/PAN from Jira issue-view responses. |
| [redact-pii-egress](../../apps/confluence/redact-pii-egress/) | confluence | egress | Redact SSN/email/US-phone PII from Confluence page/comment/search reads (group-exempt). |
| [redact-tab-values-egress](../../apps/docusign/redact-tab-values-egress/) | docusign | egress | Redact SSN and bank routing/account numbers and mask card PANs in envelope reads (hr/finance exempt). |
| [mask-pan-egress](../../apps/zapier/mask-pan-egress/) | zapier | egress | Luhn-validated PAN masking to BIN+last4 in Zapier read responses. |
| [redact-pii-egress](../../apps/notion/redact-pii-egress/) | notion | egress | Redact email/phone PII from Notion reads for non-HR/legal callers. |
| [redact-pii-egress-customer](../../apps/stripe/redact-pii-egress-customer/) | stripe | egress | Mask customer email/phone/address/last4 in bulk Stripe read responses (finance exempt). |
| [redact-pii-egress](../../apps/snowflake/redact-pii-egress/) | snowflake | egress | Mask SSN/email/phone in result sets (pii-cleared group exempt). |
| [redact-financial-pii](../../apps/netsuite/redact-financial-pii/) | netsuite | egress | Redact SSN/TIN/IBAN and labelled bank-account numbers in NetSuite read responses. |
| [redact-task-pii](../../apps/asana/redact-task-pii/) | asana | egress | Redact SSN/email/phone/IBAN in task/comment/status reads (privacy-officer exempt). |
| [redact-board-pii-egress](../../apps/monday/redact-board-pii-egress/) | monday | egress | Redact SSN/email/phone/national-ID on board/doc/update reads; non-admin deny of the directory tool. |
| [redact-pii-egress](../../apps/glean/redact-pii-egress/) | glean | egress | Redact SSN/PAN/IBAN from Glean read responses before they reach agent context. |
| [mask-pan-egress](../../apps/intercom/mask-pan-egress/) | intercom | egress | Luhn-validated PAN masking to BIN+last4 in conversation responses. |
| [redact-conversation-pii](../../apps/intercom/redact-conversation-pii/) | intercom | egress | Redact SSN/national-ID/email/phone/credential shapes from conversation and contact reads. |
| [redact-pii-egress-employee](../../apps/quickbooks/redact-pii-egress-employee/) | quickbooks | egress | Mask SSN/address/pay/tax-ID/bank fields in QBO employee/vendor reads for non-HR/finance callers. |
| [redact-content-egress](../../apps/dropbox/redact-content-egress/) | dropbox | egress | Mask card PANs and redact SSN/email/phone/secrets in file-content responses (pci carve-out). |
| [redact-financial-ids-egress](../../apps/gusto/redact-financial-ids-egress/) | gusto | egress | Mask US SSN and label-anchored bank-account/ABA-routing numbers in every Gusto response. |
| [redact-pii-egress](../../apps/airtable/redact-pii-egress/) | airtable | egress | Redact SSN/email/phone/national-ID in record-read responses (data-privileged group exempt). |
| [mask-pan-egress](../../apps/databricks/mask-pan-egress/) | databricks | egress | Luhn-validated PAN masking to BIN+last4 in SQL/Genie/AI-Search responses. |
| [redact-pii-egress](../../apps/databricks/redact-pii-egress/) | databricks | egress | Redact SSN/email/phone in Databricks response payloads outside the data-privacy group. |
| [redact-pii-egress](../../apps/bigquery/redact-pii-egress/) | bigquery | egress | Redact SSN/Luhn-validated PAN/email in query results and optionally cap result rows (group exempt). |
| [redact-pii-meeting-intelligence](../../apps/zoom/redact-pii-meeting-intelligence/) | zoom | egress | Redact email/phone/SSN in Zoom meeting-intelligence responses (transcripts, summaries, docs). |
| [redact-pii-query-results](../../apps/tableau/redact-pii-query-results/) | tableau | egress | Redact email/phone/SSN and mask card PANs in data-returning tool responses. |
| [redact-pii-dax-results](../../apps/power-bi/redact-pii-dax-results/) | power-bi | egress | Redact email/SSN/PAN in DAX/query/report-metadata results (fail-closed data-steward exemption). |
| [redact-customer-pii-egress](../../apps/linear/redact-customer-pii-egress/) | linear | egress | Redact customer revenue, tier/segment, and contact email in Customers read responses. |

### 3. Special-category and sensitive-scope fencing (Art. 9, Art. 5(1)(b); §1798.121)

Role-based limits on where an agent can look. HR, payroll, legal, security, and other regulated scopes — folders, tables, schemas, boards, projects, spaces, datasets, channels, directories — are fenced to their owning IdP groups across reads, writes, and search. This keeps special-category data (Art. 9) and sensitive PI (§1798.121) away from agents whose purpose doesn't cover it.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [fence-restricted-folders](../../apps/google-drive/fence-restricted-folders/) | google-drive | ingress | Deny reads/writes/copies touching an admin denylist of restricted Drive IDs (HR, M&A, board, payroll). |
| [deny-read-search-summarize-sensitive-channels](../../apps/slack/deny-read-search-summarize-sensitive-channels/) | slack | ingress | Deny read/search/summarize of a configured set of sensitive channels. |
| [guard-dm-privacy](../../apps/slack/guard-dm-privacy/) | slack | ingress | Deny agent read reach into DMs and private conversations (group-exempt). |
| [fence-sensitive-tables](../../apps/servicenow/fence-sensitive-tables/) | servicenow | ingress | Fence sys_user / HR / CMDB tables and user-directory reads behind owner IdP groups. |
| [fence-sensitive-folders](../../apps/box/fence-sensitive-folders/) | box | ingress | Fence pinned sensitive Box folder/file IDs by IdP group (read/move/copy/search). |
| [deny-view-search-sensitive-projects](../../apps/jira/deny-view-search-sensitive-projects/) | jira | ingress | Fence configured sensitive projects out of direct views and JQL search. |
| [deny-write-sensitive-projects](../../apps/jira/deny-write-sensitive-projects/) | jira | ingress | Block writes against configured sensitive projects. |
| [fence-restricted-spaces](../../apps/confluence/fence-restricted-spaces/) | confluence | ingress | Fence restricted spaces (HR/LEGAL/SEC) out of search, listing, and lookup unless the group grants access. |
| [fence-user-directory](../../apps/notion/fence-user-directory/) | notion | ingress | Fence the member-directory tool (names/emails/IDs) to admin/IT IdP groups. |
| [fence-sensitive-schemas](../../apps/snowflake/fence-sensitive-schemas/) | snowflake | ingress | Group-gate PII/PHI/HR/FINANCE schema references and block `SELECT *` on fenced schemas. |
| [fence-hr-payroll-suiteql](../../apps/netsuite/fence-hr-payroll-suiteql/) | netsuite | ingress | Deny HR/payroll SuiteQL and saved-search reads outside the hr IdP group. |
| [fence-sensitive-projects](../../apps/asana/fence-sensitive-projects/) | asana | ingress | Fence writes to sensitive project GIDs (HR/legal/M&A/incident) to mapped IdP groups. |
| [fence-sensitive-boards](../../apps/monday/fence-sensitive-boards/) | monday | ingress | Fence sensitive board/workspace IDs (HR, CRM, security) across reads, writes, and search. |
| [fence-datasource-scope](../../apps/glean/fence-datasource-scope/) | glean | ingress | Restrict which indexed datasource a Glean search may target by IdP group. |
| [fence-contact-reads](../../apps/intercom/fence-contact-reads/) | intercom | ingress | Role-gate the structured-PII contact/company read surface to support/CRM groups. |
| [fence-sensitive-paths](../../apps/dropbox/fence-sensitive-paths/) | dropbox | ingress | Fence protected path prefixes (HR/Finance/Legal/Customers) to mapped IdP team groups. |
| [fence-comp-payroll-reads](../../apps/gusto/fence-comp-payroll-reads/) | gusto | ingress | Deny compensation, pay-register, contractor-payment, and employment-action reads outside hr-payroll-admins. |
| [fence-base-allowlist](../../apps/airtable/fence-base-allowlist/) | airtable | ingress | Confine base-scoped record/schema tools to an operator allowlist of sanctioned base IDs. |
| [fence-sensitive-schemas](../../apps/databricks/fence-sensitive-schemas/) | databricks | ingress | Deny SQL/metadata access to sensitive namespaces (hr/payroll/pii/phi/comp) outside the data-privacy group. |
| [fence-sensitive-datasets](../../apps/bigquery/fence-sensitive-datasets/) | bigquery | ingress | Fence regulated dataset prefixes (phi_/finance_/pii_) by IdP group across SQL and metadata. |
| [fence-agentic-search](../../apps/zoom/fence-agentic-search/) | zoom | ingress | Fence agentic search to Zoom-native corpora, stripping external Salesforce/Workday/ServiceNow entities. |
| [guard-transcripts-by-group](../../apps/zoom/guard-transcripts-by-group/) | zoom | ingress | Gate Zoom transcript/summary and recording-passcode retrieval by IdP group. |
| [fence-datasource-scope](../../apps/tableau/fence-datasource-scope/) | tableau | ingress | Per-datasource LUID allowlist on query and analyst-only gate on image-render tools. |

### 4. Least-privilege by default — data protection by design and default, processing on instructions (Art. 25, Art. 29 / Art. 32(4))

The default posture processes nothing an agent isn't explicitly cleared for. Per-app role gates open writes only to the matching IdP group; field-protection keeps regulated attributes (ownership, consent flags, PII) from silent agent edits. This is Art. 25(2) made concrete for the agent channel, and the technical confinement of an agent to the controller's standing instructions (Art. 29 / Art. 32(4)). By keeping the consequential write behind a human in the matching group, these gates also keep agent workflows from "solely automated" significant decisions (Art. 22; 11 CCR §7200 et seq. — ADMT).

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [role-gate-writes](../../apps/ms365/role-gate-writes/) | ms365 | ingress | Reads pass for everyone; writes require the m365-writers IdP group. |
| [role-gate-writes](../../apps/gmail/role-gate-writes/) | gmail | ingress | Read-only by default; write/send/label/filter/delete tools require the writer group (fail-closed). |
| [role-gate-writes](../../apps/google-drive/role-gate-writes/) | google-drive | ingress | Gate Drive write-class tools to the drive-writers IdP group; reads pass. |
| [role-gate-writes](../../apps/slack/role-gate-writes/) | slack | ingress | Gate Slack write-class tools behind an IdP writers group. |
| [role-gate-writes](../../apps/salesforce/role-gate-writes/) | salesforce | ingress | Reads for all; create/update gated to approved groups; unknown tools fail closed. |
| [protect-contact-fields](../../apps/salesforce/protect-contact-fields/) | salesforce | ingress | Block Contact updates that modify protected fields (ownership, PII, consent flags). |
| [role-gate-writes](../../apps/servicenow/role-gate-writes/) | servicenow | ingress | Reads open; verified writes require the servicenow-writers group; unknown tools fail closed. |
| [role-gate-writes](../../apps/box/role-gate-writes/) | box | ingress | Read-only by default; gate all Box write/mutating tools behind a writer IdP group. |
| [role-gate-writes](../../apps/hubspot/role-gate-writes/) | hubspot | ingress | Gate all HubSpot write tools behind the crm-writers IdP group. |
| [role-gate-writes](../../apps/jira/role-gate-writes/) | jira | ingress | Gate all Jira write tools to the writer IdP group; reads open to everyone. |
| [role-gate-writes](../../apps/zapier/role-gate-writes/) | zapier | ingress | Read-only by default; deny all writes across the aggregator unless caller is in automation-writers. |
| [role-gate-writes-billing](../../apps/stripe/role-gate-writes-billing/) | stripe | ingress | Read-only by default; gate named billing write/destructive tools to finance/billing-admin groups. |
| [role-gate-writes](../../apps/dropbox/role-gate-writes/) | dropbox | ingress | Deny create/upload/copy/move/restore tools unless caller is in the dropbox-writers group. |

### 5. Confidentiality and disclosure control — external sends, share links, exfil channels, cross-border flows (Art. 5(1)(f) / Art. 32, Arts. 44/46; §1798.100(e))

The disclosure line, enforced on the agent channel: deny sends and invites to external recipients, downgrade or deny anonymous share links, block warehouse export/unload, and stop org-wide or public publication of personal data. Blocking agent-initiated cross-app and external-domain flows is where the gateway touches Arts. 44/46 on the MCP path.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [guard-external-send](../../apps/ms365/guard-external-send/) | ms365 | ingress | Deny agent email sends when any recipient is outside the corporate-domain allowlist. |
| [guard-share-links](../../apps/ms365/guard-share-links/) | ms365 | ingress | Downgrade anonymous share links to org scope, inject expiry, deny anonymous-edit and external invites. |
| [guard-external-send](../../apps/gmail/guard-external-send/) | gmail | ingress | Deny sends when any to/cc/bcc recipient is outside the corporate-domain allowlist; draft instead. |
| [guard-external-attendees](../../apps/google-calendar/guard-external-attendees/) | google-calendar | ingress | Block calendar invites to attendees outside the corporate-domain allowlist. |
| [guard-public-exposure](../../apps/google-calendar/guard-public-exposure/) | google-calendar | ingress | Block public visibility and guest-delegation flags on event create/update. |
| [guard-external-send](../../apps/slack/guard-external-send/) | slack | ingress | Deny agent posts to externally shared Slack Connect channels. |
| [guard-share-links-external](../../apps/box/guard-share-links-external/) | box | ingress | Block external collaborations to non-corp domains and anonymous public share links. |
| [guard-external-recipients](../../apps/docusign/guard-external-recipients/) | docusign | ingress | Deny envelope creation/recipient updates when any recipient domain is outside the counterparty allowlist. |
| [guard-external-send](../../apps/zapier/guard-external-send/) | zapier | ingress | Deny writes naming a recipient outside corporate domains, including addresses hidden in free text. |
| [guard-warehouse-export](../../apps/snowflake/guard-warehouse-export/) | snowflake | ingress | Deny COPY INTO external stage/URL, CREATE STAGE, share creation, and PUT/GET off-perimeter export. |
| [guard-warehouse-export](../../apps/bigquery/guard-warehouse-export/) | bigquery | ingress | Block EXPORT DATA/MODEL, EXTERNAL_QUERY, cross-project writes, and out-of-allowlist project_id. |
| [guard-share-links-external](../../apps/dropbox/guard-share-links-external/) | dropbox | ingress | Deny public share links, download URLs, and file requests unless caller is in the dropbox-sharing group. |
| [guard-external-chat-invites](../../apps/zoom/guard-external-chat-invites/) | zoom | ingress | Block external contact invites and external history exposure in Zoom Team Chat channels. |
| [deny-public-publication](../../apps/confluence/deny-public-publication/) | confluence | ingress | Deny org-wide and anonymous-public Confluence page/blog publication; scoped writes pass. |

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `bundles: ["gdpr-ccpa"]`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The policies compose by direction. The egress redaction policies (theme 2, plus the docusign egress cap) attach to the response pipeline and are transform-only where marked, so they never deny and never collide with the ingress controls. The ingress policies are each single-purpose — a cap, a role gate, a fence, a disclosure guard — so several attach to the same app on the same direction without interfering. Pick a read-only posture *or* the narrow write controls for an app, not both; combining them is redundant but harmless.

## What this bundle does NOT cover

These policies act only on agent traffic over MCP, and only some GDPR/CCPA requirements reduce to a gateway decision. Out of scope by design:

- **Legal bases, notices, and consent capture.** Establishing a lawful basis (GDPR Art. 6), serving privacy notices, and collecting or honoring consent org-wide are legal and product acts. The gateway can execute a consent-driven restriction if you encode it, but it does not run the consent machinery.
- **Data-subject and consumer rights (Arts. 15–21; §1798.105/.106).** Access, rectification, erasure, restriction, objection, deletion, and correction happen inside each app and via process. The audit log helps *scope* the agent-mediated slice of a rights request, but the rights machinery is app and process.
- **Storage limitation and retention (Art. 5(1)(e)).** Retention schedules live inside each app and in your records policy. Denying agent copy-out limits *proliferation* into unmanaged stores, but the gateway cannot implement retention.
- **Processor and service-provider contracts (Art. 28; §§7050–7051).** DPAs and SP/contractor contracts are legal instruments. DTwo evidence supports the "sufficient guarantees" assessment for the agent channel but cannot substitute for the contract.
- **DPIAs and risk assessments (Art. 35; 11 CCR §§7150–7157).** These are organizational documents. The policies here are exactly the safeguards such an assessment should cite, with logs as evidence they operate — but the assessment itself is process.
- **Encryption at rest and data residency.** Encryption at rest, and where each SaaS app stores and replicates data, are app and infrastructure concerns. International-transfer instruments (SCCs, adequacy under Arts. 44/46) are legal; the gateway can only block agent-visible flows.
- **ADMT notices and opt-out (Art. 22; 11 CCR §7200 et seq.).** The role gates in theme 4 keep a human in the loop on consequential writes; the pre-use notice, opt-out plumbing, and the legal scoping judgment are process.
- **Web-UI, native-API, and in-app access.** A person opening a record in the app's own UI, or a native integration writing to it, never passes through the gateway. Those paths stay governed by the app and your IdP.
- **Tenant-specific inputs.** Sensitive schema names, folder and board IDs, project keys, channel lists, and corporate-domain allowlists are yours, not ours; supply them at import time. IdP group names in these policies are placeholders — map them to your directory's groups before relying on them.

---

> **Compliance note.** This bundle supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
