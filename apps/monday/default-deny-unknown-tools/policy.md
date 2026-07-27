---
name: Default-Deny Unknown monday Tools
tags:
  - monday
  - default-deny-unknown-tools
  - allowlist
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # monday / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only allowlisted tool-name suffixes pass
  **Package:** `monday.ingress.default_deny_unknown_tools`

  ## What it does

  Maintains a per-tenant allowlist of audited monday tool-name suffixes and
  denies any call whose tool name does not end with an allowlisted entry.
  Everything not explicitly reviewed is blocked before it reaches the monday
  MCP server, and the deny is surfaced as a gateway event — the drift signal
  that flags a new, renamed, or newly enabled tool the moment it first appears.

  monday has an unusually large number of ways a single call can escape every
  other per-tool policy, which is why this default-deny gate is the outer
  boundary for the app rather than optional hardening. It fails closed against:

  - **The GraphQL escape hatch** — `all_monday_api`, `all_api_read`,
    `all_api_write`: one opaque `query` string runs arbitrary GraphQL against
    the monday API (any read the token can see, any mutation — permissions,
    subscribers, deletions), bypassing every per-tool distinction.
  - **The self-expanding toolset** — `manage_tools` changes which tools are
    exposed, so a blocklist can never stay complete.
  - **Beta dynamic-API tools** — the arbitrary-GraphQL tools added by
    `--enable-dynamic-api-tools` (the `all_*_api` family above) that are off by
    default locally but on for some deployments.
  - **The developer apps-mode surface** — `monday_apps_export_storage_data` and
    `monday_apps_set_environment_variable` (and the rest of `monday_apps_*`),
    which read app storage and rewrite environment configuration.

  It also catches **upstream renames and newly introduced tools** before they
  can reach the account: a tool that stops matching an allowlisted suffix is
  denied until it is re-audited. This is the default-deny-by-design posture —
  the default state of any tool the tenant has not reviewed is "inaccessible."

  A missing, empty, non-string, or non-ASCII tool name matches nothing and is
  denied (fail closed).

  ## Pin the allowlist to YOUR tenant at import time

  The shipped `allowed_tool_suffixes` array is a **starter set** of read and
  reversible-write tools verified from the official monday MCP source
  (`mondaycom/mcp`). It is not, and cannot be, the list of tools *your*
  deployment has reviewed. **At import time, replace or extend the array with
  exactly the suffixes your team has audited.**

  Because monday exposes tool names **unprefixed** (`create_item`, not
  `monday_create_item`) and the DTwo gateway prepends the configured server
  name, the exact string the gateway sends is deployment-specific. **Verify the
  precise suffixes with the dump-input debug technique before pinning** — do not
  guess. Add only what you have reviewed; every unlisted tool is denied until
  you do.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    the agent channel can only reach monday capabilities that were explicitly
    reviewed and enumerated.
  - **SOC 2 CC6.6** — supports boundary protection: upstream-added, renamed, or
    dynamically enabled tools (including the GraphQL escape hatch and apps-mode
    surface) do not become reachable through the gateway boundary without an
    explicit allowlist change.
  - **SOC 2 CC6.8** — supports prevention of unauthorized software: dynamic-API
    tools, `manage_tools`, and developer apps-mode tools are
    unauthorized-by-default on the agent path.
  - **SOC 2 CC7.2 / CC7.3** — deny decisions from this policy surface tool drift
    (new/renamed upstream tools, newly enabled beta or apps-mode surfaces) as
    observable gateway events that feed anomaly monitoring and event evaluation.
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default state of any new data-bearing monday tool is
    "inaccessible until audited," and monday boards routinely hold personal data
    (HR/recruiting, CRM, healthcare project boards).

  ## Tool name matching

  monday's official tool names are **bare snake_case** with no vendor prefix
  (`create_item`, `search`, `get_board_items_page`). Behind the DTwo gateway
  they appear as `<configured-server-name>-<tool-name>`, and that prefix is not
  standardized across deployments. The community sakce server prefixes its own
  names with `monday_` (`monday_create_item`) as part of the tool name itself.

  To cover all three spellings with a single allowlist entry, the policy matches
  case-insensitively on `lower(input.resource.name)` with **`endswith`** against
  the bare suffix:

  - `create_item` (official, bare) — matches,
  - `monday_create_item` (sakce community) — ends with `create_item`, matches,
  - `monday-mcp-create_item` (gateway-prefixed) — ends with `create_item`,
    matches.

  Before matching, the **raw** (pre-lowercase) name must consist only of the
  ASCII set real tool names and gateway prefixes use — `[A-Za-z0-9._-]`. This is
  checked before `lower()` runs, which closes a Unicode case-folding evasion:
  `lower()` folds a handful of non-ASCII code points onto ASCII letters (e.g.
  the Kelvin sign `U+212A` → `k`), so a suffix a tenant later pins that contains
  those letters (e.g. `link_board_items_workflow`) could otherwise be spoofed
  with a folded character. A name containing any character outside that ASCII
  set is denied.

  The starter allowlist covers safe reads and reversible item-level writes:
  `get_board_info`, `get_board_schema`, `get_board_items_page`, `search`,
  `get_updates`, `create_item`, `change_item_column_values`, `create_update`.
  Everything else is deliberately **excluded** and must be audited before it is
  added — the escape hatch (`all_monday_api`, `all_api_read`, `all_api_write`),
  `manage_tools`, all `monday_apps_*` developer tools, persistence tools
  (`create_automation`, `manage_automations`, `create_workflow`,
  `manage_agent*`), destructive tools (`delete_item`, `delete_column`,
  `delete_object_schema*`), outbound-to-human tools (`create_notification`,
  form tools), and broad/batch reads and writes (`get_full_board_data`,
  `create_items`, `list_users_and_teams`).

  ## Argument shape

  This policy inspects only the tool **name** (`input.resource.name`); it reads
  no arguments, so it is insensitive to argument-shape differences between the
  official and community servers. A missing `resource` or `resource.name`
  resolves to `""` via `object.get` and matches nothing (deny). A **non-string**
  name (null, number, object, array — a malformed or hostile request) is coerced
  to `""` rather than passed to `lower()`; without that guard `lower()` would
  raise a built-in type error that leaves `allow` and `reason` undefined — a deny
  with no surfaced reason. With the guard it is a clean, reasoned deny.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp-get_board_items_page", "type": "tool" },
      "payload": {
        "name": "monday-mcp-get_board_items_page",
        "args": { "boardId": 12345 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp-all_monday_api", "type": "tool" },
      "payload": {
        "name": "monday-mcp-all_monday_api",
        "args": { "query": "mutation { delete_item (item_id: 42) { id } }" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This monday tool is not on the audited allowlist (...)"`.

  ## Composition

  This policy is the outer gate — it decides *which* monday tools exist for
  agents. Pair it with policies that constrain *how* the allowlisted tools are
  used:

  - A **board/workspace fencing policy** (e.g. `apps/monday/fence-sensitive-boards`)
    for the generic reads/writes on the allowlist (`get_board_items_page`,
    `search`, `create_item`, `change_item_column_values`) — those take a
    `boardId`/`workspaceIds` and reach any board the token can see, so scope
    them by IdP group.
  - An **egress PII redaction policy** on `get_board_items_page` / `search` /
    `get_updates` responses so board data (email/phone column values are plain
    strings) is masked before it reaches the model.
  - A **freeze-destructive-ops / freeze-persistence policy** — even if a tenant
    later allowlists a write tool, keep `delete_*`, `create_automation`, and
    `manage_agent*` blocked so agent-installed automations cannot outlive the
    session.

  ## Known limitations

  - **The starter allowlist is not your tool list.** Pinning it to the suffixes
    your tenant has actually reviewed is a required deployment step, not a
    tuning step. If you enable `--enable-dynamic-api-tools`, `--mode apps`, or a
    swapped-in community server, every tool they add is denied until you audit
    and add it.
  - **`endswith` matching trusts the suffix, not a separator.** To support the
    sakce `monday_`-prefixed spelling with one entry, matching does not require a
    `-` separator before the suffix. As a result a tool literally named
    `<anything>create_item` (any prefix glued directly to an allowlisted suffix)
    would also match. No tool in the current monday inventory collides this way
    (`create_items`, `create_update_in_monday`, `get_full_board_data` do **not**
    end with an allowlisted suffix and are denied), but if your deployment needs
    stricter matching, replace the suffix entries with the exact full gateway
    tool names.
  - **A short, generic suffix weakens the drift guarantee for future renames.**
    The residual above bites hardest on the one-word English suffix `search`.
    Because matching is by suffix, a **future or renamed** upstream tool whose
    name ends in `search` — e.g. `advanced_search`, `global_search`,
    `people_search` — would be auto-allowed rather than surfaced as tool drift,
    silently defeating the "deny new/renamed tools until re-audited" posture for
    that one class (the drift-detection claims above hold for tools that *stop*
    matching a suffix, not for a newly introduced tool that *starts* ending in a
    generic one). No such tool exists in the current monday inventory (the only
    `search`-ending tool is `search` itself), and the long, specific suffixes
    (`get_board_items_page`, `change_item_column_values`, `create_update`) are
    effectively rename-proof. If drift alerting on the `search` family matters to
    you, drop `search` from the allowlist and pin the exact full gateway tool
    name(s) for it instead.
  - **Legacy hyphenated community names are not covered.** The pre-FastMCP sakce
    spellings use hyphens (`monday-create-item`); they do not end with the
    underscore suffix `create_item` and are therefore denied. If you run the
    legacy server, add the hyphenated names to the allowlist after auditing.
  - **Name-based trust only.** The policy audits tool *names*, not behavior. A
    tool that keeps an allowlisted name but changes behavior upstream (or a
    board published under a benign-looking name) bypasses the intent while
    matching the letter. Re-audit when upstream servers change.
  - **ASCII-only tool names.** Matching requires the raw name to be
    `[A-Za-z0-9._-]`. This is deliberate (it blocks Unicode case-fold and
    homoglyph spoofing), but a deployment whose configured MCP server name
    contains other characters (spaces, `@`, `/`, non-ASCII) would see even its
    legitimate tools denied; rename the server to an ASCII slug, or relax the
    character class, if so.
  - **Exact upstream suffixes unverified for your gateway.** The bare names are
    verified from `mondaycom/mcp` source, but the string your gateway actually
    sends depends on the configured server name. Confirm with dump-input before
    pinning.
  - **No identity-based exemptions.** All callers face the same allowlist. If you
    need a platform-admin break-glass group that can call unaudited tools (e.g.
    for a controlled `all_monday_api` window), add a separate `allow if` branch
    gated on `input.subject.claims` groups.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - monday
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package monday.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only if its name ends with an audited
# allowlist suffix below. A missing, empty, non-string, or non-ASCII tool name
# matches nothing and is therefore denied (fail closed).
default allow := false

# Audited monday tool-name suffixes — STARTER SET. Pin to the suffixes YOUR
# tenant has actually reviewed at import time (see the policy description).
# Matched with endswith so one bare official suffix (create_item) also covers
# the sakce community monday_-prefixed spelling (monday_create_item) and any
# gateway server-name prefix (monday-mcp-create_item).
#
# Source: mondaycom/mcp platform-api-tools (verified inventory). Deliberately
# EXCLUDED — default-deny by design, audit before adding any:
#   - GraphQL escape hatch:   all_monday_api, all_api_read, all_api_write
#   - Self-expanding toolset:  manage_tools
#   - Beta dynamic-API tools:  the all_*_api family added by
#                              --enable-dynamic-api-tools
#   - Developer apps-mode:     monday_apps_export_storage_data,
#                              monday_apps_set_environment_variable, monday_apps_*
#   - Persistence (outlive the session): create_automation, manage_automations,
#                              create_workflow, update_workflow, publish_workflow,
#                              manage_agent*
#   - Destructive:             delete_item, delete_column, delete_update,
#                              delete_object_schema*
#   - Outbound-to-humans:      create_notification, create_form/update_form
#   - Broad / batch:           create_items, get_full_board_data,
#                              list_users_and_teams (directory harvesting)
allowed_tool_suffixes := [
    # Reads (metadata + item/board content)
    "get_board_info",
    "get_board_schema",
    "get_board_items_page",
    "search",
    "get_updates",

    # Reversible item-level writes
    "create_item",
    "change_item_column_values",
    "create_update",
]

# Raw tool name straight from the request. Missing resource/name resolves to ""
# via object.get and matches nothing (fail closed).
raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

# Tool name, lowercased. A non-string name (null, number, object, array — a
# malformed or hostile request) is coerced to "" instead of being handed to
# lower(), which would raise a built-in type error and leave allow/reason
# undefined. Coercing keeps the decision a clean, reasoned deny (fail closed).
tool_name := lower(raw_tool_name) if is_string(raw_tool_name)

tool_name := "" if not is_string(raw_tool_name)

# Character-class guard on the RAW (pre-lowercase) name. Real monday / community
# tool names and gateway <server-name>- prefixes use only ASCII letters, digits,
# underscore, dot, and hyphen. Checking the raw name BEFORE lower() closes a
# Unicode case-folding evasion: lower() folds some non-ASCII code points onto
# ASCII letters (e.g. the Kelvin sign U+212A -> "k"), so a suffix a tenant later
# pins that contains such a letter could be spoofed with a folded character and
# slip past the default-deny gate despite being a visibly different, un-audited
# name. Guarded by is_string so a non-string name still yields a clean, reasoned
# deny (no built-in type error).
raw_name_is_plain_ascii if {
    is_string(raw_tool_name)
    regex.match(`^[A-Za-z0-9._-]+$`, raw_tool_name)
}

# Allow only when the name ends with an audited suffix. endswith (no separator
# requirement) is intentional: it matches the bare official name (create_item),
# the sakce monday_-prefixed spelling (monday_create_item), and any gateway
# server-name prefix (monday-mcp-create_item) with a single allowlist entry.
# See Known limitations for the residual this trades for.
allow if {
    raw_name_is_plain_ascii
    some suffix in allowed_tool_suffixes
    endswith(tool_name, suffix)
}

reason := "This monday tool is not on the audited allowlist, so the gateway denies it by default and surfaces the call as tool drift. This fails closed against the GraphQL escape hatch (all_monday_api / all_api_read / all_api_write), the self-expanding manage_tools, the beta dynamic-API tools, and the developer apps-mode surface (monday_apps_export_storage_data, monday_apps_set_environment_variable) — any one of which could reduce every other monday policy to one opaque query string. Ask a gateway admin to review the tool and, if it is safe for agents, add its verified suffix to the allowlist." if not allow
```
