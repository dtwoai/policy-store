# SOC 2 (Trust Services Criteria) bundle

SOC 2 is not a law and not a data type — it is an attestation framework. A licensed CPA firm examines a service organization's controls against the AICPA **Trust Services Criteria**: the **Security** Common Criteria (CC1–CC9, mandatory) plus the optional **Availability**, **Processing Integrity**, **Confidentiality**, and **Privacy** categories. The criteria are principles-based — the entity defines its own system, commitments, and controls, and the auditor tests whether they are suitably designed and operating effectively over a period. When an employee connects Salesforce, GitHub, or Snowflake to an AI agent over MCP, the agent inherits that user's credential and becomes a new, privileged access path into systems that sit inside the SOC 2 boundary. This bundle is a starting posture for that path: a DTwo policy can *be* the control an entity describes for the agent channel, and the gateway's per-decision log its evidence.

These policies **support alignment with SOC 2 (Trust Services Criteria) on the MCP path only.** They act on agent traffic that flows through the gateway; web-UI logins, native-API integrations, and in-app activity are outside their reach by design, and no policy or bundle makes an organization SOC 2 compliant. SOC 2 is an attestation over your whole control environment — the agent channel is one control among the many an auditor tests.

## What this bundle covers

173 policies across 32 apps, grouped below by the Trust Services Criteria they support. Each policy appears once, under its primary theme. Every policy is single-purpose and composes with the others on the same pipeline direction. Policy bodies live under [`apps/`](../../apps/); this page only links to them.

The per-decision audit log beneath the bundle — principal, action, resource, context, decision — is a property of the gateway, not a policy in it. That record is the Type II operating-effectiveness evidence for the CC6.x access criteria and the monitoring input for CC7.2 (anomaly detection) and CC7.3 (event evaluation). Every allow, deny, and transform below lands in it, attributed to an authenticated user.

### 1. Logical access & least privilege — the write floor (CC6.1, CC6.3)

The core CC6.3 pattern: reads stay open, writes require the matching IdP group, and specific high-impact writes are gated or denied outright. This is the per-app baseline that makes tool-level authorization keyed to identity — least privilege on the agent channel.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [role-gate-writes](../../apps/ms365/role-gate-writes/) | ms365 | ingress | Reads pass for everyone; writes require the m365-writers IdP group. |
| [role-gate-writes](../../apps/gmail/role-gate-writes/) | gmail | ingress | Read-only by default; every write/send/label/filter/delete tool requires the writer group (fail-closed). |
| [role-gate-writes](../../apps/google-drive/role-gate-writes/) | google-drive | ingress | Gate Drive write-class tools to the drive-writers IdP group; reads pass through. |
| [role-gate-writes](../../apps/slack/role-gate-writes/) | slack | ingress | Gate Slack write-class tools behind an IdP writers group. |
| [deny-channel-creation](../../apps/slack/deny-channel-creation/) | slack | ingress | Deny Slack channel-creation tool calls. |
| [role-gate-writes](../../apps/salesforce/role-gate-writes/) | salesforce | ingress | Reads for all; create/update gated to approved groups; unknown tools fail closed. |
| [read-only](../../apps/salesforce/read-only/) | salesforce | ingress | Allowlist-based read-only posture; all write tools fail closed. |
| [protect-contact-fields](../../apps/salesforce/protect-contact-fields/) | salesforce | ingress | Block Contact updates that modify protected fields (ownership, PII, consent flags). |
| [role-gate-writes](../../apps/servicenow/role-gate-writes/) | servicenow | ingress | Reads open; verified writes require the servicenow-writers group; unknown tools fail closed. |
| [role-gate-writes](../../apps/box/role-gate-writes/) | box | ingress | Read-only by default; gate all Box write/mutating tools behind a writer IdP group. |
| [role-gate-writes](../../apps/hubspot/role-gate-writes/) | hubspot | ingress | Gate all HubSpot write tools behind the crm-writers IdP group. |
| [read-only](../../apps/hubspot/read-only/) | hubspot | ingress | Deny the write tool to enforce a read-only HubSpot posture. |
| [role-gate-writes](../../apps/jira/role-gate-writes/) | jira | ingress | Gate all Jira write tools to the writer IdP group; reads open to everyone. |
| [role-gate-writes](../../apps/zapier/role-gate-writes/) | zapier | ingress | Read-only by default; deny all writes across the aggregator unless caller is in automation-writers. |
| [role-gate-writes-billing](../../apps/stripe/role-gate-writes-billing/) | stripe | ingress | Read-only by default; gate named billing write/destructive tools to finance/billing-admin groups. |
| [gate-memory-writes](../../apps/glean/gate-memory-writes/) | glean | ingress | Role-gate Glean memory writes (add/update/delete) to a pilot group; reads pass. |
| [role-gate-writes](../../apps/dropbox/role-gate-writes/) | dropbox | ingress | Deny create/upload/copy/move/restore tools unless caller is in the dropbox-writers group. |
| [role-gate-compute-ops](../../apps/databricks/role-gate-compute-ops/) | databricks | ingress | Role-gate cluster/job/notebook-export compute control to the platform-engineering group. |
| [role-gate-writes-engineering](../../apps/github/role-gate-writes-engineering/) | github | ingress | Gate write/destructive GitHub tools to the engineering IdP group; read-only for everyone else. |
| [block-rls-bypass-service-principal](../../apps/power-bi/block-rls-bypass-service-principal/) | power-bi | ingress | Deny RLS-sensitive read/query tools under service-principal or unconfirmed identity. |

