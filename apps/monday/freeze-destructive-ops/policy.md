---
name: Freeze Destructive monday Operations
tags:
  - monday
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # monday / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `monday.ingress.freeze_destructive_ops`

  ## What it does

  Splits monday's destructive tool surface into two tiers and treats each differently at ingress, before the call ever reaches the monday MCP server:

  - **Tier 1 — irreversible, whole-board blast radius (denied for everyone, no admin override):**
    - `delete_column` — drops that column's stored data on **every item** on the board.
    - `delete_object_schema` — destroys a shared object schema account-wide.
    - `delete_object_schema_columns` — destroys columns of a shared object schema account-wide.

    None of these route to a recycle bin. There is no caller who can run them over MCP; the block is unconditional. Make these structural changes from the monday web UI, where they can be reviewed.

  - **Tier 2 — recycle-bin-recoverable, per-record (denied unless the caller is an admin):**
    - `delete_item` — removes an item; recoverable from monday's recycle bin (~30 days).
    - `delete_update` — removes an update (comment) from an item.
    - `undo_action` — reverses the previous action.
    - `archive_item` — archives an item (community server; recoverable).

    These are gated behind the placeholder IdP group `monday-admins`. A caller in that group may run them; everyone else is denied.

  This matters because monday's delete verbs carry no safety rail: `delete_item` takes **only an `itemId` with no confirmation field**, so a hallucinated "cleanup" step or a prompt-injected instruction can quietly destroy business records (HR/recruiting, CRM/deal, IT/security, and healthcare project boards all live in monday). Freezing the irreversible verbs outright and admin-gating the recoverable ones keeps records intact when an agent errs or is manipulated.

  Every read tool and every non-destructive write (`create_item`, `change_item_column_values`, `create_update`, `create_board`, `create_object_schema`, `manage_object_schema_columns`, …) passes through unchanged. `default allow := false` is neutralized for those by an explicit pass-through `allow` branch — the deny-by-default bites only on the matched destructive suffixes.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519** — supports the anti-destruction/alteration-of-records requirement (PF-06): destructive monday tools on the agent channel cannot permanently erase records by agent error or injected instruction, and the irreversible verbs cannot be run at all. **Rule 2-06** — supports retention and legal-hold posture on the same board records.
  - **SOC 2 PI1.5** — supports integrity of stored records by removing the agent's unilateral ability to destroy them.
  - **HIPAA §164.312(c)** — supports the integrity standard (protection of records from improper destruction) where monday items/updates carry PHI in health-adjacent project boards; **§164.530(c)** — supports privacy safeguards over records held in item columns and updates.
  - **GDPR Art. 5(1)(d)** — supports the accuracy principle by blocking mass, unattributed corruption/destruction of personal data held on monday boards through the agent channel.

  ## Tool name matching

  The official monday server (`mondaycom/mcp`, hosted `https://mcp.monday.com/mcp` and local npm) exposes tools **unprefixed** and snake_case (`delete_item`, `delete_column`, …). The community sakce server (`sakce/mcp-server-monday`) prefixes every tool with `monday_` (`monday_delete_item`, `monday_archive_item`); its README also retains older hyphenated spellings. Behind a DTwo gateway both additionally receive the configured server-name prefix (e.g. `monday-`). Matching is therefore done by **suffix**, case-insensitively:

  - Tier 1: `endswith(name, "delete_column")`, `endswith(name, "delete_object_schema")`, `endswith(name, "delete_object_schema_columns")` — official-only tools; the sakce server has no counterpart, so those suffixes are harmless no-ops there.
  - Tier 2: `endswith(name, "delete_item")` catches official `delete_item` and community `monday_delete_item`; `endswith(name, "archive_item")` catches community `monday_archive_item`; `endswith(name, "delete_update")` and `endswith(name, "undo_action")` catch the official update-removal and undo verbs (and any `monday_`-prefixed variant).

  The name is read from **both** the PARC field (`input.resource.name`) and the legacy alias (`input.payload.name`) via `object.get` chains, and the two are matched **independently** — a request missing the `resource` block, or one carrying a malformed (non-string) value in either field, still cannot skip the match. Each field is coerced to a lowercased, whitespace-trimmed string (a number, null, array, or object resolves to the empty string), and `trim_space` strips leading/trailing whitespace before matching, so padding the verb with a trailing space, tab, or newline (`monday-delete_item\n`) does not evade the suffix check.

  monday's tool inventory drifts (the docs say to use `tools/list` for the current set). Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  None. The decision uses only the tool name (`input.resource.name`, with `input.payload.name` as an independent fallback) and, for the Tier 2 verbs, the caller's identity (`input.subject.claims.groups`). Arguments are not inspected: `delete_item` takes only an `itemId` with no confirmation field, so there is nothing in the arguments to distinguish a safe delete from a dangerous one — the whole verb is frozen or gated.

  Group membership is read through an `object.get(input.subject, "claims", {})` chain and fails closed: a missing subject, missing claims, missing `groups`, or a non-array `groups` value all mean "not admin", so the Tier 2 call is denied. The `is_array` guard is load-bearing — an object-shaped `groups` claim (`{"0":"monday-admins"}`) fails closed rather than granting admin.

  ## Examples

  ### Allowed — read tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-get_board_items_page", "type": "tool" },
      "payload": { "name": "monday-get_board_items_page", "args": { "boardId": 123 } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — delete_item by an admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-delete_item", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["monday-admins"] } },
      "payload": { "name": "monday-delete_item", "args": { "itemId": 456 } }
    }
  }
  ```

  `allow = true`.

  ### Denied — delete_item by a non-admin (Tier 2)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-delete_item", "type": "tool" },
      "subject": { "sub": "user@example.com", "claims": { "groups": ["marketing"] } },
      "payload": { "name": "monday-delete_item", "args": { "itemId": 456 } }
    }
  }
  ```

  `allow = false`, admin-gate reason.

  ### Denied — delete_column by an admin (Tier 1, no override)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-delete_column", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["monday-admins"] } },
      "payload": { "name": "monday-delete_column", "args": { "boardId": 123, "columnId": "status" } }
    }
  }
  ```

  `allow = false`, irreversible-tier reason — the admin group does **not** unlock Tier 1.

  ## Composition

  This policy is single-purpose: it freezes/gates the destructive delete-and-undo verbs and nothing else. Pair it with:

  - the **GraphQL escape-hatch deny** (PF-22 `deny-escape-hatches`): `all_monday_api` / `all_api_write` reduce every tool distinction — including deletions — to one opaque GraphQL string and would bypass this policy. Deny those separately.
  - the **default-deny-unknown-tools allowlist** (PF-28 `default-deny-unknown-tools`) so a future destructive verb that does not end in one of the matched suffixes cannot appear unaudited.
  - a **board/schema write fence** (PF-23 `fence-sensitive-boards`) for destructive-adjacent mutations (`change_item_column_values` blanking fields, schema creation/edit) that are intentionally out of scope here.
  - an **egress PII redaction** policy on the board/item read surfaces.

  ## Known limitations

  - **Group names are placeholders — replace `monday-admins` with your IdP's group name at import time.** The gate reads `input.subject.claims.groups`; confirm your IdP actually emits a `groups` claim (Auth0 and most IdPs require explicit configuration) before relying on the admin exemption. With no `groups` claim the policy still fails closed: Tier 2 calls are denied for everyone, and Tier 1 is denied regardless of identity.
  - **The GraphQL escape hatch bypasses this policy.** `all_monday_api` / `all_api_read` / `all_api_write` execute arbitrary GraphQL (including deletions and column drops) as a single `query` string that never names a delete verb. This policy does not inspect that string — compose the PF-22 escape-hatch deny alongside it.
  - **The destructive list is fixed and monday's tool set drifts.** A future destructive verb that does not end in one of the matched suffixes (a hypothetical `delete_group`, `delete_board`, or a bulk plural) is not caught until added to the suffix lists. Note the near-miss trap: `manage_object_schema_columns` (a non-destructive write) does **not** match `delete_object_schema_columns` because the tail differs (`manage_…` vs `delete_…`), so schema edits correctly pass through. Re-audit when the upstream server updates; for a hard guarantee, compose PF-28.
  - **Community-only tools have no official counterpart.** `archive_item` exists only on the sakce server; on the official server that suffix never appears, so its branch is a harmless no-op there.
  - **Recovery is a monday feature, not a DTwo guarantee.** Tier 2 verbs are gated because the deleted records are recoverable from monday's recycle bin (~30 days per monday's documented behavior); this policy neither performs nor guarantees that recovery. Verify your account's retention window.
  - **Suffix matching is exact apart from surrounding whitespace.** The match is `endswith` on the lowercased, `trim_space`d name, so leading/trailing spaces, tabs, and newlines are handled. It does **not** normalize other trailing characters (a trailing `.`, or an invisible non-whitespace code point such as U+200B) or Unicode homoglyphs. These are not real evasions on a correctly configured gateway — the gateway routes on the exact server-registered tool name, so a padded/homoglyph name does not resolve to the real destructive tool — but if you cannot rely on that invariant, compose PF-28 so only audited exact names are permitted at all.
  - **Suffix matching is portable but broad.** A hypothetical unrelated tool whose name ends in one of the matched suffixes would also be caught. For a record-integrity freeze, over-matching is the safe direction.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - monday
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package monday.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
# Note: the pass-through allow branch (`not is_destructive_tool`) neutralizes
# this default for every non-destructive tool, so the default-deny bites only
# on the matched destructive suffixes.
default allow := false

# Placeholder IdP group allowed to run the Tier 2 (recoverable) destructive
# tools. Replace "monday-admins" with your IdP's group name at import time.
# Tier 1 (irreversible) tools are NOT unlocked by this group.
admin_group := "monday-admins"

# --- Tier 1: irreversible, whole-board / account-wide blast radius ---
# Denied for EVERYONE, with no admin override. None of these route to a recycle
# bin. Official monday server only (sakce has no counterpart). Match by suffix,
# case-insensitively, to survive the gateway server-name prefix.
# Note on ordering: "delete_object_schema" is NOT a suffix of
# "delete_object_schema_columns" (the latter's tail is "..._columns"), so the
# two are distinct matches; both land in the same tier regardless.
irreversible_suffixes := [
    "delete_column",
    "delete_object_schema",
    "delete_object_schema_columns",
]

# --- Tier 2: recycle-bin-recoverable, per-record ---
# Denied UNLESS the caller is in admin_group.
#   - "delete_item"   -> official delete_item AND community monday_delete_item
#   - "archive_item"  -> community monday_archive_item (no official counterpart)
#   - "delete_update" -> official delete_update (removes an update/comment)
#   - "undo_action"   -> official undo_action (reverses the previous action)
admin_gated_suffixes := [
    "delete_item",
    "archive_item",
    "delete_update",
    "undo_action",
]

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a request
# that omits the resource block still cannot skip matching (red-team hardening:
# missing/omitted field must not fail open). name_of coerces to a lowercased,
# whitespace-trimmed string; a missing OR non-string value (number, null,
# array, object) resolves to "" rather than leaving the rule undefined (an
# undefined name would make endswith undefined and skip matching -> fail open).
# trim_space strips leading/trailing whitespace so a padded name like
# "monday-delete_item\n" cannot slip past the suffix match.
name_of(key) := trim_space(lower(v)) if {
    v := object.get(object.get(input, key, {}), "name", "")
    is_string(v)
}

name_of(key) := "" if {
    v := object.get(object.get(input, key, {}), "name", "")
    not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# Both names are checked independently. A malformed (non-string) value in one
# field cannot suppress a real destructive suffix in the other.
is_irreversible_tool if {
    some suffix in irreversible_suffixes
    endswith(resource_name, suffix)
}

is_irreversible_tool if {
    some suffix in irreversible_suffixes
    endswith(payload_name, suffix)
}

is_admin_gated_tool if {
    some suffix in admin_gated_suffixes
    endswith(resource_name, suffix)
}

is_admin_gated_tool if {
    some suffix in admin_gated_suffixes
    endswith(payload_name, suffix)
}

# --- Admin gate ---
# Reads the groups claim through object.get chains so a missing subject,
# missing claims, missing groups, or non-array groups value fails closed. The
# is_array guard is load-bearing: without it, a groups claim that is an OBJECT
# whose values include "monday-admins" (e.g. {"0":"monday-admins"}) would
# satisfy `some group in groups` and fail OPEN. Requiring an array forces any
# non-array shape (string, object, number) to fail closed.
caller_is_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    group == admin_group
}

# Allow any tool outside both destructive tiers (pass-through).
allow if {
    not is_irreversible_tool
    not is_admin_gated_tool
}

# Allow Tier 2 tools only for members of the admin group. The
# `not is_irreversible_tool` guard means a name that somehow matched both tiers
# can never be unlocked here (irreversible always wins).
allow if {
    is_admin_gated_tool
    not is_irreversible_tool
    caller_is_admin
}

# Tier 1 deny reason (fires for irreversible tools regardless of identity).
reasons contains "This monday operation is blocked for everyone: delete_column, delete_object_schema, and delete_object_schema_columns are irreversible and hit every item on the board (or a shared schema account-wide), and none of them route to the recycle bin. There is no admin override for these over MCP — make this structural change from the monday web UI, where it can be reviewed. If you believe this block is a false positive, contact your InfoSec team." if {
    is_irreversible_tool
}

# Tier 2 deny reason (fires for recoverable tools when the caller is not admin
# and the tool is not also a Tier 1 verb).
reasons contains "This monday deletion is blocked because delete/undo tools over MCP remove records an agent could destroy in error or under prompt injection: delete_item takes only an itemId with no confirmation, and delete_update, undo_action, and archive_item remove or reverse item data. These are recoverable from monday's recycle bin (~30 days) but still gated. Route this request through a member of your monday admin group (placeholder: monday-admins) instead. If you believe this block is a false positive, ask your InfoSec team to add you to that group." if {
    is_admin_gated_tool
    not is_irreversible_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
