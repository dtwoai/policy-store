---
name: Confine Airtable Agent to Allowlisted Bases
tags:
  - airtable
  - fence-sensitive-scopes
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # airtable / fence-base-allowlist

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny base-scoped calls unless the `baseId` is on the allowlist; allow discovery and non-base tools
  **Package:** `airtable.ingress.fence_base_allowlist`

  ## What it does

  An Airtable OAuth grant (or Personal Access Token) with the `workspacesAndBases:read`
  scope spans the **entire** workspace — every base the connected identity can see, not just the
  ones an operator intends the agent to touch. Sensitivity in Airtable is a property of the
  **base** (`app…`), which routinely holds CRM contacts, applicant-tracking pipelines,
  customer/financial trackers, and — on HIPAA-eligible Enterprise plans — health-ops data.

  This policy converts that workspace-wide grant into per-base least privilege by pinning an
  operator-maintained **allowlist of sanctioned base IDs**. At ingress it reads the `baseId`
  argument from every record, schema, and page tool and denies the call unless that `baseId`
  is on the allowlist. The allowlist (`allowed_bases`) is a per-tenant constant pinned at import
  time — the shipped IDs are placeholders.

  Base-scoped tools inspected (both the official server's verbose `*_for_table` / `*_for_page`
  spellings and the community servers' terse names):

  - **Record reads** — `list_records*` (incl. `list_records_for_page`), `search_records`,
    `get_record*` (incl. `get_record_for_page`), and the official `display_records_for_table`
    interactive widget (disabled by default, but fenced if enabled).
  - **Record writes** — `create_record*`, `update_records*`.
  - **Schema writes** — `create_table`, `update_table`, `create_field`, `update_field`.

  Discovery tools that carry **no** `baseId` — `ping`, `list_bases`, `search_bases`,
  `list_workspaces` — are left untouched, so the agent can still enumerate what exists; but any
  operation targeting a specific base must name an allowlisted `app…` ID.

  Every field access uses `object.get`, so the fence **fails closed**: a base-scoped tool call
  that supplies no `baseId` (or carries it under an unexpected key) resolves to the empty string,
  which is not in the allowlist, and is denied. The default is `deny`; only the two explicit allow
  rules below permit a request.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identification and protection of confidential information by
    confining agent access to a governed set of bases on the MCP path; **P4.1** — supports
    limiting personal-information use to identified purposes by keeping PI-bearing bases
    (CRM / ATS) off the agent path unless explicitly sanctioned.
  - **GDPR Art. 9** — supports special-category protection by keeping bases holding health, HR, or
    other Art. 9 data off the agent path until sanctioned; **Art. 5(1)(b)** — supports purpose
    limitation by confining the agent to bases whose purpose the operator has approved;
    **CPRA §1798.121** — supports the right to limit use of sensitive personal information by
    fencing SPI-bearing bases to a minimal allowlist.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `airtable-list_records_for_table`), and that prefix is not standardized. This policy matches
  **case-insensitively by substring** on a small set of canonical stems (`list_record`,
  `display_record`, `search_record`, `get_record`, `create_record`, `update_record`,
  `create_table`, `update_table`, `create_field`, `update_field`). Substring matching is deliberate here: it tolerates any server
  prefix **and** covers both spellings the ecosystem uses —

  - the **official** remote server's verbose names (`list_records_for_table`,
    `list_records_for_page`, `get_record_for_page`, `display_records_for_table`,
    `create_records_for_table`,
    `update_records_for_table`, `create_table`, `update_table`, `create_field`, `update_field`),
    verified against the [Airtable support doc](https://support.airtable.com/docs/using-the-airtable-mcp-server); and
  - the **community** servers' terse names (`list_records`, `search_records`, `get_record`,
    `create_record`, `update_records`, `create_table`, `update_table`, `create_field`,
    `update_field`), verified from the [domdomegg README](https://github.com/domdomegg/airtable-mcp-server).

  Verify the exact names your gateway sends with the dump-input debug technique before relying on
  this in production. If your Airtable MCP server exposes other base-scoped tools, add their stems
  to `base_scoped_stems`.

  ## Argument shape

  Every record, schema, and page tool carries the target base as a scalar string `baseId`
  (`app…`). The policy reads it with `object.get(args, "baseId", "")` and compares it **verbatim,
  case-sensitively**, against `allowed_bases` — Airtable base IDs are case-sensitive, so the
  allowlist is not lower-cased. A call that omits `baseId`, or carries it under a different key,
  yields `""` and is denied (fail closed).

  ## Examples

  ### Allowed — operation on a sanctioned base

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-list_records_for_table", "type": "tool" },
      "payload": {
        "name": "airtable-list_records_for_table",
        "args": { "baseId": "appEXAMPLEBASE0001", "tableId": "tbl123" }  // on the allowlist
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — discovery tool carrying no baseId

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-list_bases", "type": "tool" },
      "payload": { "name": "airtable-list_bases", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — operation on a base that is not allowlisted

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "airtable-list_records_for_table", "type": "tool" },
      "payload": {
        "name": "airtable-list_records_for_table",
        "args": { "baseId": "appUNSANCTIONED99", "tableId": "tbl123" }  // not on the allowlist
      }
    }
  }
  ```

  `allow = false`, `reason = "Airtable base appUNSANCTIONED99 is not on the sanctioned-base allowlist, so the agent may not operate on it. (...)"`.

  ## Composition

  This policy is single-purpose: it confines base-scoped calls to an allowlist of sanctioned
  `app…` IDs. Useful companions:

  - **`apps/airtable/freeze-destructive-ops`** (or equivalent) — deny community `delete_records`.
    This allowlist policy does **not** inspect deletes (see Known limitations), so a delete against
    a non-allowlisted base is not caught here.
  - A **schema-freeze** policy denying `create_base`, `create_interface`, `create_page`,
    `publish_interface`, and `upload_attachment` for everyone but a builders group — this policy
    does not fence `create_base` (it names a `workspaceId`, not a `baseId`) or the interface tools.
  - An **egress PII/PHI redaction** policy on `list_records*` / `search_records` / `get_record*`
    responses, so regulated values read back from an *allowlisted* base are still masked.

  ## Known limitations

  - **Base allowlist only — not a per-table/record fence.** The policy governs *which bases* the
    agent may touch, not which tables or records inside them. Once a base is allowlisted, every
    table/record in it is reachable. Pair with an egress redaction companion for field-level
    control.
  - **Literal, canonical-ID matching.** `baseId` is compared verbatim and case-sensitively against
    `allowed_bases`. A base reached by an ID not on the list is denied (the intended default-deny),
    but this also means the allowlist must contain each sanctioned base's exact canonical `app…`
    ID. The shipped IDs (`appEXAMPLEBASE0001`, `appEXAMPLEBASE0002`) are placeholders — replace them
    with your tenant's real base IDs at import time.
  - **Only the enumerated base-scoped tools are fenced.** Other tools that also carry a `baseId`
    but are **not** in the enumerated set pass through untouched — notably `list_tables_for_base`,
    `get_table_schema` / `describe_table`, `list_pages_for_base`, `describe_page_element`,
    `describe_page_type`, `list_comments` / `create_comment`, community `delete_records`, and
    `upload_attachment`. A caller can still
    enumerate a non-allowlisted base's table/page structure, read or post comments on it, or (on a
    community server) delete its records through these. Add the stems that matter for your data model to `base_scoped_stems`,
    and attach the destructive-ops / schema-freeze companions above.
  - **`create_base` is not fenced.** Base creation names a `workspaceId`, not a `baseId`, so it is
    outside this policy's model; a newly created base is also, by construction, not yet on the
    allowlist, so subsequent record operations against it are denied — but the creation itself is
    not blocked here. Use the schema-freeze companion to gate `create_base`.
  - **Webhook / persistent-channel tools are not fenced (and survive the session).** Airtable's
    webhook API is per-base (`POST /bases/{baseId}/webhooks`), so a webhook-management tool carries
    an explicit `baseId` yet its name contains **none** of the enumerated record/schema stems — it
    therefore passes through the non-base-scoped allow branch even when the `baseId` is *not*
    allowlisted. The 42-tool `rashidazarang/airtable-mcp` community server exposes such webhook tools
    (individual names unverified in the landscape note); the note flags them as a standout risk
    because a webhook creates an outbound data channel that persists after the MCP session ends. This
    policy does **not** stop an agent from registering a webhook on a non-allowlisted base and
    exfiltrating its changes continuously. Deny webhook-creation and other persistence tools with a
    dedicated `deny-escape-hatches` / mailbox-persistence-style companion, and pin the tool inventory
    with a `default-deny-unknown-tools` companion so new/renamed upstream tools fail closed.
  - **No raw-API escape-hatch coverage.** If your Airtable MCP server exposes a generic
    pass-through/GraphQL tool that carries the base target inside an opaque query string rather than
    a `baseId` argument, this policy cannot see it. Deny such tools with a separate escape-hatch
    policy.
  - **Substring tool matching.** Matching is by substring on canonical stems to cover the official
    `_for_table`/`_for_page` infixes, the terse community names, and any gateway prefix. In the
    unlikely event your gateway server name itself contains one of these stems, a discovery tool
    could be mis-classified as base-scoped; verify the exact tool names your gateway sends with the
    dump-input debug technique.
  - **Stems are underscore-delimited — a different word separator is not matched (fail-open, not
    fail-closed).** The stems (`list_record`, `get_record`, …) assume the snake_case spelling used by
    both *verified* servers (the official remote server and domdomegg). A server that exposes the same
    record/schema tools under a **different word separator** — hyphenated (`list-records-for-table`)
    or camelCase (`listRecords`, `getRecord`) — will **not** match any stem, so the call falls through
    the non-base-scoped allow branch and reaches **any** base, allowlisted or not. This is a
    portability gap, not a hole against the two verified servers (both use underscores), but the
    42-tool `rashidazarang/airtable-mcp` server's individual tool names are unverified in the landscape
    note and could use another convention. Before trusting this policy against any unverified server,
    confirm the exact tool names with the dump-input debug technique; if they use hyphens or camelCase,
    add those spellings (e.g. `list-record`, `listrecord`) to `base_scoped_stems`.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - airtable
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package airtable.ingress.fence_base_allowlist

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# Allowlist configuration — PLACEHOLDERS, replace at import time.
#
# Airtable sensitivity is a property of the base (`app…`), and a single OAuth
# grant / PAT with the `workspacesAndBases:read` scope spans the whole
# workspace. Pin the exact canonical base IDs the agent is sanctioned to touch.
# Base IDs are case-sensitive, so this set is compared verbatim (not lowered).
allowed_bases := {
    "appEXAMPLEBASE0001", # e.g. the governed CRM base
    "appEXAMPLEBASE0002", # e.g. the governed support-tracker base
}

# ---------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP server
# name (separator not standardized), and the official server uses verbose
# `*_for_table` / `*_for_page` spellings while the community servers use terse
# names. Match case-insensitively by substring on canonical stems so both
# spellings and any prefix are covered. Verify exact names with the dump-input
# debug technique.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Canonical stems of the record/schema/page tools that carry a `baseId`.
# Singular stems (e.g. `list_record`) are substrings of their plural spellings
# (`list_records`, `list_records_for_table`, `list_records_for_page`), so one
# stem covers every variant.
base_scoped_stems := {
    "list_record", # list_records, list_records_for_table, list_records_for_page
    "display_record", # display_records_for_table (official interactive widget; reads records)
    "search_record", # search_records
    "get_record", # get_record, get_record_for_page
    "create_record", # create_record, create_records_for_table
    "update_record", # update_records, update_records_for_table
    "create_table", # official + community schema create
    "update_table",
    "create_field",
    "update_field",
}

is_base_scoped_tool if {
    some stem in base_scoped_stems
    contains(tool_name, stem)
}

# ---------------------------------------------------------------------------
# Argument extraction — object.get everywhere so a missing baseId fails closed.
args := object.get(object.get(input, "payload", {}), "args", {})

requested_base := object.get(args, "baseId", "")

# ---------------------------------------------------------------------------
# Allow rules.

# Any tool that is not base-scoped (ping, list_bases, search_bases,
# list_workspaces, and every other non-record tool) passes through untouched.
allow if {
    not is_base_scoped_tool
}

# Base-scoped tools are allowed only when they name an allowlisted base.
# A missing/empty baseId resolves to "" which is not in the set -> deny.
allow if {
    is_base_scoped_tool
    allowed_bases[requested_base]
}

# ---------------------------------------------------------------------------
# Deny reasons.

# Base-scoped tool naming a base that is not on the allowlist.
reasons contains msg if {
    is_base_scoped_tool
    requested_base != ""
    not allowed_bases[requested_base]
    msg := sprintf("Airtable base %s is not on the sanctioned-base allowlist, so the agent may not operate on it. Request base onboarding through your data-governance owner, or contact them if you believe this base is already governed.", [requested_base])
}

# Base-scoped tool that supplied no baseId at all — fail closed.
reasons contains msg if {
    is_base_scoped_tool
    requested_base == ""
    msg := "This Airtable tool operates on a specific base but no baseId was supplied, so it cannot be matched against the sanctioned-base allowlist. Re-issue the call naming an allowlisted base, and request base onboarding through your data-governance owner if the base you need is not yet allowlisted."
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
