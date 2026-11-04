# Engineering Stack: Linear bundle

For software engineering, SRE, and platform teams who work in GitHub, track work in Linear, and run observability on Datadog and Splunk, and want to give engineers an AI assistant over MCP. The goal: let the agent read code, logs, and tickets, open PRs and issues, and write up what it finds, while keeping secrets out of commits and out of its context, and keeping merges, CI changes, and destructive operations with people.

These policies act on agent traffic that flows through the gateway. Web-UI logins, native integrations, and in-app permissions are outside their reach by design.

## What this bundle covers

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [block-secrets-commits](../../apps/github/block-secrets-commits/policy.md) | github | ingress | Blocks commits, PRs, issues, comments, and gists that contain a live credential. |
| [redact-secrets-egress](../../apps/github/redact-secrets-egress/policy.md) | github | egress | Masks credentials in file contents, code search, CI logs, commits, and PR diffs before the agent sees them. |
| [require-human-approval-merge](../../apps/github/require-human-approval-merge/policy.md) | github | ingress | Agents can't merge or approve pull requests. |
| [protect-default-branch](../../apps/github/protect-default-branch/policy.md) | github | ingress | Agents can't commit straight to `main` / `master`; changes go through a pull request. |
| [block-workflow-edits](../../apps/github/block-workflow-edits/policy.md) | github | ingress | Agents can't create, change, or delete GitHub Actions workflows or local actions, which run with your repo's secrets. |
| [deny-public-exposure-repos](../../apps/github/deny-public-exposure-repos/policy.md) | github | ingress | New repos stay private; no public gists or forks of org code into personal accounts. |
| [redact-secrets-writes](../../apps/linear/redact-secrets-writes/policy.md) | linear | ingress | Masks credentials in everything the agent writes to Linear: issue titles and descriptions, comments, and projects. |
| [redact-secrets-egress](../../apps/linear/redact-secrets-egress/policy.md) | linear | egress | Masks credentials already sitting in issues when the agent reads them. |
| [read-only-except-notebooks](../../apps/datadog/read-only-except-notebooks/policy.md) | datadog | ingress | Datadog is read-only for the agent, except it can create and edit notebooks. |
| [cap-search-window](../../apps/datadog/cap-search-window/policy.md) | datadog | ingress | Datadog searches look back at most 7 days. Transform-only. |
| [redact-secrets-egress](../../apps/datadog/redact-secrets-egress/policy.md) | datadog | egress | Masks credentials and email addresses in Datadog responses. |
| [block-write-commands](../../apps/splunk/block-write-commands/policy.md) | splunk | ingress | Splunk searches can't use commands that delete, write, or send data (`delete`, `collect`, `outputlookup`, `sendemail`, …). |
| [cap-search](../../apps/splunk/cap-search/policy.md) | splunk | ingress | Every Splunk search gets a time range: 24 hours when none is given, never more than 7 days. Transform-only. |
| [redact-secrets-egress](../../apps/splunk/redact-secrets-egress/policy.md) | splunk | egress | Masks credentials and email addresses in Splunk responses. |

Policy bodies live under [`apps/`](../../apps/); this page only links to them.

## How bundle membership works

Bundle membership is declared in each policy's `policy.md` frontmatter (the policy lists `engineering-stack-linear` among its `bundles`). This page is a human-readable landing page; the generated `manifest.json` is the machine-readable source of truth.

## What's intentionally not in the bundle

- **Jira.** Teams that track work in Jira should use [Engineering Stack: Jira](../engineering-stack-jira/README.md) instead; the GitHub, Datadog, and Splunk policies are the same.
- **Other Linear policies.** The other Linear policies in the catalog target the community `mcp-linear` server ([`freeze-destructive-ops`](../../apps/linear/freeze-destructive-ops/policy.md), [`guard-webhook-persistence`](../../apps/linear/guard-webhook-persistence/policy.md)) or rely on tool names not yet verified on Linear's hosted server ([`redact-customer-pii-egress`](../../apps/linear/redact-customer-pii-egress/policy.md), [`fence-roadmap-egress`](../../apps/linear/fence-roadmap-egress/policy.md)), so they're not in this bundle.
- **Identity-gated writes.** [`github/role-gate-writes-engineering`](../../apps/github/role-gate-writes-engineering/policy.md) needs an IdP group name configured, so it's left out of this starter set.
- **Tenant-specific scoping.** The server name prefixes (`github`, `datadog`, `splunk`, and so on) are defaults — change them if your gateway registers a server under a different name.

## Notes

- **Datadog write access.** Datadog ships MCP Write Access switched off. `read-only-except-notebooks` is what lets you turn it on for notebooks without also handing over dashboards and monitors.
- **Experimental policies.** The Linear redaction policies, the Datadog and Splunk policies, and the two new GitHub policies (`protect-default-branch`, `block-workflow-edits`) are marked experimental: they compile and pass their tests, but confirm them against your own instance of each app before relying on them.

---

> **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