### 2. Boundary control — shut the escape hatches and standing side-channels (CC6.6, CC6.8, CC9.2)

CC6.6 makes the gateway the boundary control for the agent channel; CC6.8 and CC9.2 extend it to unauthorized tools and vendor risk. Default-deny allowlists fail closed on renamed or newly introduced upstream tools; escape-hatch denials shut the raw-API passthroughs that would bypass every other policy; and persistence guards deny the standing automations, filters, and webhooks that outlive a session.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [deny-graph-batch](../../apps/ms365/deny-graph-batch/) | ms365 | ingress | Blanket-deny the raw Graph batch passthrough (the escape hatch that bypasses per-tool policy) except for admins. |
| [guard-mailbox-persistence](../../apps/ms365/guard-mailbox-persistence/) | ms365 | ingress | Deny mail-rule/mailbox-settings/Graph-subscription creation (BEC persistence and exfil channels). |
| [guard-mailbox-persistence](../../apps/gmail/guard-mailbox-persistence/) | gmail | ingress | Deny Gmail filter-creation tools that can auto-forward or auto-delete mail — BEC persistence outliving the session. |
| [deny-escape-hatches](../../apps/salesforce/deny-escape-hatches/) | salesforce | ingress | Unconditionally deny raw-code/raw-API tools (anonymous Apex, Tooling API, REST passthrough) that bypass policy. |
| [default-deny-unknown-tools](../../apps/servicenow/default-deny-unknown-tools/) | servicenow | ingress | Allowlist audited tool-name suffixes; deny any unknown/renamed/instance-defined tool (fail closed). |
| [default-deny-unknown-tools](../../apps/zapier/default-deny-unknown-tools/) | zapier | ingress | Default-deny any Zapier tool name not on the audited allowlist (upstream tool-drift fail-closed). |
| [freeze-toolset](../../apps/zapier/freeze-toolset/) | zapier | ingress | Deny the self-modifying meta-tools (enable/auto_provision/write_code/skill writes) for non-admins. |
| [constrain-connected-search](../../apps/notion/constrain-connected-search/) | notion | ingress | Deny Notion search scoped to connected Slack/Drive/Jira sources (aggregator side-door). |
| [deny-escape-hatches-api-write](../../apps/stripe/deny-escape-hatches-api-write/) | stripe | ingress | Deny the stripe_api_write raw passthrough (role gate + money-movement/account endpoint hard stop). |
| [default-deny-unknown-tools](../../apps/snowflake/default-deny-unknown-tools/) | snowflake | ingress | Deny unaudited/renamed Snowflake tool names; pass other servers. |
| [deny-composite-cortex-tools](../../apps/snowflake/deny-composite-cortex-tools/) | snowflake | ingress | Deny opaque CORTEX_AGENT_RUN/GENERIC agent-service tools the gateway cannot inspect per-statement. |
| [default-deny-unknown-tools](../../apps/netsuite/default-deny-unknown-tools/) | netsuite | ingress | Allowlist audited ns_* standard tools; deny and alert on unknown/custom SuiteScript tools. |
| [default-deny-unknown-tools](../../apps/monday/default-deny-unknown-tools/) | monday | ingress | Allowlist audited tool suffixes; block the GraphQL escape hatch, manage_tools, apps-mode, and drift. |
| [freeze-standing-automation](../../apps/monday/freeze-standing-automation/) | monday | ingress | Freeze standing automations/workflows and autonomous AI agents that outlive the session. |
| [default-deny-unknown-tools](../../apps/glean/default-deny-unknown-tools/) | glean | ingress | Allowlist verified built-in tools; deny self-expanding agents-as-tools/proxied writes. |
| [default-deny-unknown-tools](../../apps/gusto/default-deny-unknown-tools/) | gusto | ingress | Permit only the official Gusto tool names; deny drift/aggregator/community/renamed tools. |
| [default-deny-unknown-tools](../../apps/airtable/default-deny-unknown-tools/) | airtable | ingress | Default-deny allowlist; surface drift from new/renamed/unverified community tools. |
| [default-deny-unknown-tools](../../apps/databricks/default-deny-unknown-tools/) | databricks | ingress | Default-deny unknown/dynamic Databricks tools; fence system.ai proxies. |
| [default-deny-unknown-tools](../../apps/bigquery/default-deny-unknown-tools/) | bigquery | ingress | Only audited BigQuery tool suffixes pass; surface renamed/self-expanding tools as drift. |
| [fence-agentic-search](../../apps/zoom/fence-agentic-search/) | zoom | ingress | Fence agentic-search fan-out to Zoom-native corpora, stripping external Salesforce/Workday/ServiceNow entities. |
| [default-deny-unknown-tools](../../apps/tableau/default-deny-unknown-tools/) | tableau | ingress | Default-deny allowlist of the verified official Tableau tools; fail closed on tool drift. |
| [default-deny-unknown-modeling-ops](../../apps/power-bi/default-deny-unknown-modeling-ops/) | power-bi | ingress | Allowlist audited tool suffixes and deny unlisted/renamed tools past the modeling server's bypass. |
| [default-deny-unknown-tools](../../apps/linear/default-deny-unknown-tools/) | linear | ingress | Pin verified official Linear tool names; deny renamed/aggregator/community tools as drift. |
| [guard-webhook-persistence](../../apps/linear/guard-webhook-persistence/) | linear | ingress | Unconditionally deny webhook create/update/delete tools to block standing out-of-band exfil channels. |

