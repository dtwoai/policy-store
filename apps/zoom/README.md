# Zoom policies

Reusable DTwo policies for Zoom's MCP servers — the official Zoom Workspace server that the Claude connector fronts, plus the product sub-servers (Team Chat, Docs, Whiteboard) and the community meeting/transcript servers. Zoom's MCP surface is dominated by **conversation intelligence**: AI Companion meeting summaries, verbatim transcripts, recordings, Team Chat history, and Zoom Docs. Its risk profile is dominated by *egress of recorded content* — transcripts and recordings are verbatim records of internal conversations that routinely carry PII, deal and financial data, HR matters, and (in healthcare tenants) PHI. Two secondary surfaces sharpen the profile: the workspace `search_zoom` tool fans agentic search out into **Salesforce, Workday, and ServiceNow**, putting HR and CRM records one call away through the Zoom connector, and Team Chat writes are immediately visible to other humans and can invite **external** parties or retroactively expose channel history.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [guard-transcripts-by-group](./guard-transcripts-by-group/policy.md) | ingress | Gate transcript, summary, and recording retrieval (and passcode-protected recordings) behind an IdP transcript-reader group; fail closed when the group claim is absent. | hipaa, gdpr-ccpa, soc2 |
| [fence-agentic-search](./fence-agentic-search/policy.md) | ingress | Rewrite `search_zoom`'s `search_entities` to an allowlist of Zoom-native corpora (transform-only), stripping `salesforce` / `workday` / `servicenow` so the agent can't reach HR/CRM records through Zoom. | soc2, hipaa, gdpr-ccpa |
| [guard-external-chat-invites](./guard-external-chat-invites/policy.md) | ingress | Deny Team Chat contact-add outright, and deny channel member-add / update / create calls that invite any address outside the corporate domain(s). | soc2, gdpr-ccpa |
| [block-secrets-chat](./block-secrets-chat/policy.md) | ingress | Deny Team Chat send/update calls whose `message_content` looks like a live secret — API key, password, bearer token, or private key. | soc2, pci-dss, gdpr-ccpa |
| [redact-pii-meeting-intelligence](./redact-pii-meeting-intelligence/policy.md) | egress | Redact emails, phone numbers, and SSNs from meeting-intelligence responses (transcripts, AI summaries, next-steps, Zoom Docs) before they reach the agent (transform-only). | hipaa, gdpr-ccpa, soc2 |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Zoom Workspace server registered as `zoom` will surface tools like `zoom-get-recording-resource`, while a Team Chat sub-server registered as `zoom-chat` will surface `zoom-chat-zoom-chat-message-send`. The policies in this directory match on the *suffix* (`get_recording_resource`, `zoom_chat_message_send`, `search_zoom`, etc.) so they stay portable across naming conventions and across Zoom's own naming divergence — the same write action is `create_new_file_with_markdown` on the workspace server but `create_file_with_content` on the Docs sub-server, and community servers use generic verbs (`get_meetings`, `create_meeting`) that can collide with calendar servers. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying, and scope suffix matching to the Zoom server prefix where a generic name could collide.

## Identity claims

Most of these policies are single-purpose and require no IdP claims. The identity-gated one — `guard-transcripts-by-group` — reads `input.subject.claims.groups` with **placeholder** group names (`zoom-transcript-readers`, `zoom-admins`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → denied), so if your IdP does not populate `groups`, every caller is denied until the claim is wired up. The domain allowlists in `guard-external-chat-invites` (`example.com`, `example.org`) are likewise placeholders — replace them with your corporate domain(s).

## Unverified tool names

Per the Zoom MCP landscape research, the **Meetings / Tasks / Revenue Accelerator** sub-server tool names and the Team Chat endpoint prefix (`/mcp/team_chat/` vs `/mcp/chat/`) could not be verified from public docs. The `zoom_chat_*` verbs and the workspace `get_recording_resource` / `get_meeting_assets` / `search_zoom` / `get_file_content` names are verified from Zoom's own Claude Code skill. Where a policy relies on an inferred name or argument key, it says so in its **Known limitations** section — confirm with the dump-input technique before relying on it.

## Contributing

To add a Zoom policy:

1. Create `apps/zoom/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["zoom"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits an industry or bundle (e.g. [`bundles/im-messaging`](../../bundles/im-messaging/README.md) for the Team Chat policies), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
