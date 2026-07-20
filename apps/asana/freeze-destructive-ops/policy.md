---
name: Freeze Destructive Asana Operations
tags:
  - asana
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # asana / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `asana.ingress.freeze_destructive_ops`

  ## What it does

  Denies every destructive Asana tool call unless the caller's IdP token carries the placeholder group `asana-admins`. All read tools and every non-destructive write pass through unchanged.

  The destructive set is:

  - **`delete_task` (suffix match)** — catches both the official V2 tool `delete_task` and the community `asana_delete_task` (roychri / cristip73 servers), whether bare or behind the gateway's server-name prefix.
  - **`delete_section`, `delete_project_status`, `delete_tag` (bare-verb suffix match)** — three additional destructive tools. Today they exist only on the community servers as `asana_delete_section` / `asana_delete_project_status` / `asana_delete_tag`, but the suffixes are matched as **bare verbs** (no `asana_` prefix baked in), so they also catch a bare-verb variant the official V2 server might later expose — the official server already dropped the `asana_` prefix for `delete_task`, so a future official section/tag/status delete would plausibly be bare.

  Asana deletions over MCP are irreversible. `delete_task` **permanently removes a task and its non-shared subtasks with no trash-restore path** — a hallucinated "cleanup" step or a prompt-injection can destroy business records (HR, legal, M&A, and incident work lives in Asana tasks) that survive nowhere else. So the destructive family is frozen for everyone except an explicitly designated admin group. The check runs at ingress, before the call reaches the Asana MCP server, so a blocked delete never executes.

  `default allow := false` here applies **only to the matched destructive tools** — the deny-by-default is neutralized for every other tool by an explicit pass-through `allow` branch (`not is_destructive_tool`). Reads (`get_task`, `search_tasks`, `asana_get_task_stories`, …) and non-destructive writes (`create_tasks`, `update_tasks`, `add_comment`, `asana_create_task`, …) are never touched by this policy.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records by removing the agent's unilateral ability to destroy them; **CC6.1** — supports logical access control over protected assets by gating the irreversible delete verbs to a designated admin group.

  ## Tool name matching

  Community Asana servers (roychri, cristip73) prefix every tool with `asana_` and use snake_case; the official V2 server **dropped the `asana_` prefix** and uses bare snake_case verbs (`delete_task`). Behind a DTwo gateway both additionally receive the configured server-name prefix (e.g. `asana-`). Matching is therefore done by **suffix**, case-insensitively:

  - `endswith(name, "delete_task")` catches official `delete_task`, community `asana_delete_task`, and both behind any gateway prefix (`asana-delete_task`, `asana-asana_delete_task`).
  - `endswith(name, "delete_section")`, `endswith(name, "delete_project_status")`, `endswith(name, "delete_tag")` catch the community `asana_delete_section` / `asana_delete_project_status` / `asana_delete_tag` tools (bare or prefixed) **and** any bare-verb variant (`delete_section`, `asana-delete_section`, …). Matching the bare verb — rather than a suffix with the `asana_` prefix baked in — is deliberate: it mirrors the `delete_task` treatment and does not depend on the community naming convention holding for a section/tag/status delete the official server may add later.

  The name is read from both the PARC field (`input.resource.name`) and the legacy alias (`input.payload.name`) via `object.get` chains, and the two are matched **independently** — a request missing the `resource` block, or one carrying a malformed (non-string) value in either field, still cannot skip the match. Each field is coerced to a lowercased, whitespace-trimmed string (a number, null, array, or object resolves to the empty string), so a non-string value in one field can never suppress a genuine destructive suffix in the other. Leading/trailing whitespace is stripped with `trim_space` before matching, so padding the verb with a trailing space, tab, or newline (`asana-delete_task\n`) does not evade the suffix check.

  Asana's tool set evolves (Asana explicitly says to use `tools/list` for the current set; `add_comment` was absent at V2 launch and added later). Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  None. The decision uses only the tool name (`input.resource.name`, with the legacy `input.payload.name` as fallback) and the caller's identity (`input.subject.claims.groups`); arguments are not inspected. `delete_task` takes only a task identifier, so there is nothing in the arguments to distinguish a safe delete from a dangerous one — the whole verb is frozen.

  Group membership is read via an `object.get(input.subject, "claims", {})` chain and fails closed: a missing subject, missing claims, missing `groups`, or a non-array `groups` value all mean "not admin", so the destructive call is denied.

  ## Examples

  ### Allowed — read tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-get_task", "type": "tool" },
      "payload": { "name": "asana-get_task", "args": { "task_id": "12345" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — delete_task by an admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-delete_task", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["asana-admins"] } },
      "payload": { "name": "asana-delete_task", "args": { "task_id": "12345" } }
    }
  }
  ```

  `allow = true`.

  ### Denied — delete_task by a non-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-delete_task", "type": "tool" },
      "subject": { "sub": "user@example.com", "claims": { "groups": ["marketing"] } },
      "payload": { "name": "asana-delete_task", "args": { "task_id": "12345" } }
    }
  }
  ```

  `allow = false`, `reason = "This Asana deletion is blocked because deletions over MCP are irreversible (...)"`.

  ## Composition

  This policy is single-purpose: it freezes the four destructive tools and nothing else. Pair it with:

  - a **protected-project write fence** (ingress deny of `create_tasks`/`update_tasks`/`add_comment` on HR/Legal/M&A project GIDs) — writes are destructive-adjacent but intentionally out of scope here,
  - a **privacy-flip deny** on `asana_update_project`/`asana_create_project` when `privacy_setting` is present and not `private`,
  - an **attachment egress lockdown** on cristip73's `asana_download_attachment`/`asana_upload_attachment_for_object`,
  - an **egress PII redaction** policy on `get_task`/`search_tasks`/`asana_get_task_stories` responses.

  ## Known limitations

  - **Group names are placeholders — replace `asana-admins` with your IdP's group name at import time.** The gate reads `input.subject.claims.groups`; confirm your IdP actually emits a `groups` claim (Auth0 and most IdPs require explicit configuration) before relying on the admin exemption. With no `groups` claim the policy still fails closed: destructive calls are denied for everyone.
  - **The destructive list is fixed and Asana's tool set drifts.** The official V2 set is documented as evolving (25 tools on the reference page vs 42–44 in third-party catalogs), and community forks add tools. A future destructive tool that does **not** end in one of the four matched suffixes (e.g. a hypothetical `delete_project`, or a bulk `delete_tasks` plural) would not be caught until added to `destructive_suffixes`. Re-audit the tool inventory when the upstream server updates. For a hard guarantee against unknown tools, compose the PF-28 `default-deny-unknown-tools` allowlist policy alongside this one.
  - **The section/status/tag deletes are community-only today, but matched by bare verb.** `asana_delete_section`, `asana_delete_project_status`, and `asana_delete_tag` currently exist only on the roychri/cristip73 servers. The suffixes are matched as bare verbs (`delete_section`, `delete_project_status`, `delete_tag`), so on the official V2 server they are harmless no-ops today **and** would catch a future bare-verb official variant (the official server already dropped the `asana_` prefix for `delete_task`). This is intentional over-matching, the safe direction for a record-integrity freeze.
  - **Destruction by overwrite / other surfaces is not covered.** `update_tasks` (batch, up to 50) can blank a task's fields, `asana_update_project` `privacy_setting` can widen exposure, and attachment tools can exfiltrate/replace files. Those belong to the companion policies above — this policy stays single-job on the four irreversible delete verbs.
  - **Suffix matching is portable but broad.** A hypothetical unrelated tool whose name ends in `delete_task` (or one of the community suffixes) would also be gated. For a record-integrity freeze, over-matching is the safe direction.
  - **Suffix matching is exact apart from surrounding whitespace.** The match is `endswith` on the lowercased, `trim_space`d name, so leading/trailing spaces, tabs, and newlines are handled. It does **not** normalize other trailing characters: a name ending in a non-whitespace character after the verb (a trailing `.`, or an invisible non-whitespace code point such as U+200B zero-width space — `asana-delete_task​`) or a Unicode homoglyph of the verb would not match and would pass through. These are not real evasions on a correctly configured gateway — the gateway routes on the exact server-registered tool name, so a padded/homoglyph name does not resolve to the real destructive tool at the MCP server — but if you cannot rely on that invariant, compose the PF-28 `default-deny-unknown-tools` allowlist alongside this policy so only audited exact names are permitted at all.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - asana
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package asana.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
# Note: the pass-through allow branch (`not is_destructive_tool`) neutralizes
# this default for every non-destructive tool, so the default-deny bites only
# on the four matched destructive suffixes.
default allow := false

