# Google Drive policies

Reusable DTwo policies for Google Drive MCP servers (Google's official Drive MCP server, the Anthropic-hosted Claude "Google Drive" connector, and compatible community forks such as `isaacphi/mcp-gdrive` and `piotr-agier/google-drive-mcp`). The MCP surface spans read tools (search, list, metadata, permissions, content reads, downloads), write tools (create/upload files, doc/sheet edits, moves, renames, copies, comments), and — in the broadest community fork only — destructive tools (`deleteItem`, `deleteSheet`, `deleteRange`, `deleteGoogleSlide`, `deleteCalendarEvent`). **Risk profile:** Drive is a de-facto dumping ground for PII, PHI, payroll, contracts, and board decks, so the dominant risks are bulk read/exfiltration and search-driven recon; MCP responses bypass classic DLP entirely, and destructive writes on the community server are hard to undo past version history.

## Available policies

| Policy                                                                     | Direction | Purpose                                                                                                         | Framework bundles                          |
| -------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [cap-bulk-export](./cap-bulk-export/policy.md)                             | ingress   | Clamp the page size of Drive search and listing calls to 25 results (transform-only) to slow bulk enumeration. | soc2, hipaa, gdpr-ccpa                     |
| [exclude-personal-drives](./exclude-personal-drives/policy.md)             | egress    | Withhold files living in personal Drives from search/list/metadata responses; shared-drive material passes (transform + deny on metadata lookups). | —                                          |
| [fence-restricted-folders](./fence-restricted-folders/policy.md)           | ingress   | Fence an admin-maintained denylist of restricted file/folder IDs off the agent channel for both reads and writes. | soc2, hipaa, gdpr-ccpa, sox             |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md)               | ingress   | Deny destructive Drive tool calls (delete file/folder/sheet/range/slide) unless the caller is in the admin group. | soc2, hipaa, gdpr-ccpa, sox             |
| [guard-acl-recon](./guard-acl-recon/policy.md)                             | ingress   | Deny `get_file_permissions` ACL-reconnaissance calls unless the caller's IdP `groups` claim contains `infosec`. | soc2                                       |
| [redact-pii-egress](./redact-pii-egress/policy.md)                         | egress    | Redact PII from Drive file-content responses to fixed tokens before they reach the agent (transform-only).      | soc2, hipaa, gdpr-ccpa                     |
| [role-gate-writes](./role-gate-writes/policy.md)                           | ingress   | Gate every write-class Drive tool behind an authorized IdP group; read-class tools pass through freely.          | soc2, hipaa, pci-dss, gdpr-ccpa, sox      |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and the Google Drive ecosystem has **no shared naming convention**: Google uses `snake_case` verbs (`search_files`, `read_file_content`), `isaacphi/mcp-gdrive` prefixes by product (`gdrive_*`, `gsheets_*`), `piotr-agier/google-drive-mcp` uses bare camelCase (`deleteItem`, `uploadFile`), and the legacy Claude integration used `google_drive_*`. The policies in this directory match on the *suffix* so they stay portable across the gateway prefix — but because generic verbs (`search`, `copyFile`) can collide once the prefix is stripped, always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

The group-gated policies (`freeze-destructive-ops`, `guard-acl-recon`, `role-gate-writes`) read `input.subject.claims.groups` and fail **closed**: a missing, empty, or wrong-shaped claim means no exemption / no write grant. Group names (`drive-admins`, `infosec`, and the write-authorized group) are placeholders — replace them with your IdP's group names at import time. `cap-bulk-export`, `fence-restricted-folders` (its denylist) and `redact-pii-egress` require no identity claims.

## Contributing

To add a Google Drive policy:

1. Create `apps/google-drive/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["google-drive"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle (e.g. [`bundles/soc2`](../../bundles/soc2/README.md) or [`bundles/hipaa`](../../bundles/hipaa/README.md)), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
