# monday policies

Reusable DTwo policies for monday.com MCP servers — the official hosted monday MCP (`https://mcp.monday.com/mcp`, the server the Claude connector uses) and its local stdio build (`@mondaydotcomorg/monday-api-mcp`), plus the community `sakce/mcp-server-monday`. The MCP surface is broad: board and item reads (`get_board_items_page`, `get_full_board_data`, `board_insights`, `read_docs`, `search`), item and board writes (`create_item`, `create_items`, `change_item_column_values`, `create_update`), directory and notification tools, persistence tools that install standing automations and AI agents, destructive `delete_*` tools, and — where enabled — a GraphQL escape hatch (`all_monday_api` / `all_api_read` / `all_api_write`) and a self-expanding `manage_tools`. Its risk profile is dominated by *concentration and bypass*: monday boards are schemaless business databases where HR/recruiting PII, CRM financials, and security trackers sit behind one flat API token, sensitivity is a property of the board/workspace ID rather than the tool, and a single opaque GraphQL query or a newly enabled tool can reduce every per-tool policy to nothing — which is why the default-deny gate is the outer boundary for this app.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [default-deny-unknown-tools](./default-deny-unknown-tools/policy.md) | ingress | Deny every monday tool whose name does not end with an audited allowlist suffix; blocks the GraphQL escape hatch, `manage_tools`, dynamic-API and apps-mode tools by default and surfaces new/renamed tools as drift. | soc2, gdpr-ccpa |
| [fence-sensitive-boards](./fence-sensitive-boards/policy.md) | ingress | Fence sensitive board and workspace IDs behind IdP groups, turning monday's flat single-token scope into per-team least privilege on reads, writes, and account-wide `search`. | soc2, hipaa, pci-dss, gdpr-ccpa |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Block irreversible whole-board deletes (`delete_column`, `delete_object_schema*`) for everyone and admin-gate recycle-bin-recoverable deletes (`delete_item`, `delete_update`, `undo_action`, `archive_item`) behind an IdP group. | soc2, sox, hipaa, gdpr-ccpa |
| [freeze-standing-automation](./freeze-standing-automation/policy.md) | ingress | Deny the tools that install side effects outliving the session — standing automations and workflows (`create_automation`, `publish_workflow`, ...) and autonomous AI agents (`manage_agent*`). | soc2 |
| [redact-board-pii-egress](./redact-board-pii-egress/policy.md) | egress | Redact SSN, email, phone, and national-ID patterns from board, doc, and update read responses (transform), and deny the account-directory tool for non-admins. | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

monday's official tool names are **bare snake_case** with no vendor prefix (`create_item`, `search`, `get_board_items_page`). Behind the DTwo gateway they surface as `<configured-server-name>-<tool-name>`, and that prefix is not standardized across deployments; the community sakce server additionally prefixes its own names with `monday_` (`monday_create_item`). The policies here match case-insensitively on the tool-name **suffix** so a single entry covers all three spellings, but you should confirm the exact string your gateway sends with the dump-input debug technique before pinning an allowlist or fence.

## Identity claims

Three of these policies are identity-gated and read `input.subject.claims.groups` with **placeholder** group names. Replace both the group names (and, where present, the board/workspace IDs) with your own at import time. Missing or malformed claims fail closed — no group never grants access.

- `fence-sensitive-boards` maps placeholder groups (e.g. `hr`, `sales`, `infosec`) to placeholder board/workspace IDs; only a caller in the mapped group reaches a fenced target.
- `freeze-destructive-ops` admin-gates the recycle-bin-recoverable delete tier behind the placeholder `monday-admins` group; the irreversible tier is denied for everyone regardless of group.
- `redact-board-pii-egress` denies the account-directory tool (`list_users_and_teams`) for callers outside the placeholder admin group; the PII redaction transform applies to all callers and needs no claims.

`default-deny-unknown-tools` and `freeze-standing-automation` require no claims; add a break-glass `allow if` branch gated on `input.subject.claims` groups if you need a platform-admin exemption.

## Contributing

To add a monday policy:

1. Create `apps/monday/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["monday"]` in the policy frontmatter, plus any bundle slugs that apply.
4. If the policy fits a bundle (e.g. `soc2`, `hipaa`, `pci-dss`, `gdpr-ccpa`), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