### 3. Segregation of duties & change control — keep a human in the loop (CC6.3, CC8.1)

CC6.3 asks for segregation of duties; CC8.1 asks that changes to systems be authorized and approved. These policies keep the human authorization step intact: the agent may draft, propose, and read, but approval, dispatch, and identity-plane mutation stay with a named human or a gated group.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [freeze-identity-plane](../../apps/ms365/freeze-identity-plane/) | ms365 | ingress | Deny group/team membership and ownership mutations (identity-plane escalation) unless caller is IAM-admin. |
| [freeze-identity-plane](../../apps/servicenow/freeze-identity-plane/) | servicenow | ingress | Deny user/group create/update and group-membership changes unless caller is in identity-admins. |
| [require-human-approval-changes](../../apps/servicenow/require-human-approval-changes/) | servicenow | ingress | Unconditionally deny approve_change/reject_change/submit_change_for_approval (human-only SoD gate). |
| [role-gate-schema-consent](../../apps/hubspot/role-gate-schema-consent/) | hubspot | ingress | Gate portal-schema and marketing-consent mutations to the hubspot-admins group (tier above writers). |
| [require-human-approval-merge](../../apps/github/require-human-approval-merge/) | github | ingress | Keep a human in the loop on PR merges and approvals (SoD / change control). |
| [freeze-rls-role-edits](../../apps/power-bi/freeze-rls-role-edits/) | power-bi | ingress | Freeze RLS-role edit tools for all callers except a governance IdP group. |

### 4. Restrict transmission, movement & removal (CC6.7, P6.1)

