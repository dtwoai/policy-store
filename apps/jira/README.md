# JIRA policies

Reusable DTwo policies for Atlassian JIRA MCP servers (the Atlassian-hosted JIRA MCP server and compatible implementations).

## Available policies

| Policy                                                       | Direction | Purpose                                                                                              |
| ------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------- |
| [redact-sensitive-info](./redact-sensitive-info/policy.md)   | egress    | Redact PII, credentials, and secrets from JIRA issue-view responses (issues, JQL search, comments, worklogs, remote links). Transform-only — never denies. |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A JIRA MCP server registered as `atlassian-jira-mcp` will surface tools like `atlassian-jira-mcp-getjiraissue`, while one registered as `atlassian` will surface `atlassian-getjiraissue`. The policies in this directory match on the *suffix* (`-getjiraissue`, `-searchjiraissuesusingjql`, etc.) so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

These policies do not require any specific IdP claims. If you want identity-based exemptions (e.g., a break-glass role that can read unredacted content), gate the relevant rule with `object.get(input.subject.claims, "<claim>", "<default>")`.

## Contributing

To add a JIRA policy:

1. Create `apps/jira/<policy-slug>/` with `policy.md` and optional `tests/` sample inputs.
2. Add a row to the table above.
3. Declare `apps: ["jira"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/atlassian`](../../bundles/atlassian/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
