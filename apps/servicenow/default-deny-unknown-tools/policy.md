---
name: Default-Deny Unknown ServiceNow Tools
tags:
  - servicenow
  - default-deny-unknown-tools
  - allowlist
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # servicenow / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only allowlisted tool names pass
  **Package:** `servicenow.ingress.default_deny_unknown_tools`

  ## What it does

  Maintains an allowlist of audited ServiceNow tool-name suffixes and denies any
  tool call whose name does not match an allowlisted entry. Everything not
  explicitly audited is blocked before it reaches the ServiceNow MCP server —
  including tools that appear after an upstream server update, tools an admin
  newly publishes from the MCP Server Console, and renamed variants of existing
  tools. A missing or empty tool name also fails closed.

  This posture is **mandatory for ServiceNow** rather than optional hardening:
  the official ServiceNow MCP Server (MCP Server Console, GA since the Zurich
  release) has **no fixed tool inventory**. Admins publish instance-defined
  tools of four types — Now Assist Skills, Knowledge Graph queries, Flow
  Designer subflows/actions (end-to-end writes including approvals), and
  Scripted REST APIs — and the resulting tool names have no canonical naming
  scheme. A blocklist can never keep up with a tool surface the instance itself
  defines; only an allowlist pinned to what you have actually audited can.

  The same mechanism neutralizes two further drift sources:

  - **Upstream renames/drift** in community servers — a renamed or newly added
    tool stops matching the allowlist and is denied until re-audited.
  - **Naming divergence between servers** — echelon-ai-labs and
    michaelbuckner use `verb_noun` (`create_incident`) while other servers use
    `noun_verb` (`incident_create`); a tool from a swapped-in server with a
    different convention is denied instead of silently inheriting trust.

  ## Pin the allowlist to YOUR instance at import time

  The shipped `allowed_tool_suffixes` array is a **starter set**, drawn from the
  two verified community inventories (echelon-ai-labs/servicenow-mcp and
  michaelbuckner/servicenow-mcp). It is not, and cannot be, a list of *your*
  tools. **At import time, replace or extend the array with the tool list your
  tenant actually publishes**: export the published tool names from your MCP
  Server Console (or your community server's tool package) and pin the
  allowlist to exactly that audited set. If you use the official ServiceNow MCP
  Server, this step is not optional — your Now Assist Skills, Knowledge Graph
  schemas, subflows, and Scripted REST API tools all carry names this policy
  cannot know in advance, and every one of them will be denied until you add it.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    the agent channel can only reach ServiceNow capabilities that were
    explicitly reviewed and enumerated.
  - **SOC 2 CC6.6** — supports boundary protection: instance-published or
    upstream-added tools do not become reachable through the gateway boundary
    without an explicit allowlist change.
  - **SOC 2 CC6.8** — supports prevention of unauthorized software: subflows,
    Scripted REST APIs, and server-side capabilities published as tools are
    unauthorized-by-default on the agent path.
  - **SOC 2 CC7.2 / CC7.3** — deny decisions from this policy surface tool
    drift (new/renamed upstream tools) as observable gateway events that feed
    anomaly monitoring and event evaluation.
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default state of any new data-bearing tool is
    "inaccessible until audited."

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name as
  `<server-name>-<tool-name>` (e.g. `servicenow-mcp-create_incident`), and that
  prefix is not standardized across deployments. The policy therefore matches
  case-insensitively on `lower(input.resource.name)` in two ways:

  1. **Exact match** against an allowlisted suffix (covers unprefixed names), or
  2. **Suffix match requiring the `-` separator** — the name must end with
     `-<suffix>`. Requiring the separator stops an unaudited tool whose name
     merely *ends with* an allowlisted string (e.g. `forget_record` ends with
     `get_record`) from riding through on suffix matching.

  Both branches first require the **raw** (pre-lowercase) tool name to consist
  only of the ASCII set real tool names use — `[A-Za-z0-9._-]`. This is checked
  before `lower()` runs, which closes a Unicode case-folding evasion: `lower()`
  folds a handful of non-ASCII code points onto ASCII letters (e.g. the Kelvin
  sign `U+212A` → `k`), so without the guard a tool registered as
  `list_<U+212A>nowledge_bases` would fold to the allowlisted
  `list_knowledge_bases` and pass — even though it is a visibly different,
  un-audited name. A name containing any character outside that ASCII set is
  denied.

  The starter allowlist covers read and reversible record-write tools from the
  verified inventories: `list_incidents`, `create_incident`, `update_incident`,
  `add_comment`, `resolve_incident`, `list_change_requests`,
  `get_change_request_details`, `list_articles`, `get_article`,
  `list_knowledge_bases`, `list_catalog_items`, `get_catalog_item`,
  `list_catalog_categories` (echelon-ai-labs) and `get_record`,
  `search_records`, `perform_query`, `add_work_notes` (michaelbuckner).
  High-blast-radius tools are deliberately **excluded** from the starter set:
  change approval (`approve_change`, `reject_change`,
  `submit_change_for_approval`), user/group mutation, workflow/script-include
  editing, changeset commit/publication, `update_script`, and
  `natural_language_update`. Audit before you add any of them.

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  This policy only inspects the tool **name** (`input.resource.name`). It reads
  no arguments, so it is insensitive to argument-shape differences between
  servers. Missing `resource` or `resource.name` resolves to `""` via
  `object.get`, which matches nothing — the call is denied (fail closed). A
  **non-string** name (null, number, object, or array — a malformed or hostile
  request) is coerced to `""` rather than passed to `lower()`; without that
  guard `lower()` would raise a built-in type error that leaves `allow` and the
  deny `reason` undefined, so the call would deny without a surfaced reason.
  With the guard it is a clean, reasoned deny. A **string** name containing any
  character outside `[A-Za-z0-9._-]` (non-ASCII letters, whitespace, control
  characters) likewise never reaches the allow branches and is denied.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-create_incident", "type": "tool" },
      "payload": {
        "name": "servicenow-mcp-create_incident",
        "args": { "short_description": "Printer on floor 3 is down" }
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
      "resource": { "name": "servicenow-mcp-approve_change", "type": "tool" },
      "payload": {
        "name": "servicenow-mcp-approve_change",
        "args": { "change_id": "CHG0031337" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "This ServiceNow tool has not been audited for agent use (...)"`.

  ## Composition

  This policy is the outer gate — it decides *which tools exist* for agents.
  Pair it with policies that constrain *how* the allowlisted tools are used:

  - A **table-fencing ingress policy** for the generic-access tools
    (`get_record`, `search_records`, `perform_query` take a table name and
    reach any table the credential can read — `sys_user`, `sn_hr_core_case`,
    `cmdb_ci`, custom PII tables). If you keep them on the allowlist, fence the
    sensitive tables; if you cannot, remove them from the allowlist.
  - A **human-only change approval policy** denying `approve_change` /
    `reject_change` / `submit_change_for_approval` — so that even if a tenant
    later allowlists them, agent-actuated approval stays blocked.
  - A **force-internal-comments transform** on `add_comment`
    (`is_work_note=false` writes to the customer-visible journal).
  - An **egress PII redaction policy** on list/get/search responses.

  ## Known limitations

  - **The starter allowlist is not your tool list.** Tenants on the official
    ServiceNow MCP Server publish instance-defined tool names this policy
    cannot anticipate; every published tool is denied until added. Pinning the
    allowlist at import time is a required deployment step, not a tuning step.
  - **Name-based trust only.** The policy audits tool *names*, not behavior. A
    tenant admin who publishes a dangerous subflow under an allowlisted name
    (or an upstream server that repurposes an allowlisted name for different
    behavior) bypasses the intent while matching the letter. Re-audit when
    upstream servers or Console publications change.
  - **Suffix matching trusts the `<server-name>-` prefix convention.** A
    published tool literally named `<anything>-get_record` (separator included)
    would match the `get_record` entry even though it is a different tool.
    Exact-name pinning (replace suffix entries with full gateway names) closes
    this if your deployment needs it.
  - **ASCII-only tool names.** Matching requires the raw tool name to be
    `[A-Za-z0-9._-]` (letters, digits, underscore, dot, hyphen) — the shape all
    verified ServiceNow/community tool names and typical gateway server-name
    prefixes take. This is deliberate (it blocks Unicode case-fold spoofing),
    but a deployment whose configured MCP server name contains other characters
    (spaces, `@`, `/`, non-ASCII) would see even its legitimate tools denied;
    rename the server to an ASCII slug, or relax the character class, if so.
  - **Official-server tool names unverified.** No canonical naming scheme for
    MCP Server Console tools could be verified from public documentation; the
    starter set intentionally contains no official-server names.
  - **No identity-based exemptions.** All callers face the same allowlist. If
    you need a break-glass group that can call unaudited tools, add a separate
    `allow if` branch gated on `input.subject.claims` groups.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - servicenow
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package servicenow.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only via allowlist membership below.
# A missing or empty tool name matches nothing and is therefore denied.
default allow := false

# Audited ServiceNow tool-name suffixes — STARTER SET, pin to your tenant's
# published tool list at import time (see the policy description).
# Sources: echelon-ai-labs/servicenow-mcp and michaelbuckner/servicenow-mcp
# (verified inventories). High-blast-radius tools (change approval, user/group
# mutation, workflow/script editing, changeset publication, update_script,
# natural_language_update) are deliberately excluded — audit before adding.
allowed_tool_suffixes := [
    # Incident lifecycle (echelon-ai-labs; create/update/add_comment/
    # add_work_notes shapes also verified in michaelbuckner)
    "list_incidents",
    "create_incident",
    "update_incident",
    "add_comment",
    "resolve_incident",

    # Change requests — read-only entries; approval tools intentionally absent
    "list_change_requests",
    "get_change_request_details",

    # Knowledge base — read-only; publish_article intentionally absent
    "list_articles",
    "get_article",
    "list_knowledge_bases",

    # Service catalog — read-only
    "list_catalog_items",
    "get_catalog_item",
    "list_catalog_categories",

    # Generic record access (michaelbuckner) — table-scoped: pair with a
    # table-fencing policy or remove these entries (see Composition)
    "get_record",
    "search_records",
    "perform_query",
    "add_work_notes",
]

# Raw tool name straight from the request. Missing resource/name resolves to ""
# via object.get and matches nothing (fail closed).
raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

# Tool name, lowercased. A non-string name (null, number, object, array — a
# malformed or hostile request) is coerced to "" instead of being handed to
# lower(), which would raise a built-in type error and leave `allow`/`reason`
# undefined. Coercing keeps the decision a clean, reasoned deny (fail closed).
tool_name := lower(raw_tool_name) if is_string(raw_tool_name)

tool_name := "" if not is_string(raw_tool_name)

# Character-class guard on the RAW (pre-lowercase) name. Real ServiceNow /
# community tool names and gateway `<server-name>-` prefixes use only ASCII
# letters, digits, underscore, dot, and the `-` separator. Checking the raw name
# BEFORE lower() closes a Unicode case-folding evasion: lower() folds some
# non-ASCII code points onto ASCII letters (e.g. the Kelvin sign U+212A -> "k"),
# so a tool registered as `list_<U+212A>nowledge_bases` would otherwise fold to
# the allowlisted `list_knowledge_bases` and slip through the default-deny gate
# despite being a visibly different, un-audited name. Guarded by is_string so a
# non-string name still yields a clean, reasoned deny (no built-in type error).
raw_name_is_plain_ascii if {
    is_string(raw_tool_name)
    regex.match(`^[A-Za-z0-9._-]+$`, raw_tool_name)
}

# Exact match — covers deployments where the gateway sends the bare tool name.
allow if {
    raw_name_is_plain_ascii
    some suffix in allowed_tool_suffixes
    tool_name == suffix
}

# Prefixed match — the DTwo gateway names tools `<server-name>-<tool-name>`.
# Requiring the `-` separator before the suffix stops unaudited tools whose
# names merely end with an allowlisted string (e.g. `forget_record` ends with
# `get_record`) from slipping through.
allow if {
    raw_name_is_plain_ascii
    some suffix in allowed_tool_suffixes
    endswith(tool_name, sprintf("-%s", [suffix]))
}

reason := "This ServiceNow tool has not been audited for agent use, so the gateway denies it by default. Ask a gateway admin to review the tool and, if it is safe for agents, add it to the audited allowlist." if not allow
```