CC6.7 is the strongest DLP hook in SOC 2 — restrict the transmission, movement, and removal of information — and P6.1 limits disclosure of personal information to third parties. These policies cap bulk export and search fan-out, deny agent sends and share links to external destinations, block public exposure, keep customer-facing surfaces internal, and keep secrets from being written into governed content.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [guard-external-send](../../apps/ms365/guard-external-send/) | ms365 | ingress | Deny agent email sends when any recipient is outside the corporate-domain allowlist. |
| [guard-share-links](../../apps/ms365/guard-share-links/) | ms365 | ingress | Downgrade anonymous share links to org scope, inject expiry, deny anonymous-edit links and external invites. |
| [cap-bulk-export](../../apps/gmail/cap-bulk-export/) | gmail | ingress | Cap batch content reads and clamp search maxResults to throttle mass mailbox harvesting. |
| [guard-external-send](../../apps/gmail/guard-external-send/) | gmail | ingress | Deny sends when any to/cc/bcc recipient is outside the corporate-domain allowlist; draft instead. |
| [cap-bulk-export](../../apps/google-drive/cap-bulk-export/) | google-drive | ingress | Clamp Drive search/listing page sizes to a cap (transform-only, never denies). |
| [guard-external-attendees](../../apps/google-calendar/guard-external-attendees/) | google-calendar | ingress | Block calendar invites to attendees outside the corporate-domain allowlist. |
| [guard-public-exposure](../../apps/google-calendar/guard-public-exposure/) | google-calendar | ingress | Block public visibility and guest-delegation flags on event create/update. |
| [block-secrets](../../apps/slack/block-secrets/) | slack | ingress | Deny Slack send-message calls whose body contains credentials/keys/tokens. |
| [deny-direct-messages](../../apps/slack/deny-direct-messages/) | slack | ingress | Deny message-write calls whose destination resolves to a DM/group DM. |
| [guard-external-send](../../apps/slack/guard-external-send/) | slack | ingress | Deny agent posts to externally shared Slack Connect channels. |
| [redact-sensitive-info](../../apps/slack/redact-sensitive-info/) | slack | ingress | Redact PII/secrets/card numbers from outbound Slack message args. |
| [cap-bulk-export](../../apps/salesforce/cap-bulk-export/) | salesforce | ingress | Cap SOQL row limits and gate org-wide SOSL search by IdP group. |
| [guard-share-links-external](../../apps/box/guard-share-links-external/) | box | ingress | Block external collaborations to non-corp domains and anonymous public share links. |
| [cap-bulk-export](../../apps/hubspot/cap-bulk-export/) | hubspot | ingress | Clamp bulk-read page sizes and batch-read arrays to 50 records. |
| [cap-read-field-exposure](../../apps/jira/cap-read-field-exposure/) | jira | ingress | Strip over-broad field tokens and clamp search maxResults to 50 (data minimisation). |
| [force-internal-jsm-comments](../../apps/jira/force-internal-jsm-comments/) | jira | ingress | Inject a restrictive commentVisibility so agent-drafted JSM notes stay off the customer portal. |
| [force-internal-comments](../../apps/servicenow/force-internal-comments/) | servicenow | ingress | Rewrite add_comment to an internal work note for non service-desk callers (keeps agent notes off the customer-visible journal). |
| [block-secrets](../../apps/confluence/block-secrets/) | confluence | ingress | Deny page/comment writes whose body contains a live credential before org-wide publication. |
| [deny-public-publication](../../apps/confluence/deny-public-publication/) | confluence | ingress | Deny agent-initiated org-wide blog posts and public/anonymous-access-space writes; force drafts private. |
| [cap-directory-and-document-egress](../../apps/docusign/cap-directory-and-document-egress/) | docusign | egress | Truncate account-wide user-directory listings for non-admins and gate signed-document downloads. |
| [guard-external-recipients](../../apps/docusign/guard-external-recipients/) | docusign | ingress | Deny envelope creation/recipient updates when any recipient domain is outside the counterparty allowlist. |
| [guard-external-send](../../apps/zapier/guard-external-send/) | zapier | ingress | Deny writes naming a recipient outside corporate domains, including addresses hidden in free text. |
| [guard-share-links-payment-redirect](../../apps/stripe/guard-share-links-payment-redirect/) | stripe | ingress | Scrub unapproved post-payment redirect_url on payment-link creation (transform-only). |
| [guard-warehouse-export](../../apps/snowflake/guard-warehouse-export/) | snowflake | ingress | Deny COPY INTO external stage/URL, CREATE STAGE, share creation, and PUT/GET off-perimeter export. |
| [cap-bulk-export](../../apps/netsuite/cap-bulk-export/) | netsuite | ingress | Clamp SuiteQL pageSize to bound per-call ERP bulk export (data minimisation). |
| [cap-search-export](../../apps/glean/cap-search-export/) | glean | ingress | Clamp bulk-export params (result ceiling, strip exhaustive) on Glean search. |
| [cap-contact-enumeration](../../apps/intercom/cap-contact-enumeration/) | intercom | ingress | Deny bulk-enumeration query shapes on contact search and clamp page size. |
| [deny-article-publish](../../apps/intercom/deny-article-publish/) | intercom | ingress | Deny Help Center article writes that set state=published unless caller is a content-admin (human review before go-live). |
| [cap-bulk-export](../../apps/quickbooks/cap-bulk-export/) | quickbooks | ingress | Clamp fetchAll/limit on search tools to prevent whole-ledger/roster bulk export. |
| [block-secrets-commits](../../apps/github/block-secrets-commits/) | github | ingress | Block live credentials/secrets from being committed into repos, gists, PRs, issues, and comments. |
| [deny-public-exposure-repos](../../apps/github/deny-public-exposure-repos/) | github | ingress | Deny public gists and personal-namespace forks; force new repositories private. |
| [guard-share-links-external](../../apps/dropbox/guard-share-links-external/) | dropbox | ingress | Deny public share links, download URLs, and file requests unless caller is in the dropbox-sharing group. |
| [cap-roster-export](../../apps/gusto/cap-roster-export/) | gusto | ingress | Clamp per to a ceiling and strip include=custom_fields on roster listings for non hr-payroll-admins. |
| [cap-bulk-record-reads](../../apps/airtable/cap-bulk-record-reads/) | airtable | ingress | Cap maxRecords to 50 and strip raw filterByFormula for non-analysts (data minimisation). |
| [guard-warehouse-export](../../apps/bigquery/guard-warehouse-export/) | bigquery | ingress | Block EXPORT DATA/MODEL, EXTERNAL_QUERY, cross-project writes, and out-of-allowlist project_id. |
| [block-secrets-chat](../../apps/zoom/block-secrets-chat/) | zoom | ingress | Block live secrets (keys, passwords, bearer tokens, private keys) in Zoom Team Chat message content. |
| [guard-external-chat-invites](../../apps/zoom/guard-external-chat-invites/) | zoom | ingress | Block external contact invites and external history exposure in Zoom Team Chat channels. |
| [guard-warehouse-sql-dax](../../apps/power-bi/guard-warehouse-sql-dax/) | power-bi | ingress | Deny bare full-table EVALUATE DAX (whole-table dumps) to prevent wholesale read-back exfiltration. |

### 5. Confidentiality — fence sensitive scopes and redact on egress (C1.1, CC6.7, P4.1)