# Placeholder IdP group allowed to run destructive Asana operations.
# Replace "asana-admins" with your IdP's group name at import time.
admin_group := "asana-admins"

# --- Destructive tool matching ---
# Community Asana servers (roychri, cristip73) prefix tools with `asana_`;
# the official V2 server uses bare snake_case verbs. Behind a DTwo gateway
# both additionally get the configured server-name prefix (e.g. `asana-`).
# So match by SUFFIX, case-insensitively, using the BARE verb (no `asana_`
# prefix baked in) so each suffix catches every spelling:
#   - "delete_task" catches official `delete_task` AND community
#     `asana_delete_task`, bare or prefixed.
#   - "delete_section"/"delete_project_status"/"delete_tag" catch the community
#     `asana_delete_*` tools AND any bare-verb variant. Only the community
#     servers ship these today, but the official V2 server already dropped the
#     `asana_` prefix for `delete_task`, so a future official `delete_section`
#     would be bare — a suffix keyed to `asana_delete_section` would MISS it.
#     Matching the bare verb closes that gap (red-team hardening) and is
#     consistent with how `delete_task` is matched. Over-matching is the safe
#     direction for a record-integrity freeze.
# Verify the exact names on your gateway with the dump-input debug technique.
destructive_suffixes := [
    "delete_task",
    "delete_section",
    "delete_project_status",
    "delete_tag",
]

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a
# request that somehow omits the resource block still cannot skip matching
# (red-team hardening: missing resource must not fail open).
# name_of coerces to a lowercased, whitespace-trimmed string. A missing OR
# non-string value (number, null, array, object) resolves to "" rather than
# leaving the rule undefined — an undefined name would make the endswith checks
# undefined and skip matching entirely (fail-open). trim_space strips leading
# and trailing whitespace (spaces, tabs, newlines) so a padded name like
# "asana-delete_task\n" or "asana-delete_task " cannot slip past the suffix
# match (red-team hardening: trailing-whitespace suffix evasion).
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

