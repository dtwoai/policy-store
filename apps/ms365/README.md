# Microsoft 365 policies

Reusable DTwo policies for Microsoft 365 MCP servers, targeting the softeria `ms-365-mcp-server` tool vocabulary (the de-facto full-capability community server, ~200+ Graph-derived tools covering Outlook mail, Calendar, Teams, SharePoint/OneDrive, Excel, and directory operations). Because a single suite connector spans email, files, chat, spreadsheets, and the Entra directory — plus a raw Graph passthrough (`graph-batch`) that can reach any endpoint the token allows — its blast radius is the largest of any app in this catalog: one compromised or prompt-injected agent session can exfiltrate mail, mint anonymous share links, plant BEC persistence rules, and mutate group membership through one connection.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [deny-graph-batch](./deny-graph-batch/policy.md) | ingress | Deny the raw `graph-batch` Graph passthrough — the escape hatch that bypasses every per-tool policy — for everyone outside the `m365-admin` group. | — |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny every `delete-*` / `cancel-*` tool call (mail, files, groups, calendar, lists) unless the caller is in the `m365-admin` group. | `sox`, `soc2`, `hipaa`, `gdpr-ccpa` |
| [freeze-identity-plane](./freeze-identity-plane/policy.md) | ingress | Deny group/team membership, ownership, and directory mutations for everyone outside the `iam-admins` group; identity reads fail closed. | — |
| [guard-external-send](./guard-external-send/policy.md) | ingress | Deny send-class mail tools (send, reply, forward, drafts, shared mailbox) when any visible recipient is outside the corporate-domain allowlist; `external-comms` group exempt. | `soc2`, `hipaa`, `gdpr-ccpa` |
| [guard-mailbox-persistence](./guard-mailbox-persistence/policy.md) | ingress | Unconditionally deny the BEC persistence surface: mail-rule creation/update, mailbox-settings changes, and Graph change-notification subscriptions (webhooks). No exemptions. | — |
| [guard-share-links](./guard-share-links/policy.md) | ingress | Downgrade anonymous share links to organization scope, inject a 7-day expiry when missing, deny anonymous *edit* links outright, and deny sharing invitations to external recipients (`collab-admins` exempt). | `soc2` |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact PII (SSN, payment card, IBAN, phone, and more) from mail bodies, Excel ranges, SharePoint list items, meeting transcripts, and Teams messages before the response reaches the agent (transform-only). | `soc2`, `hipaa`, `gdpr-ccpa` |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Read-only baseline: reads pass for everyone; anything not recognizably a read (sends, creates, updates, deletes, unknown verbs) is denied unless the caller is in the `m365-writers` group. | `soc2`, `hipaa`, `pci-dss`, `gdpr-ccpa`, `sox` |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Microsoft 365 server registered as `ms365` surfaces tools like `ms365-send-mail` and `ms365-graph-batch`, while a different registration name changes the prefix. The policies in this directory match on the *suffix* (`-send-mail`, `-create-mail-rule`, `-graph-batch`, etc.) so they stay portable across naming conventions — but you should always confirm the exact tool names your gateway sends using the dump-input debug technique before deploying. Note that name-based matching does not cover the `merill/lokka` server, whose single generic Graph tool carries the endpoint in its *arguments*; see each policy's Known limitations.

## Identity claims

The group-gated policies read `input.subject.claims.groups` (an IdP-asserted array) and fail closed when claims are missing. The group names — `m365-admin`, `m365-writers`, `iam-admins`, `external-comms`, `collab-admins` — are placeholders: replace them with your IdP's group names at import time.

## Compliance

> **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.

## Contributing

To add a Microsoft 365 policy:

1. Create `apps/ms365/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["ms365"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle (e.g. `bundles/soc2` or `bundles/hipaa`), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
