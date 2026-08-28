# Gmail policies

Reusable DTwo policies for Gmail MCP servers. The Gmail MCP surface spans three common implementations — the official Google remote server behind Anthropic's Claude Gmail connector (draft-only, no send/delete/filter tools by design), the archived-but-widely-deployed GongRzhe community server, and the actively maintained taylorwilsdon Workspace server — which between them expose read, draft, send, label, filter, and permanent-delete tools under divergent naming vocabularies. That divergence is the risk profile: a tenant migrating from the Claude connector to a community server silently gains external send, permanent delete, local-file attachment exfiltration, and auto-forward filter persistence, so these policies deny-by-default and match on tool-name suffix across all three vocabularies.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| --- | --- | --- | --- |
| [cap-bulk-export](./cap-bulk-export/policy.md) | ingress | Deny batch content reads above the ID-array cap and clamp search `maxResults`, throttling mass mailbox harvesting. | soc2, hipaa, gdpr-ccpa |
| [filter-blocked-senders](./filter-blocked-senders/policy.md) | egress | Strip messages from listed senders or domains out of mailbox reads; a thread left with nothing is dropped (transform-only). | — |
| [filter-dormant-threads](./filter-dormant-threads/policy.md) | egress | Empty direct thread/message reads of conversations with no recent activity; one recent message keeps the whole thread (transform-only). | — |
| [filter-labeled-threads](./filter-labeled-threads/policy.md) | egress | Withhold whole threads carrying a restricted Gmail label — a one-click manual override for sensitive conversations (transform-only). | — |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny permanent email, label, and filter deletion for every caller; reversible label/archive operations pass through. | soc2, hipaa, gdpr-ccpa, sox |
| [guard-external-send](./guard-external-send/policy.md) | ingress | Deny send-class calls when any `to`/`cc`/`bcc` recipient falls outside the corporate-domain allowlist; the agent is told to draft instead. | soc2, hipaa, gdpr-ccpa, sox |
| [guard-mailbox-persistence](./guard-mailbox-persistence/policy.md) | ingress | Block Gmail filter creation, the classic auto-forward / auto-delete exfiltration-persistence primitive. | — |
| [mask-pan-egress](./mask-pan-egress/policy.md) | egress | Mask payment-card-number shapes in email content returned to agents by mailbox-read tools (transform-only). | pci-dss, gdpr-ccpa |
| [recent-search-only](./recent-search-only/policy.md) | ingress | Rewrite thread searches to prepend a `newer_than:` recency term, so Gmail itself returns only recent correspondence (transform-only). | — |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Make Gmail read-only by default: verified read tools pass for everyone, every write/send/label/filter/delete tool is denied. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and the three Gmail servers use unrelated naming conventions — Google/Claude uses bare thread-centric names (`search_threads`, `get_thread`), GongRzhe uses bare message-centric names (`send_email`, `read_email`), and taylorwilsdon uses a `*_gmail_*` infix (`send_gmail_message`). The policies in this directory match on the *suffix* (`send_email`, `send_gmail_message`, `delete_email`, `create_filter`, etc.) and deliberately cover all three vocabularies so they stay portable across servers and gateway prefixes. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying, especially if your server uses camelCase or renamed tools that the snake_case suffix matchers will not catch.

## Identity claims

Most policies here require no IdP claims. [role-gate-writes](./role-gate-writes/policy.md) is group-gated: write access is granted via `input.subject.claims.groups`, and the group names in the policy are placeholders — replace them with your IdP's group names at import time. Missing or malformed claims fail closed (no group → no write access). The remaining policies apply to every caller by design (a mailbox record must survive agent error and prompt injection regardless of who is driving the agent).

## Contributing

To add a Gmail policy:

1. Create `apps/gmail/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["gmail"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle (e.g. `soc2`, `hipaa`, `pci-dss`, `gdpr-ccpa`, `sox`), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
