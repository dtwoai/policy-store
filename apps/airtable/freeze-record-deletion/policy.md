---
name: Freeze Destructive Airtable Deletes
tags:
  - airtable
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # airtable / freeze-record-deletion

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `airtable.ingress.freeze_record_deletion`

  ## What it does

  Denies every destructive Airtable tool call unless the caller's IdP token carries the placeholder group `airtable-admins`. All read tools and every non-destructive write pass through unchanged.

  Destructive tools are matched by a **blanket `*delete*` substring** on the tool name (case-insensitive), which deliberately covers both Airtable server dialects with one rule:

  - **`delete_records` (domdomegg community server)** — a **batch** delete keyed by a `recordIds` array, so a single call's blast radius is the whole array. Its only mitigation is Airtable's revision history / trash; there is no API-level undo. This is the biggest capability delta versus the official server, and behind domdomegg (or the 42-tool `rashidazarang` server) this policy is load-bearing.
  - **`delete_page` (official / Claude-connector server)** — deletes an interface page (moderate severity). The official remote server exposes **no record- or table-delete tool**, so behind the Claude connector this policy is mostly a forward-looking guard — but it still catches `delete_page`.

  Airtable deletions over MCP are irreversible at the API level, so surviving an agent error or a prompt-injection is exactly the point: a hallucinated "cleanup" step or an injected instruction cannot permanently destroy rows or pages through the agent channel. The check runs at ingress, before the call reaches the Airtable MCP server, so a blocked delete never executes.

  `default allow := false` here applies **only to the matched destructive tools** — the deny-by-default is neutralized for every other tool by an explicit pass-through `allow` branch (`not is_destructive_tool`). Reads (`list_records`, `search_records`, `get_record`, `list_records_for_table`, …) and non-destructive writes (`create_record`, `update_records`, `create_records_for_table`, …) are never touched by this policy. Crucially, `default allow := false` also means a delete-shaped call that arrives with **no identity claims at all** (no `subject`, no `groups`) is denied — the admin exemption fails closed.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records by removing the agent's unilateral ability to destroy them.
  - **GDPR Art. 5(1)(d)** — supports the accuracy principle by preventing mass-corruption/loss of personal data: a batch `delete_records` call cannot silently wipe contact/candidate rows through the agent.

  ## Tool name matching

  The two mainstream Airtable servers name their delete tools differently: domdomegg uses the terse `delete_records`; the official server uses `delete_page` (and its data-write tools carry a `_for_table` suffix). Behind a DTwo gateway both additionally receive the configured server-name prefix (e.g. `airtable-`), arriving as `airtable-delete_records` or `airtable-delete_page`. Because the two destructive verbs share **no common suffix** (`…records` vs `…page`), an `endswith` suffix match cannot cover both with one pattern. Matching is therefore done by a **`contains` substring on the marker `delete`**, case-insensitively:

  - `contains(name, "delete")` catches `delete_records`, `delete_page`, both behind any gateway prefix, and any bare/local spelling — plus any additional `*delete*` tool the unverified 42-tool `rashidazarang` server may expose (e.g. a table- or field-delete). Over-matching is the safe direction for a record-integrity freeze.

  A `contains` match is also naturally robust against trailing-character evasions that trip a suffix match: a name padded with a trailing space, tab, newline, or a trailing zero-width space still contains the `delete` substring and is still caught. The name is additionally coerced to a lowercased, `trim_space`d string for consistency.

  The name is read from both the PARC field (`input.resource.name`) and the legacy alias (`input.payload.name`) via `object.get` chains, and the two are matched **independently** — a request missing the `resource` block, or one carrying a malformed (non-string) value in either field, still cannot skip the match. Each field is coerced to a lowercased, whitespace-trimmed string (a number, null, array, or object resolves to the empty string), so a non-string value in one field can never suppress a genuine `delete` marker in the other.

  Airtable's tool set evolves and the `rashidazarang` server's per-tool names are **unverified** in the landscape note — verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  None. The decision uses only the tool name (`input.resource.name`, with the legacy `input.payload.name` as fallback) and the caller's identity (`input.subject.claims.groups`); arguments are not inspected. `delete_records` takes only `{ baseId, tableId, recordIds: [...] }` and `delete_page` takes a page identifier, so there is nothing in the arguments to distinguish a safe delete from a dangerous one — the whole verb family is frozen.

  Group membership is read via an `object.get(input.subject, "claims", {})` chain and fails closed: a missing subject, missing claims, missing `groups`, or a non-array `groups` value all mean "not admin", so the destructive call is denied.

  ## Examples

  ### Allowed — read tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-list_records", "type": "tool" },
      "payload": { "name": "airtable-list_records", "args": { "baseId": "app123", "tableId": "tbl123" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — delete_records by an admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-delete_records", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["airtable-admins"] } },
      "payload": { "name": "airtable-delete_records", "args": { "baseId": "app123", "tableId": "tbl123", "recordIds": ["rec1", "rec2"] } }
    }
  }
  ```

  `allow = true`.

  ### Denied — delete_records by a non-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-delete_records", "type": "tool" },
      "subject": { "sub": "user@example.com", "claims": { "groups": ["marketing"] } },
      "payload": { "name": "airtable-delete_records", "args": { "baseId": "app123", "tableId": "tbl123", "recordIds": ["rec1"] } }
    }
  }
  ```

  `allow = false`, `reason = "This Airtable deletion is blocked (...)"`.

  ## Composition

  This policy is single-purpose: it freezes `*delete*` tools and nothing else. Pair it with:

  - a **base allowlist** (ingress deny of any call whose `baseId` is not on the approved `app…` list) to confine the agent to sanctioned bases,
  - a **destruction-by-overwrite guard** — `update_records` / `update_records_for_table` can blank or corrupt fields without a `delete` in the name, and a batch `update_field` type change can destroy data fidelity; those are intentionally out of scope here,
  - a **no-external-exposure** deny on `publish_interface` / `create_interface` / `create_page` / `upload_attachment`,
  - an **egress PII redaction** policy on `list_records*` / `search_records` / `get_record*` responses.

  For a hard guarantee against unknown/renamed upstream tools (especially on the unverified `rashidazarang` server), compose the PF-28 `default-deny-unknown-tools` allowlist alongside this policy.

  ## Known limitations

  - **Group names are placeholders — replace `airtable-admins` with your IdP's group name at import time.** The gate reads `input.subject.claims.groups`; confirm your IdP actually emits a `groups` claim (Auth0 and most IdPs require explicit configuration) before relying on the admin exemption. With no `groups` claim the policy still fails closed: destructive calls are denied for everyone.
  - **`rashidazarang` tool names are unverified.** The landscape note advertises 42 tools "covering every PAT scope" but does not verify individual names. The blanket `*delete*` match will catch any of its delete tools whose name contains `delete`, but a destructive tool named without that substring (e.g. a `purge_*` or `remove_*` verb) would not be caught. Introspect the live tool list before relying on this against that server, and compose PF-28 for a closed allowlist.
  - **`*delete*` over-matches by design.** Any tool whose name contains `delete` is frozen — including hypothetical read-oriented tools such as `list_deleted_records` or `get_deletion_history`, and, notably, any **restore/undo** tool named `undelete_records`. Blocking an undelete tool is counter-productive (restore is the mitigation for an accidental delete), so if your server exposes one, add an explicit `allow` carve-out for it or move to an exact-name allowlist. Over-matching is otherwise the safe direction for a record-integrity freeze.
  - **Non-`delete` destructive synonyms pass through.** The freeze keys on the single marker `delete`, so a destructive verb spelled without it — `purge_*`, `remove_*`, `truncate_*`, `drop_*`, `destroy_*` — is **not** caught and is allowed for any caller (confirmed: `purge_records`/`remove_records`/`truncate_table` pass through for a non-admin). Widening the marker set risks over-matching benign tools (`remove_collaborator`, etc.), so this policy stays deliberately single-marker and relies on the PF-28 `default-deny-unknown-tools` allowlist as the closed backstop. If your server (especially the unverified `rashidazarang` one) exposes a delete-class tool named without `delete`, freeze it by name in a companion policy.
  - **Name-only matching does not inspect arguments — a composite/dispatcher tool can smuggle a delete in its args.** The decision uses only the tool name, never the payload body, so a generic operation-dispatcher or batch-executor tool (if your server exposes one) that carries the destructive operation *inside its arguments* rather than in the tool name — e.g. a hypothetical `execute_operations`/`run_batch` whose body names `delete_records` — has no `delete` in its tool name and passes through. No such generic dispatcher is verified in the landscape note for the mainstream Airtable servers (the `rashidazarang` server's advertised "batch operations" and webhook tools are **unverified**), but if yours exposes one, freeze it by name in a companion policy and compose PF-28 so only audited exact tool names are permitted at all.
  - **Destruction by overwrite / other surfaces is not covered.** `update_records` (batch) can blank a row's fields, `update_field` type changes can destroy data fidelity, and `publish_interface` can widen exposure — none contain `delete`, so they pass through here. Those belong to the companion policies above; this policy stays single-job on the irreversible `*delete*` verbs.
  - **Matching assumes the PARC envelope shape — both `resource` and `payload` are objects and the gateway populates a tool name.** The tool name is recovered only from `input.resource.name` and `input.payload.name`. The freeze fails **open** (the call is allowed) precisely when **both** names coerce to `""` — that is, whenever *neither* field carries a string `name`. This happens if `resource` is a non-object (e.g. a bare string) **and** `payload.name` is absent, **and also** if both `name` fields are present but carry non-string values (e.g. `resource.name` a number and `payload.name` an array): each collapses to `""`, `is_destructive_tool` is undefined, and the pass-through branch allows the call. This is not attacker-reachable on a correctly configured gateway: every `tool_pre_invoke` carries `payload.name` set to the invoked tool string, and `resource` is always an object — so at least one field carries the real `delete` name and the freeze fires (see the regression tests where a bare-string `resource`, and separately a both-fields-non-string envelope, are handled). If you cannot rely on that envelope invariant, compose the PF-28 `default-deny-unknown-tools` allowlist so an unrecognizable/absent tool name is denied rather than allowed.
  - **Substring matching is robust to whitespace/zero-width padding but not to homoglyphs or interior splits.** Because the match is `contains(name, "delete")`, trailing spaces, tabs, newlines, and zero-width spaces do not evade it (the `delete` substring is still present). A Unicode-homoglyph spelling of the verb (e.g. a Cyrillic `е` inside `delete`), or a name with characters inserted mid-verb (e.g. `del ete_records`), would not contain the ASCII substring and would pass through. This is not a real evasion on a correctly configured gateway — the gateway routes on the exact server-registered tool name, so an obfuscated name does not resolve to the real destructive tool at the MCP server — but if you cannot rely on that invariant, compose the PF-28 `default-deny-unknown-tools` allowlist so only audited exact names are permitted at all.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - airtable
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package airtable.ingress.freeze_record_deletion

# Deny-by-default: only the explicit allow rules below permit the request.
# Note: the pass-through allow branch (`not is_destructive_tool`) neutralizes
# this default for every non-destructive tool, so the default-deny bites only
# on `*delete*` tools. It also means a delete-shaped call with NO identity
# claims (no subject/groups) is denied — the admin exemption fails closed.
default allow := false

# Placeholder IdP group allowed to run destructive Airtable operations.
# Replace "airtable-admins" with your IdP's group name at import time.
admin_group := "airtable-admins"

# --- Destructive tool matching ---
# The two mainstream Airtable servers name their delete tools differently:
# domdomegg uses `delete_records` (batch, by recordIds array); the official
# server uses `delete_page` (interface page). Those share no common suffix
# (`…records` vs `…page`), so a single `endswith` cannot cover both. Match by
# a `contains` substring on the marker "delete", case-insensitively — this
# catches `delete_records`, `delete_page`, any gateway-prefixed spelling
# (`airtable-delete_records`), any bare/local spelling, and any additional
# `*delete*` tool the unverified 42-tool rashidazarang server may expose.
# `contains` is also naturally robust to trailing-character padding (space,
# tab, newline, zero-width space) that would defeat a suffix match, because
# the "delete" substring is still present. Over-matching is the safe direction
# for a record-integrity freeze. Verify exact names with the dump-input debug
# technique before relying on this in production.
destructive_marker := "delete"

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a
# request that somehow omits the resource block still cannot skip matching
# (red-team hardening: missing resource must not fail open).
# name_of coerces to a lowercased, whitespace-trimmed string. A missing OR
# non-string value (number, null, array, object) resolves to "" rather than
# leaving the rule undefined — an undefined name would make the contains check
# undefined and skip matching entirely (fail-open).
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
# malformed (non-string) value in one field cannot suppress a real "delete"
# marker in the other.
is_destructive_tool if {
    contains(resource_name, destructive_marker)
}

is_destructive_tool if {
    contains(payload_name, destructive_marker)
}

# --- Admin gate ---
# Reads the groups claim through object.get chains so a missing subject,
# missing claims, missing groups, or non-array groups value fails closed:
# the caller is simply not an admin and the destructive call is denied.
# The is_array guard is load-bearing: without it, a groups claim that is an
# OBJECT whose values happen to include "airtable-admins"
# (e.g. {"0":"airtable-admins"}) would satisfy `some group in groups` and fail
# OPEN. Requiring an array means any non-array groups shape (string, object,
# number) fails closed.
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

reasons contains "This Airtable deletion is blocked because deletions over MCP are irreversible at the API level: delete_records permanently removes rows by record ID (only Airtable's revision history or trash can restore them) and delete_page permanently removes an interface page. Make intentional deletions in the Airtable web UI instead, where they can be reviewed and undone. If you believe this block is a false positive, ask your Airtable admin to add you to the airtable-admins group." if {
    is_destructive_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
