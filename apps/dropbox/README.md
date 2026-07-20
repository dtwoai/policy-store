# Dropbox policies

Reusable DTwo policies for Dropbox MCP servers — the official Dropbox remote server (`mcp.dropbox.com/mcp`) that backs the Claude connector directory entry, plus the referenced community implementations (`amgadabdelhafez/dbx-mcp-server`, `ngs/dropbox-mcp-server`). The MCP surface is read tools (folder listing, file metadata and content extraction, search, shared-link and file-request enumeration, revision history), write tools (create/copy/move/restore folders and files), and — the sharp end — externally visible writes (`CreateSharedLink` public links with up to 25 email invitees, `DownloadLink` single-use public URLs, `CreateFileRequest` external upload endpoints) plus destructive ops (`Delete`, folder rewind). Its risk profile is dominated by *content egress and public exposure*: Dropbox is a generic bucket, so PII, PHI, financials, and contracts are one `path` away, and a single share-link or file-request call turns an internal file into an internet-visible resource that is effectively irreversible once fetched.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [role-gate-writes](./role-gate-writes/policy.md) | ingress | Gate every write-class Dropbox tool (create/copy/move/restore) behind an IdP writers group; read-only by default. | soc2, pci-dss, hipaa, sox, gdpr-ccpa |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny the irreversible and bulk-mutation tools — delete, folder rewind (`RestoreFolder`), and revision restore — across all three dialects; `Move` and other writes pass. | soc2, sox, hipaa, gdpr-ccpa |
| [fence-sensitive-paths](./fence-sensitive-paths/policy.md) | ingress | Fence sensitive Dropbox path prefixes (`/finance`, `/hr`, `/legal`, `/customers`) behind IdP groups for reads, listings, moves, copies, and search; unscoped search is reserved for callers holding every fenced group. | soc2, hipaa, gdpr-ccpa |
| [guard-share-links-external](./guard-share-links-external/policy.md) | ingress | Deny public/anonymous shared links, non-corporate-domain invitees, and the external upload/download URL minters (`DownloadLink`, `CreateFileRequest`); non-public shared links with corporate invitees pass. | soc2 |
| [redact-content-egress](./redact-content-egress/policy.md) | egress | Redact PII, Luhn-validated PANs (masked to BIN + last-four), SSNs, emails, phones, and secret-shaped strings from file-content read responses (transform-only). | soc2, pci-dss, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and Dropbox implementations diverge sharply in their own naming: the official remote server uses PascalCase with no separator (`CreateSharedLink`, `GetFileContent`), while community servers use snake_case either bare (`get_sharing_link`, `get_file_content`) or `dropbox_`-prefixed (`dropbox_create_shared_link`, `dropbox_download`). The policies in this directory match on the *suffix* case-insensitively and carry all three dialects, so they stay portable across server naming — but Dropbox publishes no MCP JSON schemas, so you should always confirm the exact tool names *and argument keys* your gateway sends with the dump-input debug technique (capture a live `tools/list`) before deploying.

## Identity claims

Three of these policies read `input.subject.claims.groups` with **placeholder** group names — `dropbox-writers` (the write floor in `role-gate-writes`), `dropbox-sharing` (the break-glass exemption in `guard-share-links-external`), and `finance` / `hr` / `legal` / `customers` (the path-fence groups in `fence-sensitive-paths`). `freeze-destructive-ops` and `redact-content-egress` are single-purpose and require no claims. Replace the placeholder group names with your own IdP group names at import time, and replace the placeholder domain allowlist (`example.com`) and path prefixes (`/finance`, `/hr`, `/legal`, `/customers`) with your real corporate domains and Dropbox paths. Missing, empty, or non-array `groups` claims fail closed: no group means no write, no exemption, and no access to a fenced target.

## Contributing

To add a Dropbox policy:

1. Create `apps/dropbox/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["dropbox"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
