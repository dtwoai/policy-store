# Box policies

Reusable DTwo policies for Box MCP servers — the official hosted Box MCP server at `https://mcp.box.com` (the implementation behind the Claude connector for Box), plus the widely installed community server `box-community/mcp-server-box` and the minimal legacy `hmk/box-mcp-server`. The MCP surface spans content-read tools (file content, download URLs, previews, AI Q&A and extraction, folder listings, keyword/metadata search), state-mutating writes (upload, copy, move, folder and metadata creation, hub and docgen writes), and an externally-visible sharing surface (collaboration grants and shared links). Its risk profile is dominated by *exfiltration and irreversibility*: Box is a system of record for regulated documents (PHI, financials, contracts), an `open` shared link mints an anonymous URL the moment it is created, an external collaboration grants persistent outside access, and the community server adds destructive delete/retention tools with no per-user permission checks when run as a service account.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [guard-share-links-external](./guard-share-links-external/policy.md) | ingress | Deny external collaboration grants (login domain outside the corporate allowlist) and public shared links (`access: open`); id/group/role-only grants and non-string `access` fail closed. | soc2 |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Make Box read-only by default — gate every mutating tool (and unknown write-verb tools) behind an IdP writers group; reads and search pass for everyone. | soc2, hipaa, pci-dss, gdpr-ccpa, sox |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny deletes, collaboration/shared-link removal, and retention-date clears on the community server; recursive folder delete is denied for everyone, non-recursive deletes are exempt only for an IdP admin group. | sox, soc2, hipaa, gdpr-ccpa |
| [fence-sensitive-folders](./fence-sensitive-folders/policy.md) | ingress | Fence pinned sensitive folder/file IDs (HR, Finance, Legal) so reads, moves, copies, listings, and scoped search only reach callers in the mapped IdP group. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [redact-pii-egress](./redact-pii-egress/policy.md) | egress | Redact SSNs, Luhn-valid payment cards, paired bank routing/account numbers, and paired email/phone from Box content-tool responses (transform-only). | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and Box has two naming dialects. The official remote server uses bare `verb_noun` snake_case (`upload_file`, `create_collaboration`, `add_file_shared_link`); the community server uses a `box_<domain>_<action>_tool` shape (`box_file_delete_tool`, `box_folder_delete_tool`, `box_shared_link_file_create_or_update_tool`). A server registered as `box` surfaces tools like `box-upload_file` or `box-box_file_delete_tool`. The policies in this directory match on the *suffix* across both dialects so they stay portable — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. Capability divergence matters: deletes, locks, and retention exist **only** on the community server, while hub/docgen and enhanced AI extraction exist **only** on the official one.

## Identity claims

The identity-gated policies (`role-gate-writes`, `freeze-destructive-ops`, `fence-sensitive-folders`, and the exemption branch of `guard-share-links-external`) read `input.subject.claims.groups` with **placeholder** group names (e.g. `box-writers`, `box-admins`, `infosec`, `finance`). Replace these with your own IdP group names at import time. Missing or non-array claims fail closed for grants (no group → not exempt, non-array shape → not a member). `redact-pii-egress` is transform-only and requires no claims.

## Contributing

To add a Box policy:

1. Create `apps/box/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["box"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
