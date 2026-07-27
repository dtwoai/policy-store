---
name: Default-Deny Unaudited Airtable Tools
tags:
  - airtable
  - default-deny-unknown-tools
  - allowlist
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # airtable / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only allowlisted tool-name suffixes pass
  **Package:** `airtable.ingress.default_deny_unknown_tools`

  ## What it does

  Maintains a per-tenant allowlist of audited Airtable tool-name suffixes and
  denies any call whose tool name does not end with an allowlisted entry.
  Everything not explicitly reviewed is blocked before it reaches the Airtable
  MCP server, and the deny is surfaced as a gateway event — the drift signal
  that flags a new, renamed, or newly enabled tool the moment it first appears.

  Airtable is a case where default-deny is **mandatory**, not optional
  hardening, for two concrete reasons:

  - **An unverified, oversized community surface.** The
    `rashidazarang/airtable-mcp` community server advertises **~42 tools**
    "covering every Airtable PAT scope" — full CRUD, batch operations, schema
    management, and **webhook management**. Its individual tool names are **not
    verified** from source, so a per-tool blocklist against it is impossible to
    keep complete. Its webhook tools are the standout risk: a webhook creates a
    **persistent outbound data channel that survives the MCP session**, exfil
    that outlives the agent turn. Under default-deny, none of these tools is
    reachable until an operator has introspected the server live and pinned the
    exact names.
  - **Upstream servers grow over time.** The official Airtable server added
    `upload_attachment` in May 2026; community servers add tools on their own
    cadence. A blocklist silently admits every future addition. Default-deny
    fails those closed until they are audited and added to the allowlist.

  It also catches **upstream renames**: a tool that stops matching an
  allowlisted suffix is denied until it is re-audited. This is the
  default-deny-by-design posture — the default state of any tool the tenant has
  not reviewed is "inaccessible."

  A missing, empty, non-string, or non-ASCII tool name matches nothing and is
  denied (fail closed).

  ## Pin the allowlist to YOUR tenant at import time

  The shipped `allowed_tool_suffixes` array is a **starter set** built from the
  verified official-server tools (per the
  [Airtable support doc](https://support.airtable.com/docs/using-the-airtable-mcp-server))
  and the verified `domdomegg/airtable-mcp-server` terse equivalents (per its
  [GitHub README](https://github.com/domdomegg/airtable-mcp-server)). It is not,
  and cannot be, the list of tools *your* deployment has reviewed — in
  particular it contains **nothing** from the unverified rashidazarang surface.
  **At import time, replace or extend the array with exactly the suffixes your
  team has audited after live introspection.**

  Because the DTwo gateway prepends the configured server name to each tool, the
  exact string the gateway sends is deployment-specific. **Verify the precise
  suffixes with the dump-input debug technique before pinning** — do not guess.
  Add only what you have reviewed; every unlisted tool is denied until you do.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    the agent channel can only reach Airtable capabilities that were explicitly
    reviewed and enumerated, not the whole surface an OAuth grant / PAT exposes.
  - **SOC 2 CC6.6** — supports boundary protection against external threats:
    upstream-added, renamed, or unverified community tools (including the
    rashidazarang webhook-persistence tools) do not become reachable through the
    gateway boundary without an explicit allowlist change.
  - **SOC 2 CC6.8** — supports prevention of unauthorized software: any tool the
    tenant has not audited — including a self-expanding or dynamically enabled
    server's additions — is unauthorized-by-default on the agent path.
  - **SOC 2 CC7.2 / CC7.3** — deny decisions from this policy surface tool drift
    (new/renamed upstream tools, newly enabled community surfaces) as observable
    gateway events that feed anomaly monitoring and event evaluation.
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default state of any new data-bearing Airtable tool is
    "inaccessible until audited," and Airtable bases routinely hold personal
    data (CRM contacts, applicant-tracking pipelines, and — on HIPAA-eligible
    Enterprise plans — health-ops rows).

  ## Tool name matching

  The official server uses verbose suffixed names (`list_records_for_table`,
  `create_records_for_table`, `get_record_for_page`); the community
  `domdomegg` server uses terse ones (`list_records`, `create_record`,
  `get_record`). Behind the DTwo gateway both appear as
  `<configured-server-name>-<tool-name>`, and that prefix is not standardized
  across deployments.

  To cover the gateway prefix with a single allowlist entry, the policy matches
  case-insensitively on `lower(input.resource.name)` with **`endswith`** against
  each audited name:

  - `list_records_for_table` (official) — matches,
  - `list_records` (domdomegg terse) — a **separate** entry, because
    `list_records_for_table` does **not** end with `list_records`,
  - `airtable-list_records_for_table` (gateway-prefixed) — ends with
    `list_records_for_table`, matches.

  Because the official and terse spellings are not suffixes of one another, both
  are enumerated explicitly rather than collapsed into a shorter stem — this is
  deliberate, so that suffix matching stays specific enough to preserve drift
  detection (see Known limitations).

  Before matching, the **raw** (pre-lowercase) name must consist only of the
  ASCII set real tool names and gateway prefixes use — `[A-Za-z0-9._-]`. This is
  checked before `lower()` runs, which closes a Unicode case-folding evasion:
  `lower()` folds a handful of non-ASCII code points onto ASCII letters (e.g.
  the Kelvin sign `U+212A` → `k`), so an allowlisted suffix could otherwise be
  spoofed with a folded homoglyph. A name containing any character outside that
  ASCII set is denied.

  ## Allowlisted tools

  The starter allowlist covers the **verified** official-server tools —
  `ping`, `list_bases`, `search_bases`, `list_workspaces`,
  `list_tables_for_base`, `get_table_schema`, `list_records_for_table`,
  `search_records`, `list_records_for_page`, `get_record_for_page`,
  `create_records_for_table`, `update_records_for_table`, `upload_attachment` —
  and the **verified** domdomegg terse equivalents — `list_tables`,
  `describe_table`, `list_records`, `get_record`, `create_record`,
  `update_records`, `create_table`, `update_table`, `create_field`,
  `update_field`, `list_comments`, `create_comment`.

  Everything else is deliberately **excluded** and must be audited before it is
  added, including:

  - **The community destructive path** — `delete_records` (domdomegg batch
    delete by ID array — the biggest capability delta vs. the official server)
    and `delete_page`.
  - **The interactive widget** — `display_records_for_table` (disabled by
    default on the official server).
  - **Structure / external-exposure tools** — `create_base`, `create_interface`,
    `create_page`, `publish_interface`, `list_pages_for_base`,
    `describe_page_element`, `describe_page_type`.
  - **Every unverified rashidazarang tool**, including its webhook-management
    tools — none is on the list, so it is denied by default **unless its name
    happens to end with an allowlisted suffix** (see the short-suffix `ping`
    residual under Known limitations, which is the one way an un-audited
    community tool can slip through this name-only gate).

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
      "resource": { "name": "airtable-list_records_for_table", "type": "tool" },
      "payload": {
        "name": "airtable-list_records_for_table",
        "args": { "baseId": "appABC", "tableId": "tbl123" }
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
      "resource": { "name": "airtable-delete_records", "type": "tool" },
      "payload": {
        "name": "airtable-delete_records",
        "args": { "baseId": "appABC", "tableId": "tbl123", "recordIds": ["rec1"] }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Airtable tool is not on the audited allowlist (...)"`.
  (`delete_records` ends in `e_records`, which does not match the allowlisted
  `update_records` / `search_records` / `list_records` suffixes — so the batch
  delete tool stays denied.)

  ## Composition

  This policy is the outer gate — it decides *which* Airtable tools exist for
  agents. Pair it with policies that constrain *how* the allowlisted tools are
  used:

  - **`apps/airtable/fence-base-allowlist`** — confine the allowlisted
    record/schema tools to a set of sanctioned `app…` base IDs.
  - **`apps/airtable/redact-pii-egress`** — mask PII in
    `list_records*` / `search_records` / `get_record*` responses.
  - A **bulk-read clamp** companion (`cap-bulk-record-reads`) — clamp
    `maxRecords` and govern the raw `filterByFormula` query surface on
    `list_records*`, which is Airtable's only raw-query risk (see Known
    limitations).

  ## Known limitations

  - **The starter allowlist is not your tool list.** Pinning it to the suffixes
    your tenant has actually reviewed is a required deployment step, not a
    tuning step. If you swap in a community server (including rashidazarang),
    every tool it adds is denied until you introspect and add it.
  - **rashidazarang tool names are unverified.** The ~42 tools that server
    advertises were **not** verified from source in the app research, so none is
    on the allowlist and this policy makes no claim about their exact spellings.
    Before allowlisting anything from that server you must introspect it live
    (dump-input) and confirm each name — in particular, do **not** allowlist its
    webhook tools without understanding that a webhook opens a persistent
    outbound channel that outlives the MCP session.
  - **PF-07 warehouse-SQL guards do not apply.** Airtable exposes **no SQL/DAX
    surface**, so the `guard-warehouse-sql` family is out of scope here. The
    residual raw-query risk is the `filterByFormula` string on `list_records*`,
    which this name-only gate does not inspect — handle it with the
    `cap-bulk-record-reads` companion.
  - **`endswith` matching trusts the suffix, not a separator.** To absorb any
    gateway server-name prefix with one entry, matching does not require a
    separator before the suffix. As a result a tool literally named
    `<anything>get_record` (any prefix glued directly onto an allowlisted
    suffix) would also match. No tool in the current **verified** Airtable
    inventory collides this way — notably `delete_records`,
    `display_records_for_table`, `list_pages_for_base`, and `create_base` do
    **not** end with any allowlisted suffix and are denied.
  - **The short `ping` suffix is the sharp edge of that residual.** `ping` is
    only four characters and is a common English word-ending, so **any**
    un-audited tool whose name happens to end in `ping` is silently allowed —
    e.g. a community tool named `bulk_dumping`, `record_scraping`,
    `field_stripping`, or `mapping` all match the `ping` suffix and pass the
    gate. This is the most realistic way the unverified rashidazarang surface
    can reach an agent by *accidental* collision despite the "default-deny"
    posture, so the "all unaudited tools are denied" statements above carry this
    caveat. **This directly undercuts the headline webhook claim.** The policy
    denies `create_webhook` (see Examples/tests), but the ping residual means a
    webhook tool whose name simply *ends in* `ping` is allowed — and "ping" is a
    standard webhook concept (most webhook APIs expose a `ping`/test event), so
    a plausibly-named `webhook_ping` (or `..._ping`) tool on the very
    persistent-channel surface this policy is built to fence would slip through
    by accidental collision. The "webhook tools stay closed until audited"
    statement therefore carries the same ping caveat as everything else. The long suffixes (`get_record`, `list_records`, …) are much less
    exposed to *accidental* collision because an English word rarely ends in
    `_record`/`_records`.

    They are **not** safe against a deliberately or adversarially chosen name,
    though: because the match is `endswith`, a crafted tool name (from a
    compromised or self-expanding community server) can glue any prefix onto
    **any** allowlisted suffix — `evil_upload_attachment` ends with the long
    write suffix `upload_attachment` and is allowed, just as `bulk_dumping` ends
    with `ping`. **Lengthening the allowlist entries does not close this**: since
    the operator is still `endswith`, replacing `ping` with the fuller
    `airtable-ping` does not stop `x-airtable-ping` (or any other glued prefix)
    from matching — it only makes an accidental collision less likely. To truly
    eliminate the glued-prefix residual you must change the match from `endswith`
    to **exact equality** against the full gateway tool name (e.g.
    `lower(input.resource.name) == "airtable-ping"`), which no prefix can
    satisfy. Prefer exact-equality matching if you front an untrusted server.
  - **Name-based trust only.** The policy audits tool *names*, not behavior. A
    tool that keeps an allowlisted name but changes behavior upstream bypasses
    the intent while matching the letter. Re-audit when upstream servers change.
  - **ASCII-only tool names.** Matching requires the raw name to be
    `[A-Za-z0-9._-]`. This is deliberate (it blocks Unicode case-fold and
    homoglyph spoofing), but a deployment whose configured MCP server name
    contains other characters (spaces, `@`, `/`, non-ASCII) would see even its
    legitimate tools denied; rename the server to an ASCII slug, or relax the
    character class, if so.
  - **Exact upstream suffixes unverified for your gateway.** The official and
    domdomegg names are verified from their docs, but the string your gateway
    actually sends depends on the configured server name. Confirm with
    dump-input before pinning.
  - **No identity-based exemptions.** All callers face the same allowlist. If you
    need a platform-admin break-glass group that can call unaudited tools, add a
    separate `allow if` branch gated on `input.subject.claims` groups. (Group
    names would be placeholders — replace them with your IdP's group name at
    import time.)

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
package airtable.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only if its name ends with an audited
# allowlist suffix below. A missing, empty, non-string, or non-ASCII tool name
# matches nothing and is therefore denied (fail closed).
default allow := false

# Audited Airtable tool-name suffixes — STARTER SET. Pin to the suffixes YOUR
# tenant has actually reviewed at import time (see the policy description).
# Matched with endswith so one entry also covers any gateway server-name prefix
# (airtable-list_records_for_table). The official verbose spelling and the
# domdomegg terse spelling are NOT suffixes of one another, so both are listed
# explicitly — this keeps each suffix long/specific enough to preserve drift
# detection.
#
# Sources:
#   - Official server: support.airtable.com "Using the Airtable MCP server"
#   - domdomegg/airtable-mcp-server (GitHub README)
#
# Deliberately EXCLUDED — default-deny by design, audit before adding any:
#   - Community destructive:   delete_records (batch delete by ID), delete_page
#   - Interactive widget:      display_records_for_table (off by default)
#   - Structure / exposure:    create_base, create_interface, create_page,
#                              publish_interface, list_pages_for_base,
#                              describe_page_element, describe_page_type
#   - EVERY unverified rashidazarang tool, incl. webhook-management tools that
#     open a persistent outbound channel surviving the MCP session.
allowed_tool_suffixes := [
    # --- Verified official server tools ---
    "ping",
    "list_bases",
    "search_bases",
    "list_workspaces",
    "list_tables_for_base",
    "get_table_schema",
    "list_records_for_table",
    "search_records",
    "list_records_for_page",
    "get_record_for_page",
    "create_records_for_table",
    "update_records_for_table",
    "upload_attachment",

    # --- Verified domdomegg terse equivalents ---
    "list_tables",
    "describe_table",
    "list_records",
    "get_record",
    "create_record",
    "update_records",
    "create_table",
    "update_table",
    "create_field",
    "update_field",
    "list_comments",
    "create_comment",
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

# Character-class guard on the RAW (pre-lowercase) name. Real Airtable / community
# tool names and gateway <server-name>- prefixes use only ASCII letters, digits,
# underscore, dot, and hyphen. Checking the raw name BEFORE lower() closes a
# Unicode case-folding evasion: lower() folds some non-ASCII code points onto
# ASCII letters (e.g. the Kelvin sign U+212A -> "k"), so an allowlisted suffix
# could be spoofed with a folded homoglyph and slip past the default-deny gate
# despite being a visibly different, un-audited name. The regex is NOT multiline
# in OPA/Go, so a spliced newline breaks the whole-string match. Guarded by
# is_string so a non-string name still yields a clean, reasoned deny.
raw_name_is_plain_ascii if {
    is_string(raw_tool_name)
    regex.match(`^[A-Za-z0-9._-]+$`, raw_tool_name)
}

# Allow only when the name ends with an audited suffix. endswith (no separator
# requirement) is intentional: it matches the bare name (list_records_for_table)
# and any gateway server-name prefix (airtable-list_records_for_table) with a
# single allowlist entry. See Known limitations for the residual this trades for.
allow if {
    raw_name_is_plain_ascii
    some suffix in allowed_tool_suffixes
    endswith(tool_name, suffix)
}

reason := "This Airtable tool is not on the audited allowlist, so the gateway denies it by default and surfaces the call as tool drift. Default-deny is mandatory for Airtable because the rashidazarang community server advertises ~42 unverified tools — including webhook-management tools that open a persistent outbound data channel surviving the MCP session — and because upstream servers add tools over time (e.g. the May-2026 upload_attachment), so a new or renamed tool must fail closed until it is reviewed. Ask a gateway admin to introspect the tool live and, if it is safe for agents, add its verified name suffix to the per-tenant allowlist." if not allow
```
