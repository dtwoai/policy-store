# Notion policies

Reusable DTwo policies for Notion MCP servers — principally Notion's **hosted** MCP server (`https://mcp.notion.com/mcp`), the official implementation that backs the Claude connector, plus the official local server and community servers where their tool names line up. The MCP surface is read tools (`notion-search`, `notion-fetch`, `notion-query-data-sources` running raw SQL, `notion-get-users`, `notion-get-teams`, `notion-get-comments`, meeting-notes queries) and write tools (create/update/move/duplicate pages, create/update databases, data sources, and views, and comments). Its risk profile is dominated by *aggregation and silent irreversibility*, not deletion: there is no explicit delete or trash tool, but `notion-search` reaches into connected Slack, Google Drive, and Jira content (bypassing those apps' own MCP governance), `notion-get-users` returns workspace member and guest emails, `notion-query-data-sources` runs SQL over databases that hold HR, finance, and CRM records, and `notion-update-page` with `command: replace_content` overwrites a page's entire body in one call — recoverable only through page history and invisible to the agent.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [constrain-connected-search](./constrain-connected-search/policy.md) | ingress | Deny `notion-search` calls scoped to connected external tools (Slack, Google Drive, Jira); native Notion searches and all other tools pass through. | soc2, gdpr-ccpa, hipaa |
| [fence-user-directory](./fence-user-directory/policy.md) | ingress | Deny member-directory reads (`notion-get-users`) unless the caller's IdP groups include an admin or IT group. | soc2, hipaa, gdpr-ccpa |
| [freeze-content-overwrite](./freeze-content-overwrite/policy.md) | ingress | Deny `notion-update-page` calls with `command: replace_content` (silent full-page overwrite); additive edits and property updates pass through. | sox, soc2, hipaa, gdpr-ccpa |
| [guard-datasource-sql](./guard-datasource-sql/policy.md) | ingress | Deny destructive, schema, or export SQL on Notion data-source queries; read-only `SELECT`s pass through. | pci-dss, sox, gdpr-ccpa, soc2 |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact emails, phone numbers, and other PII from Notion content-returning read responses (transform-only). | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. The hosted server bakes a `notion-` hyphenated prefix into every tool name, so a server registered as `notion` surfaces tools like `notion.notion-search`, `notion.notion-update-page`, and `notion.notion-get-users`. The policies in this directory match on the *suffix* (`-search`, `-update-page`, `-get-users`, `-query-data-sources`, etc.) so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

Portability caveat: the official local server (`makenotion/notion-mcp-server`) uses un-prefixed REST-ish names (`search`, `query-data-source`), and the community servers diverge further — `suekou/mcp-notion-server` uses a `notion_` underscore prefix, and `awkoy/notion-mcp-server` funnels every action through a `notion_execute` meta-tool that tool-name matching cannot fence. Where a policy covers a non-hosted server it says so; residual pass-throughs on those servers are recorded in each policy's Known limitations.

## Identity claims

Most of these policies are single-purpose and require no IdP claims. The identity-gated ones read `input.subject.claims.groups` with **placeholder** group names: `fence-user-directory` grants the member directory to `admin` and `it`, and `redact-pii-egress` exempts `hr` and `legal` from redaction. Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt / not cleared).

## Contributing

To add a Notion policy:

1. Create `apps/notion/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["notion"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