C1.1's "maintain and protect" half is enforceable on the MCP path, and P4.1 limits the use of personal information to identified purposes. These policies fence sensitive scopes — folders, channels, projects, schemas, boards, datasources — to the roles that own them, and redact or mask PII, PHI, and secrets from responses before they reach agent context.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [redact-pii-egress](../../apps/ms365/redact-pii-egress/) | ms365 | egress | Redact SSN, Luhn-validated PAN, IBAN, and US phone numbers from mail/Excel/SharePoint/transcript/Teams responses. |
| [mask-pan-egress](../../apps/gmail/mask-pan-egress/) | gmail | egress | Mask payment-card-number shapes in Gmail mailbox-read responses (transform-only). |
| [fence-restricted-folders](../../apps/google-drive/fence-restricted-folders/) | google-drive | ingress | Deny reads/writes/copies touching an admin denylist of restricted Drive IDs (HR, M&A, board, payroll). |
| [guard-acl-recon](../../apps/google-drive/guard-acl-recon/) | google-drive | ingress | Deny ACL-read tools (collaborator emails + external-share map) unless caller is in infosec. |
| [redact-pii-egress](../../apps/google-drive/redact-pii-egress/) | google-drive | egress | Redact email/SSN/national-ID/phone from Drive content responses. |
| [redact-attendee-pii](../../apps/google-calendar/redact-attendee-pii/) | google-calendar | egress | Redact attendee PII/PHI and meeting join links from calendar read responses. |
| [deny-read-search-summarize-sensitive-channels](../../apps/slack/deny-read-search-summarize-sensitive-channels/) | slack | ingress | Deny read/search/summarize of a configured set of sensitive channels. |
| [guard-dm-privacy](../../apps/slack/guard-dm-privacy/) | slack | ingress | Deny agent read reach into DMs and private conversations (group-exempt). |
| [mask-pan-egress](../../apps/slack/mask-pan-egress/) | slack | egress | Luhn-validated PAN masking to BIN+last4 in Slack read/search responses. |
| [redact-profile-pii](../../apps/slack/redact-profile-pii/) | slack | egress | Redact email/phone/custom-field PII from Slack user-lookup responses. |
| [query-allowlist](../../apps/salesforce/query-allowlist/) | salesforce | ingress | Restrict the SOQL FROM object to an allowlist (Account/Contact/Opportunity). |
| [redact-pii](../../apps/salesforce/redact-pii/) | salesforce | egress | Redact contact PII fields and PAN/SSN/phone/email patterns in responses. |
| [fence-sensitive-tables](../../apps/servicenow/fence-sensitive-tables/) | servicenow | ingress | Fence sys_user / HR / CMDB tables and user-directory reads behind owner IdP groups. |
| [fence-sensitive-folders](../../apps/box/fence-sensitive-folders/) | box | ingress | Fence pinned sensitive Box folder/file IDs by IdP group (read/move/copy/search). |
| [redact-pii-egress](../../apps/box/redact-pii-egress/) | box | egress | Redact SSN/PAN/bank/email/phone PII from Box content responses (group-exempt). |
| [redact-pii](../../apps/hubspot/redact-pii/) | hubspot | egress | Redact contact PII (phone/email/SSN) in tool responses. |
| [deny-view-search-sensitive-projects](../../apps/jira/deny-view-search-sensitive-projects/) | jira | ingress | Fence configured sensitive projects out of direct views and JQL search. |
| [deny-write-sensitive-projects](../../apps/jira/deny-write-sensitive-projects/) | jira | ingress | Block writes against configured sensitive projects. |
| [redact-sensitive-info](../../apps/jira/redact-sensitive-info/) | jira | egress | Redact PII/secrets/PAN from Jira issue-view responses. |
| [fence-restricted-spaces](../../apps/confluence/fence-restricted-spaces/) | confluence | ingress | Fence restricted spaces (HR/LEGAL/SEC) out of search, listing, and lookup unless the group grants access. |
| [redact-pii-egress](../../apps/confluence/redact-pii-egress/) | confluence | egress | Redact SSN/email/US-phone PII from Confluence page/comment/search reads (group-exempt). |
| [redact-tab-values-egress](../../apps/docusign/redact-tab-values-egress/) | docusign | egress | Redact SSN and bank routing/account numbers and mask card PANs in envelope reads (group-exempt). |
| [mask-pan-egress](../../apps/zapier/mask-pan-egress/) | zapier | egress | Luhn-validated PAN masking to BIN+last4 in Zapier read responses. |
| [fence-user-directory](../../apps/notion/fence-user-directory/) | notion | ingress | Fence the member-directory tool (names/emails/IDs) to admin/IT IdP groups. |
| [redact-pii-egress](../../apps/notion/redact-pii-egress/) | notion | egress | Redact email/phone PII from Notion reads for non-HR/legal callers. |
| [redact-pii-egress-customer](../../apps/stripe/redact-pii-egress-customer/) | stripe | egress | Mask customer email/phone/address/last4 in bulk Stripe read responses (finance group-exempt). |
| [fence-sensitive-schemas](../../apps/snowflake/fence-sensitive-schemas/) | snowflake | ingress | Group-gate PII/PHI/HR/FINANCE schema references and block SELECT * on fenced schemas. |
| [redact-pii-egress](../../apps/snowflake/redact-pii-egress/) | snowflake | egress | Mask SSN/email/phone in result sets (pii-cleared group exempt). |
| [fence-hr-payroll-suiteql](../../apps/netsuite/fence-hr-payroll-suiteql/) | netsuite | ingress | Deny HR/payroll SuiteQL and saved-search reads outside the hr IdP group. |
| [redact-financial-pii](../../apps/netsuite/redact-financial-pii/) | netsuite | egress | Redact SSN/TIN/IBAN/labelled bank-account numbers in NetSuite read responses. |
| [fence-sensitive-projects](../../apps/asana/fence-sensitive-projects/) | asana | ingress | Fence writes to sensitive project GIDs (HR/legal/M&A/incident) to mapped IdP groups. |
| [redact-task-pii](../../apps/asana/redact-task-pii/) | asana | egress | Redact SSN/email/phone/IBAN in task/comment/status reads (privacy-officer exemption). |
| [fence-sensitive-boards](../../apps/monday/fence-sensitive-boards/) | monday | ingress | Fence sensitive board/workspace IDs (HR, CRM, security) across reads, writes, and search. |
| [redact-board-pii-egress](../../apps/monday/redact-board-pii-egress/) | monday | egress | Redact SSN/email/phone/national-ID on board/doc/update reads; non-admin deny of the directory tool. |
| [fence-datasource-scope](../../apps/glean/fence-datasource-scope/) | glean | ingress | Restrict which indexed datasource a Glean search may target by IdP group. |
| [redact-pii-egress](../../apps/glean/redact-pii-egress/) | glean | egress | Redact SSN/PAN/IBAN from Glean read responses before they reach agent context. |
| [fence-contact-reads](../../apps/intercom/fence-contact-reads/) | intercom | ingress | Role-gate the structured-PII contact/company read surface to support/CRM groups. |
| [mask-pan-egress](../../apps/intercom/mask-pan-egress/) | intercom | egress | Luhn-validated PAN masking to BIN+last4 in conversation responses. |
| [redact-conversation-pii](../../apps/intercom/redact-conversation-pii/) | intercom | egress | Redact SSN/national-ID/email/phone/credential shapes from conversation and contact reads. |
| [redact-pii-egress-employee](../../apps/quickbooks/redact-pii-egress-employee/) | quickbooks | egress | Mask SSN/address/pay/tax-ID/bank fields in employee/vendor reads for non-HR/finance callers. |
| [fence-scopes-org-allowlist](../../apps/github/fence-scopes-org-allowlist/) | github | ingress | Fence owner-bearing GitHub calls to a per-tenant company-org allowlist (read/write anti-exfil). |
| [redact-secrets-egress](../../apps/github/redact-secrets-egress/) | github | egress | Mask known credential shapes in GitHub read responses (file contents, code search, CI logs, diffs). |
| [fence-sensitive-paths](../../apps/dropbox/fence-sensitive-paths/) | dropbox | ingress | Fence protected path prefixes (HR/Finance/Legal/Customers) to mapped IdP team groups. |
| [redact-content-egress](../../apps/dropbox/redact-content-egress/) | dropbox | egress | Mask card PANs and redact SSN/email/phone/secrets in file-content responses (pci carve-out). |
| [fence-comp-payroll-reads](../../apps/gusto/fence-comp-payroll-reads/) | gusto | ingress | Deny compensation, pay-register, contractor-payment, and employment-action reads outside hr-payroll-admins. |
| [redact-financial-ids-egress](../../apps/gusto/redact-financial-ids-egress/) | gusto | egress | Mask US SSN and label-anchored bank-account/ABA-routing numbers in every Gusto response. |
| [fence-base-allowlist](../../apps/airtable/fence-base-allowlist/) | airtable | ingress | Confine base-scoped record/schema/page tools to an operator allowlist of sanctioned base IDs. |
| [redact-pii-egress](../../apps/airtable/redact-pii-egress/) | airtable | egress | Redact SSN/email/phone/national-ID in record-read responses (data-privileged group exempt). |
| [fence-sensitive-schemas](../../apps/databricks/fence-sensitive-schemas/) | databricks | ingress | Deny SQL/metadata access to sensitive namespaces (hr/payroll/pii/phi/comp) outside the data-privacy group. |
| [mask-pan-egress](../../apps/databricks/mask-pan-egress/) | databricks | egress | Luhn-validated PAN masking to BIN+last4 in SQL/Genie/AI-Search responses. |
| [redact-pii-egress](../../apps/databricks/redact-pii-egress/) | databricks | egress | Redact SSN/email/phone in response payloads outside the data-privacy group. |
| [fence-sensitive-datasets](../../apps/bigquery/fence-sensitive-datasets/) | bigquery | ingress | Fence regulated dataset prefixes (phi_/finance_/pii_) by IdP group across SQL and metadata. |
| [redact-pii-egress](../../apps/bigquery/redact-pii-egress/) | bigquery | egress | Redact SSN/PAN/email in query results and optionally cap result rows (group exempt). |
| [guard-transcripts-by-group](../../apps/zoom/guard-transcripts-by-group/) | zoom | ingress | Gate Zoom transcript/summary and recording-passcode retrieval by IdP group. |
| [redact-pii-meeting-intelligence](../../apps/zoom/redact-pii-meeting-intelligence/) | zoom | egress | Redact email/phone/SSN in Zoom meeting-intelligence responses (transcripts, summaries, docs). |
| [fence-datasource-scope](../../apps/tableau/fence-datasource-scope/) | tableau | ingress | Per-datasource LUID allowlist on query and analyst-only gate on image-render tools. |
| [redact-pii-query-results](../../apps/tableau/redact-pii-query-results/) | tableau | egress | Redact email/phone/SSN and mask card PANs in data-returning tool responses. |
| [redact-pii-dax-results](../../apps/power-bi/redact-pii-dax-results/) | power-bi | egress | Redact email/SSN and mask card PANs in returned DAX/query/report-metadata results (data-steward exemption). |
| [fence-roadmap-egress](../../apps/linear/fence-roadmap-egress/) | linear | egress | Fence roadmap/initiative/strategy/document read responses to product/exec IdP groups. |
| [redact-customer-pii-egress](../../apps/linear/redact-customer-pii-egress/) | linear | egress | Redact customer revenue, tier/segment, and contact email in Customers read responses. |

