# Linear policies

Reusable DTwo policies for Linear MCP servers — the official Linear remote MCP server (`mcp.linear.app/mcp`) that the Claude connector uses, plus the community sidecars (`tacticlaunch/mcp-linear`, the deprecated `jerhadf/linear-mcp-server`). The official surface is read and write tools over issues, projects, initiatives, roadmaps, documents, and customer records, with **no delete or archive tools**; the tacticlaunch sidecar mirrors the full GraphQL API (~150 tools) and adds the dangerous surface — webhook creation, session logout, org/user audit reads, team-membership changes, and delete/archive verbs. Its risk profile is dominated by *disclosure and persistence*, not routine deletion: reads leak security-issue tickets, unreleased roadmaps and initiative updates (material non-public information), and customer revenue/tier data, while one `createWebhook` call opens a standing, gateway-invisible exfiltration feed and one `logoutAllSessions` call is an account-level denial of service.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Allowlist the verified official Linear tool names and deny everything else — unknown, renamed, aggregator-added, or community-server tools — fail-closed. | soc2, gdpr-ccpa |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny the delete, archive, session-logout, and membership-removal tool classes unless the caller is in the `linear-admins` IdP group. | soc2, sox |
| [guard-webhook-persistence](./guard-webhook-persistence/policy.md) | ingress | Deny every Linear webhook create/update/delete call for everyone; a standing webhook is an out-of-band exfiltration channel the gateway cannot inspect. | soc2, gdpr-ccpa |
| [fence-roadmap-egress](./fence-roadmap-egress/policy.md) | egress | Withhold roadmap, initiative, milestone, project-update, and document read responses from callers outside the `product`/`exec` IdP groups (pre-announcement/MNPI leak control). | soc2, sox |
| [redact-customer-pii-egress](./redact-customer-pii-egress/policy.md) | egress | Mask customer revenue, tier, and external contact-email fields in Customers read responses (transform-only); other fields and other tools pass through. | gdpr-ccpa, soc2 |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and Linear has **three upstream naming schemes for the same actions**: the official server uses bare snake_case (`create_issue`, `list_issues`), tacticlaunch uses a `linear_` prefix with camelCase verbs (`linear_createIssue`, `linear_getRoadmaps`), and the deprecated jerhadf server uses `linear_` with snake_case (`linear_create_issue`). The policies in this directory match on the *suffix*, case-insensitively and separator-tolerant, so a single rule covers all three spellings and stays portable across gateway server names — but always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. Note that the official server exposes no `delete_`/`archive_`/webhook/session tools, so any such call reaching the gateway is community-sidecar traffic by definition, and the official February-2026 initiative/milestone/project-update tool names are unverified upstream — re-enumerate via `tools/list` before pinning the allowlist.

## Identity claims

Some of these policies are single-purpose and require no IdP claims (`default-deny-unknown-tools`, `guard-webhook-persistence`, `redact-customer-pii-egress`). The identity-gated ones read `input.subject.claims.groups` with **placeholder** group names: `freeze-destructive-ops` exempts `linear-admins`, and `fence-roadmap-egress` exempts `product` and `exec`. Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt / not privileged).

## Contributing

To add a Linear policy:

1. Create `apps/linear/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["linear"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
