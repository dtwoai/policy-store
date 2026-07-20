# Confluence policies

Reusable DTwo policies for Confluence MCP servers — the official Atlassian Rovo MCP server that the Claude "Atlassian" connector is built on (camelCase tool names surfaced lowercased with an `atlassian-` prefix, e.g. `atlassian-getconfluencepage`), plus the mature community `sooperset/mcp-atlassian` server (snake_case, `confluence_`-prefixed). The MCP surface is read tools (page fetch, descendants, footer/inline comments, space and page listing), CQL search, and externally visible write tools (create/update page and blog, footer/inline comments, labels, attachments) — plus, on the community server only, two irreversible destructive tools (`confluence_delete_page`, `confluence_delete_attachment`). Its risk profile is dominated by *publication and visibility*, not deletion: the official server has no delete tools at all, but a page or blog set `status:"current"` in a public or anonymous-access space publishes instantly and org-wide, one `searchConfluenceUsingCql` call can trawl HR, legal, and security-incident spaces the user technically has access to (carrying PII and whatever secrets were pasted into pages), and the community server adds the only unrecoverable delete surface.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [block-secrets](./block-secrets/policy.md) | ingress | Deny Confluence page- and comment-write calls whose body looks like a live credential — API key, password, token, or PEM private key. | atlassian, soc2, pci-dss, gdpr-ccpa |
| [deny-public-publication](./deny-public-publication/policy.md) | ingress | Deny Confluence page/blog create and update calls that publish org-wide or to public / anonymous-access spaces. | atlassian |
| [fence-restricted-spaces](./fence-restricted-spaces/policy.md) | ingress | Fence agent read and search reach into restricted Confluence spaces (placeholder keys HR / LEGAL / SEC) unless the caller's IdP groups match. | atlassian, soc2, hipaa, gdpr-ccpa |
| [freeze-page-deletion](./freeze-page-deletion/policy.md) | ingress | Deny the two irreversible Confluence deletion tools (`confluence_delete_page` / `confluence_delete_attachment`) for all callers. | atlassian, soc2, sox, hipaa, gdpr-ccpa |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact PII (email, phone, SSN) from Confluence page, comment, and search read responses (transform-only); all other tools pass through. | soc2, hipaa, gdpr-ccpa, atlassian |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and the two Confluence implementations name their tools completely differently: the official server uses camelCase with the product embedded (`getConfluencePage`, `updateConfluencePage`), which the Claude connector lowercases into `atlassian-getconfluencepage`; the community server uses snake_case product prefixes (`confluence_get_page`, `confluence_update_page`). The policies in this directory match on the *suffix* case-insensitively and carry both name sets where an operation exists on both servers, so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

Most of these policies are single-purpose and require no IdP claims. The identity-gated one (`fence-restricted-spaces`) reads `input.subject.claims.groups` with **placeholder** group names (e.g. `hr`, `legal`, `security`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt).

## Contributing

To add a Confluence policy:

1. Create `apps/confluence/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["confluence"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle (e.g. [`bundles/atlassian`](../../bundles/atlassian/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