### 6. Processing integrity — protect records from an agent (PI1.2, PI1.5)

PI1.5 asks that stored records keep their integrity, and PI1.2 that inputs are authorized. These policies deny agent-initiated deletion, overwrite, and history tampering, cap batch mutation blast radius, and block destructive SQL — so a stray plan or an injected instruction cannot erase a record of record or its audit trail. Break-glass admin groups keep legitimate cleanup possible.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [freeze-destructive-ops](../../apps/ms365/freeze-destructive-ops/) | ms365 | ingress | Deny delete-/cancel- verb-family tools unless caller is in the admin group. |
| [freeze-destructive-ops](../../apps/gmail/freeze-destructive-ops/) | gmail | ingress | Deny permanent email/label/filter deletion; reversible archive/label ops pass. |
| [freeze-destructive-ops](../../apps/google-drive/freeze-destructive-ops/) | google-drive | ingress | Block Drive delete-class tools unless caller is in drive-admins. |
| [freeze-destructive-events](../../apps/google-calendar/freeze-destructive-events/) | google-calendar | ingress | Freeze agent-driven event deletes and series-wide recurring changes. |
| [freeze-record-deletes](../../apps/salesforce/freeze-record-deletes/) | salesforce | ingress | Deny record-delete capability (delete tools + DML delete verb) unless caller is in sf-admins. |
| [freeze-destructive-ops](../../apps/box/freeze-destructive-ops/) | box | ingress | Freeze deletes and retention tampering; unconditional block on recursive folder delete. |
| [freeze-destructive-ops](../../apps/hubspot/freeze-destructive-ops/) | hubspot | ingress | Deny archive/delete/void/purge-class tools plus contact unsubscribe (consent destruction). |
| [freeze-destructive-ops](../../apps/jira/freeze-destructive-ops/) | jira | ingress | Deny the irreversible delete/remove-link/remove-watcher ops with a break-glass admin group. |
| [deny-history-actor-spoofing](../../apps/jira/deny-history-actor-spoofing/) | jira | ingress | Deny writes carrying a historyMetadata block that would forge change-history actor metadata. |
| [freeze-page-deletion](../../apps/confluence/freeze-page-deletion/) | confluence | ingress | Freeze irreversible page/attachment deletion on the agent channel (break-glass admin group). |
| [freeze-destructive-ops](../../apps/docusign/freeze-destructive-ops/) | docusign | ingress | Deny envelope voids and Maestro workflow cancel/pause except for the contract-ops group. |
| [freeze-content-overwrite](../../apps/notion/freeze-content-overwrite/) | notion | ingress | Freeze full-body replace_content overwrites on update-page. |
| [guard-datasource-sql](../../apps/notion/guard-datasource-sql/) | notion | ingress | Block destructive/export SQL on data-source queries; read-only SELECT only. |
| [guard-warehouse-sql](../../apps/snowflake/guard-warehouse-sql/) | snowflake | ingress | Block DROP/TRUNCATE/DELETE/UPDATE/INSERT/MERGE/ALTER/GRANT and DDL (data-platform-admins exempt). |
| [cap-batch-mutation](../../apps/asana/cap-batch-mutation/) | asana | ingress | Cap blast radius of V2 batch create_tasks/update_tasks (oversize + mass-completion guard). |
| [freeze-destructive-ops](../../apps/asana/freeze-destructive-ops/) | asana | ingress | Freeze irreversible delete verbs (delete_task/section/project_status/tag) except for the admin group. |
| [freeze-destructive-ops](../../apps/monday/freeze-destructive-ops/) | monday | ingress | Block whole-board ops for all; admin-gate recoverable per-record deletes. |
| [freeze-destructive-ops](../../apps/quickbooks/freeze-destructive-ops/) | quickbooks | ingress | Deny all destructive QBO calls (delete/void/deactivate; hard deletes) on the agent channel. |
| [freeze-destructive-ops](../../apps/dropbox/freeze-destructive-ops/) | dropbox | ingress | Freeze delete, folder-rewind, and revision-restore tools on the agent channel. |
| [freeze-record-deletion](../../apps/airtable/freeze-record-deletion/) | airtable | ingress | Deny delete tools (delete_records/delete_page) for non-airtable-admins to protect record/page integrity. |
| [guard-warehouse-sql](../../apps/databricks/guard-warehouse-sql/) | databricks | ingress | Deny DML/DDL/GRANT/export/destructive SQL; read-only for non data-engineering callers. |
| [guard-warehouse-sql](../../apps/bigquery/guard-warehouse-sql/) | bigquery | ingress | Block mutating/destructive SQL (DML/DDL/GRANT/CALL/LOAD DATA/EXECUTE IMMEDIATE). |
| [freeze-destructive-content](../../apps/tableau/freeze-destructive-content/) | tableau | ingress | Admin-gated freeze of delete/extract-refresh mutation tools and their confirm- twins. |
| [guard-query-calculation](../../apps/tableau/guard-query-calculation/) | tableau | ingress | Deny arbitrary calculation expressions in VDS queries for non-analyst callers. |
| [freeze-destructive-ops](../../apps/linear/freeze-destructive-ops/) | linear | ingress | Freeze delete/archive/session-logout verbs (plus removeUserFromTeam) unless caller is in linear-admins. |

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `bundles: ["soc2"]`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth. There is intentionally no separate `bundle.json` artifact — one source of metadata avoids drift.

