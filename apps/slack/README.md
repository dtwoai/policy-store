# Slack policies

Reusable DTwo policies for Slack MCP servers — the official Slack (Salesforce) remote MCP server that the Claude connector uses, plus compatible community and legacy implementations (`korotovsky/slack-mcp-server`, the archived Anthropic reference server). The MCP surface is read tools (channel/thread/canvas history, message and user search, profile lookups) and externally visible write tools (send/schedule messages, canvas create/update, group management). Its risk profile is dominated by *visibility*, not deletion: there are no destructive delete tools, but a sent or scheduled message is effectively irreversible, DMs and private channels concentrate the workspace's PII/PHI, and Slack Connect shared channels put the agent one call away from external exfiltration.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [block-secrets](./block-secrets/policy.md) | ingress | Deny send-message calls whose body looks like an API key, password, token, or private key. | soc2, pci-dss, gdpr-ccpa |
| [redact-sensitive-info](./redact-sensitive-info/policy.md) | ingress | Redact secrets and PII from outgoing message content to `[REDACTED]` (transform-only); all other Slack tools pass through. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Gate every write-class Slack tool (send/schedule/canvas/usergroups) behind an IdP writers group; read-only by default. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [guard-external-send](./guard-external-send/policy.md) | ingress | Deny message-write calls whose destination is an externally shared Slack Connect channel. | soc2, gdpr-ccpa, hipaa |
| [guard-dm-privacy](./guard-dm-privacy/policy.md) | ingress | Deny agent read and search reach into Slack DMs and private conversations. | — |
| [deny-direct-messages](./deny-direct-messages/policy.md) | ingress | Deny message-write calls addressed to a direct conversation (1:1 DM, user ID, or group DM). | soc2, gdpr-ccpa |
| [deny-channel-creation](./deny-channel-creation/policy.md) | ingress | Deny Slack channel-creation tool calls; all other Slack tools pass through. | soc2, gdpr-ccpa |
| [deny-read-search-summarize-sensitive-channels](./deny-read-search-summarize-sensitive-channels/policy.md) | ingress | Deny read, search, and summarize operations targeting sensitive channels (matched by channel ID). | soc2, hipaa, pci-dss, gdpr-ccpa |
| [mask-pan-egress](./mask-pan-egress/policy.md) | egress | Mask payment-card numbers (PANs) in message-read, thread-read, canvas-read, history, and search responses. | pci-dss, soc2, gdpr-ccpa |
| [redact-profile-pii](./redact-profile-pii/policy.md) | egress | Redact email, phone, and Slack custom profile fields from user-profile and user-search responses. | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Slack MCP server registered as `slack-mcp` will surface tools like `slack-mcp-slack-post-message`, while one registered as `slack` will surface `slack-slack-post-message`. The policies in this directory match on the *suffix* (`slack-post-message`, `slack-send-message`, etc.) so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

Most of these policies are single-purpose and require no IdP claims. The identity-gated ones (`role-gate-writes`, `guard-dm-privacy`, `redact-profile-pii`, and the exemption branches of `guard-external-send` and `mask-pan-egress`) read `input.subject.claims.groups` with **placeholder** group names (e.g. `slack-writers`, `slack-private-ok`, `people-ops`, `finance`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not exempt).

## Contributing

To add a Slack policy:

1. Create `apps/slack/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["slack"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/slack`](../../bundles/slack/README.md) or [`bundles/im-messaging`](../../bundles/im-messaging/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
