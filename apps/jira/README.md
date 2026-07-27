# Jira policies

Reusable DTwo policies for Jira MCP servers — the official Atlassian Rovo MCP server that the Claude connector uses (camelCase tools like `getJiraIssue` / `editJiraIssue`, surfaced lowercased with an `atlassian-` prefix), plus the dominant community implementation (`sooperset/mcp-atlassian`, snake_case `jira_*` tools). The MCP surface is issue reads and JQL search, write tools (create/edit/transition issues, comments, worklogs, issue links), JSM service-desk operations, and — on the community server only — destructive tools (`jira_delete_issue`, `jira_remove_issue_link`, `jira_remove_watcher`); the official server ships no delete tools at all. The risk profile is concentrated in *reach* and *integrity*: JQL search can bulk-read the PII, credentials, and incident detail that accumulate in tickets, writes are externally visible and hard to unwind (JSM comments can land on a customer portal), and the official write schema accepts a `historyMetadata` block that can forge changelog actors — so the audit trail itself is part of the attack surface.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Gate every Jira write-class tool (create/edit/transition/comment/worklog/link) behind an IdP writers group; read-only by default. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny the community server's irreversible operations (`jira_delete_issue`, `jira_remove_issue_link`, `jira_remove_watcher`), with a break-glass admins group. | soc2, hipaa, gdpr-ccpa, sox |
| [deny-write-sensitive-projects](./deny-write-sensitive-projects/policy.md) | ingress | Deny write operations (edit/transition/comment/create/link, etc.) on issues in a configurable set of sensitive projects. | soc2, hipaa, gdpr-ccpa, sox |
| [deny-view-search-sensitive-projects](./deny-view-search-sensitive-projects/policy.md) | ingress | Deny direct issue views and explicit JQL searches of sensitive projects; silently filter generic searches to exclude them. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [deny-history-actor-spoofing](./deny-history-actor-spoofing/policy.md) | ingress | Deny official Jira write calls that smuggle a `historyMetadata` block (at any nesting depth) to forge changelog actors or timestamps. | soc2, sox, gdpr-ccpa, hipaa |
| [force-internal-jsm-comments](./force-internal-jsm-comments/policy.md) | ingress | Rewrite `addCommentToJiraIssue` calls to carry internal-only visibility, keeping agent-drafted JSM comments off the customer portal (transform-only). | soc2, gdpr-ccpa |
| [cap-read-field-exposure](./cap-read-field-exposure/policy.md) | ingress | Cap field selection and page size on issue reads and JQL searches — strips wildcard field tokens (`*all`, `*navigable`) and clamps result counts (transform-only). | soc2, hipaa, gdpr-ccpa |
| [redact-sensitive-info](./redact-sensitive-info/policy.md) | egress | Redact PII, credentials, and secrets from Jira issue-view responses (issues, JQL search, comments, worklogs, remote links); transform-only, never denies. | soc2, hipaa, pci-dss, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Jira MCP server registered as `atlassian-jira-mcp` will surface tools like `atlassian-jira-mcp-getjiraissue`, while one registered as `atlassian` will surface `atlassian-getjiraissue`; the community server surfaces names like `mcp-atlassian-jira_delete_issue`. The policies in this directory match on the *suffix* (`getjiraissue`, `searchjiraissuesusingjql`, `jira_delete_issue`, etc.), case-insensitively, so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

Several policies are single-purpose and require no IdP claims. The identity-gated ones — `role-gate-writes`, `freeze-destructive-ops`, `cap-read-field-exposure`, and `force-internal-jsm-comments` — read `input.subject.claims.groups` with **placeholder** group names (`jira-writers`, `jira-admins`, `jira-power-users`, `support-agents`). Replace these with your own IdP group names at import time. Missing or malformed claims fail closed for grants (no group → not exempt).

## Contributing

To add a Jira policy:

1. Create `apps/jira/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["jira"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/atlassian`](../../bundles/atlassian/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