# Both names are checked independently. Keeping separate branches means a
# malformed (non-string) value in one field cannot suppress a real destructive
# suffix in the other.
is_destructive_tool if {
    some suffix in destructive_suffixes
    endswith(resource_name, suffix)
}

is_destructive_tool if {
    some suffix in destructive_suffixes
    endswith(payload_name, suffix)
}

# --- Admin gate ---
# Reads the groups claim through object.get chains so a missing subject,
# missing claims, missing groups, or non-array groups value fails closed:
# the caller is simply not an admin and the destructive call is denied.
# The is_array guard is load-bearing: without it, a groups claim that is an
# OBJECT whose values happen to include "asana-admins" (e.g. {"0":"asana-admins"})
# would satisfy `some group in groups` and fail OPEN. Requiring an array means
# any non-array groups shape (string, object, number) fails closed.
caller_is_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    group == admin_group
}

# Allow any tool outside the destructive set.
allow if {
    not is_destructive_tool
}

# Allow destructive tools only for members of the admin group.
allow if {
    is_destructive_tool
    caller_is_admin
}

reasons contains "This Asana deletion is blocked because deletions over MCP are irreversible: delete_task permanently removes a task and its non-shared subtasks with no trash-restore path, so a destroyed record survives nowhere else. Route this request through a member of your Asana admin group (placeholder: asana-admins) instead. If you believe this block is a false positive, ask your InfoSec team to add you to that group." if {
    is_destructive_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
