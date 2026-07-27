# Asana policies

Reusable DTwo policies for Asana MCP servers — the official Asana MCP Server **V2** (`mcp.asana.com/v2/mcp`, the same GA remote server the first-party Claude connector uses, bare snake_case verbs) plus the compatible community implementations (`roychri/mcp-server-asana` and the `cristip73` fork, which keep the `asana_` prefix). The MCP surface is read tools (task, project, portfolio, and status reads plus free-text search across everything the OAuth user can see), externally visible write tools (batch task create/update — up to 50 records per call — comments, project-status broadcasts, project creation), and irreversible destructive tools (`delete_task` and three community-only deletes). Its risk profile is dominated by *record integrity and confidential free text*: task notes, comments, and custom fields routinely carry HR, legal, M&A, and incident PII; a single batch call can mutate or mass-complete an entire project; deletions have no trash-restore path over MCP; and comment/status writes push notifications to named users, including external guests on shared projects.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny every destructive Asana tool (`delete_task` and the community `delete_section`/`delete_project_status`/`delete_tag`) unless the caller is in an admin IdP group. | soc2, hipaa, sox |
| [fence-sensitive-projects](./fence-sensitive-projects/policy.md) | ingress | Deny writes (task create/update, comments, status broadcasts, follower/section adds) that name a configured sensitive project/section GID unless the caller is in the mapped IdP group. | soc2, hipaa, gdpr-ccpa |
| [cap-batch-mutation](./cap-batch-mutation/policy.md) | ingress | Deny official V2 `create_tasks`/`update_tasks` batches above a configurable size ceiling, and any `update_tasks` batch that mass-completes more than the ceiling. | gdpr-ccpa |
| [redact-task-pii](./redact-task-pii/policy.md) | egress | Redact SSN, email, US phone, and IBAN patterns from task, comment/story, search, and project-status read responses (transform-only). | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. The official V2 server dropped the `asana_` prefix and uses bare snake_case verbs (`create_tasks`, `delete_task`), while the community servers keep it (`asana_create_task`, `asana_delete_task`); behind the gateway both additionally receive the configured server-name prefix (e.g. `asana-create_tasks`). The policies in this directory match on the *suffix* case-insensitively (and read the name from both `input.resource.name` and `input.payload.name`) so they stay portable across naming conventions and both server families — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. Asana's V2 tool set also evolves over time, so re-check the inventory when the server updates.

## Identity claims

`freeze-destructive-ops` and `fence-sensitive-projects` read `input.subject.claims.groups` with **placeholder** group names — `freeze-destructive-ops` uses a single admin group (`asana-admins`), and `fence-sensitive-projects` maps each fenced project GID to the IdP group allowed to write to it. Replace these with your own IdP group names at import time; missing or non-array claims fail closed (no group → not exempt → the write is denied). `cap-batch-mutation` and `redact-task-pii` require no IdP claims (`cap-batch-mutation` documents an optional break-glass group you can add).

## Contributing

To add an Asana policy:

1. Create `apps/asana/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["asana"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle (e.g. `soc2`, `hipaa`, `sox`, `gdpr-ccpa`), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