The policies compose by direction. The egress redaction and masking policies (most of theme 5, plus the docusign directory cap) attach to the response pipeline and are transform-only where marked, so they never deny and never collide with the ingress controls. The ingress policies are each single-purpose — a role gate, a default-deny allowlist, a human-approval gate, an export cap, a scope fence, a destructive-op freeze — so several attach to the same app on the same direction without interfering. Where an app offers both a read-only posture and narrow write controls, pick one; combining them is redundant but harmless. Because SOC 2 scope is entity-defined, treat these themes as a menu: attach the controls that match the commitments in your own system description, not every policy by default.

## What this bundle does NOT cover

These policies act only on agent traffic over MCP, and only some Trust Services Criteria reduce to a gateway decision. Out of scope by design:

- **Web-UI, native-API, and in-app access.** A user opening a record in the app's own UI, or a native integration writing to it, never passes through the gateway. Those paths stay governed by the app and your IdP — the gateway is one control among the many an auditor tests.
- **The governance criteria (CC1–CC5).** Control environment, communication, risk assessment, and the monitoring program are organizational. The gateway's audit log is an evidence *input* to CC4.1 monitoring, but the program itself is yours.
- **Credential issuance and removal (CC6.2).** Registering, authorizing, and de-provisioning users lives in the IdP (Okta/Entra) and each app. Gateway policies key on live IdP claims — so removing a user from a group cuts their agent access on the next call — but the provisioning and revocation workflows are IdP and app functions.
- **Physical access and media disposal (CC6.4, CC6.5).** No MCP-path surface; handled by the app vendor and the entity's facilities process.
- **Encryption and protection in transit (CC6.7's in-motion half).** TLS between agent, gateway, and apps is infrastructure, not policy. Encryption at rest and in transit rest with the deployment and the apps.
- **Retention and disposal (C1.2, P4.2, P4.3).** Retention schedules, purge, and destruction execute inside each app. A rule denying agent delete/purge tools prevents an agent from *violating* retention or legal hold, but it cannot execute or schedule disposal — that is adjacent support, not coverage.
- **Availability (A-series) and the incident-response process (CC7.1, CC7.4, CC7.5).** Capacity, disaster recovery, and backup have no MCP-path surface; the gateway emits deny events and telemetry, but triage, evaluation, and response are human and organizational.
- **Data residency.** SOC 2 has no residency criterion. Residency appears only if the entity writes it into its own commitments, and is enforced by app/vendor configuration, not the gateway.
- **Tenant-specific inputs and identity placeholders.** Sensitive project keys, schema names, folder and base IDs, channel lists, and domain allowlists are yours, not ours; supply them at import time. The IdP group names in these policies (for example `finance`, `hr`, `infosec`, `sf-admins`) are placeholders — map them to your directory's groups before relying on them.

---

> **Compliance note.** This bundle supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
