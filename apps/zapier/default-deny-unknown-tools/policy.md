---
name: Default-Deny Unknown Zapier Tools
tags:
  - zapier
  - default-deny-unknown-tools
  - allowlist
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # zapier / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only allowlisted tool names pass
  **Package:** `zapier.ingress.default_deny_unknown_tools`

  ## What it does

  Maintains an allowlist of audited Zapier tool-name suffixes and denies any
  tool call whose name does not match an allowlisted entry, with an
  alert-worthy reason that tells the operator to treat the deny as upstream
  drift. Everything not explicitly audited is blocked before it reaches the
  Zapier MCP server. A missing or empty tool name also fails closed.

  This posture is **mandatory for Zapier** rather than optional hardening.
  Zapier MCP runs in one of two mutually exclusive modes per server, and the
  two modes produce disjoint, independently drifting tool namespaces:

  - **Agentic mode (dynamic tool discovery — Zapier's default):** 15 static
    meta-tools (`execute_zapier_read_action`, `execute_zapier_write_action`,
    the action-management, skill, config, and feedback tools). The names are
    fixed, but the meta-tools proxy 40,000+ actions across 9,000+ apps.
  - **Classic mode (manual configuration):** one per-account `<app>_<action>`
    tool for each action the server owner enabled at mcp.zapier.com (e.g.
    `gmail_send_email`, `slack_send_message`). This set **changes silently**
    whenever an action is added, renamed, or removed — Zapier can add tools to
    a running server with **no client-visible change**.

  A blocklist can never keep up with a tool surface the upstream account
  defines; only an allowlist pinned to what you have actually audited can.
  With this policy attached, a renamed or newly enabled Zapier action
  appearing mid-session becomes a hard deny surfaced for review instead of an
  implicitly-trusted new capability.

  ## Pin the allowlist to YOUR server mode at import time

  The shipped `allowed_tool_suffixes` array is the **agentic-mode default**:
  the 15 verified meta-tool names from Zapier's own documentation. That is the
  correct pin only for servers running dynamic tool discovery.

  **Classic-mode operators must replace the array with their own enabled
  `<app>_<action>` inventory, pinned per tenant.** Each Zapier MCP server is
  per-account: export the list of actions you enabled at mcp.zapier.com and
  pin the allowlist to exactly that audited set. There is no canonical
  classic-mode inventory this policy could ship — your enabled actions are
  yours alone. After pinning, any action later enabled upstream (by an owner,
  a teammate, or Zapier itself) is denied until you re-audit and add it, which
  is the point: the audited surface stays fixed even though the upstream one
  does not.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    through the single Zapier connector the agent can only reach capabilities
    that were explicitly reviewed and enumerated.
  - **SOC 2 CC6.6** — supports boundary protection: tools added upstream at
    mcp.zapier.com do not become reachable through the gateway boundary
    without an explicit allowlist change.
  - **SOC 2 CC6.8** — supports prevention of unauthorized software: new
    upstream actions and renamed tool variants are unauthorized-by-default on
    the agent path.
  - **SOC 2 CC7.2 / CC7.3** — deny decisions from this policy surface tool
    drift (new/renamed upstream tools) as observable gateway events that feed
    anomaly monitoring and event evaluation.
  - **GDPR Art. 25** — supports data protection by design and by default on
    the agent channel: the default state of any new Zapier-proxied,
    data-bearing tool is "inaccessible until audited."

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name as
  `<server-name>-<tool-name>` (e.g. `zapier-mcp-execute_zapier_read_action`),
  and that prefix is not standardized across deployments. The policy therefore
  matches case-insensitively on `lower(input.resource.name)` in two ways:

  1. **Exact match** against an allowlisted suffix (covers unprefixed names), or
  2. **Suffix match requiring the `-` separator** — the name must end with
     `-<suffix>`. Requiring the separator stops an unaudited tool whose name
     merely *ends with* an allowlisted string (e.g. a classic-mode tool named
     `gmail_execute_zapier_write_action` ends with
     `execute_zapier_write_action` but is underscore-glued, not a gateway
     prefix) from riding through on suffix matching.

  Both branches first require the **raw** (pre-lowercase) tool name to consist
  only of the ASCII set real tool names use — `[A-Za-z0-9._-]`. This is
  checked before `lower()` runs, which closes a Unicode case-folding evasion:
  `lower()` folds a handful of non-ASCII code points onto ASCII letters (e.g.
  the Kelvin sign `U+212A` → `k`), so without the guard a tool registered as
  `send_feedbac<U+212A>` would fold to the allowlisted `send_feedback` and
  pass — even though it is a visibly different, un-audited name. A name
  containing any character outside that ASCII set is denied.

  The shipped allowlist is the 15 agentic-mode meta-tools verified from
  Zapier's documentation: `execute_zapier_read_action`,
  `execute_zapier_write_action`, `list_enabled_zapier_actions`,
  `discover_zapier_actions`, `enable_zapier_action`, `disable_zapier_action`,
  `auto_provision_mcp`, `write_code_action`, `get_configuration_url`,
  `list_zapier_skills`, `get_zapier_skill`, `create_zapier_skill`,
  `update_zapier_skill`, `delete_zapier_skill`, `send_feedback`.

  Verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  This policy only inspects the tool **name** (`input.resource.name`). It
  reads no arguments, so it is insensitive to argument-shape differences
  between modes. Missing `resource` or `resource.name` resolves to `""` via
  `object.get`, which matches nothing — the call is denied (fail closed). A
  malformed `resource` that is not an object at all (a string or array) makes
  the name lookup undefined, which also lands on the default deny — still
  with the surfaced reason. A
  **non-string** name (null, number, object, or array — a malformed or
  hostile request) is coerced to `""` rather than passed to `lower()`; without
  that guard `lower()` would raise a built-in type error that leaves `allow`
  and the deny `reason` undefined, so the call would deny without a surfaced
  reason. With the guard it is a clean, reasoned deny. A **string** name
  containing any character outside `[A-Za-z0-9._-]` (non-ASCII letters,
  whitespace, control characters) likewise never reaches the allow branches
  and is denied.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-execute_zapier_read_action", "type": "tool" },
      "payload": {
        "name": "zapier-mcp-execute_zapier_read_action",
        "args": { "instructions": "Find my three most recent Gmail messages" }
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
      "resource": { "name": "zapier-mcp-gmail_send_email", "type": "tool" },
      "payload": {
        "name": "zapier-mcp-gmail_send_email",
        "args": { "instructions": "Email the Q3 forecast to my manager" }
      }
    }
  }
  ```

  `allow = false`,
  `reason = "This Zapier tool is not on the audited allowlist pinned for this gateway (...)"`.

  ## Composition

  This policy is the outer gate — it decides *which tool names exist* for
  agents. It deliberately does not constrain *how* the allowlisted tools are
  used; pair it with companion Zapier policies:

  - A **toolset-freeze ingress policy** that denies (or group-gates) the
    self-modifying meta-tools — `enable_zapier_action`, `auto_provision_mcp`,
    `write_code_action`, and the skill-write tools. The shipped allowlist
    keeps their *names* reachable because they are part of the verified
    agentic surface; a freeze policy controls who may actually call them.
  - A **read-only posture policy** denying `execute_zapier_write_action` (and,
    classic mode, `send_`/`create_`/`update_`/`delete_` suffixes) for all but
    an approved group — one rule fences every write across 9,000 apps.
  - An **instructions-as-content policy**: every Zapier tool accepts an
    `instructions` string that Zapier's server-side AI uses to fill
    unspecified fields (recipients, bodies, record IDs), so name- and
    structured-field-level controls alone are bypassable by construction.
  - An **egress PII redaction policy** on `execute_zapier_read_action` and
    classic `*_find_*`/`*_get_*` responses — aggregator reads return raw app
    data with no source-app DLP.

  ## Known limitations

  - **Agentic mode hides drift inside arguments.** The 15 meta-tool names
    never change, but `enable_zapier_action` and `auto_provision_mcp` widen
    what `execute_zapier_read_action`/`execute_zapier_write_action` can reach
    without any new tool name appearing. Name pinning cannot see that — in
    agentic mode this policy fixes the *name* surface, not the *capability*
    surface. Pair with a toolset-freeze policy (see Composition) or remove
    the self-expansion suffixes from the allowlist.
  - **The shipped allowlist is agentic-mode only.** A classic-mode server
    behind this policy as shipped will have **every** tool denied, because
    classic `<app>_<action>` names are not on the list. That is fail-closed
    by design, but it means classic-mode pinning (see "Pin the allowlist")
    is a required deployment step, not a tuning step.
  - **Classic-mode names are per-account and mostly unverified.** Only a
    handful of classic tool names (`gmail_send_email`, `slack_send_message`,
    `google_sheets_create_row`, `notion_create_page`,
    `google_calendar_create_event`, `quickbooks_online_find_customer`) were
    verifiable from public third-party docs; the full inventory is defined by
    each account. Treat any other name as unverified until observed on your
    live server via the dump-input technique.
  - **Name-based trust only.** The policy audits tool *names*, not behavior.
    An upstream change that repurposes an allowlisted name for different
    behavior bypasses the intent while matching the letter. Re-audit when
    Zapier ships mode or meta-tool changes.
  - **Suffix matching trusts the `<server-name>-` prefix convention.** A tool
    literally named `<anything>-send_feedback` (separator included) would
    match the `send_feedback` entry even though it is a different tool — and
    `<anything>` includes the empty string, so a name that is just
    `-send_feedback` (leading separator, no prefix) also matches, even though
    no real gateway produces an empty server name. Exact-name pinning
    (replace suffix entries with full gateway names) closes both forms if
    your deployment needs it.
  - **The allowlist applies to every ingress hook, not just tool calls.** The
    policy checks only `input.resource.name` — it does not scope to
    `input.action == "tool_pre_invoke"` or `resource.type == "tool"`. On a
    pipeline that also carries `prompt_pre_fetch`/`resource_pre_fetch` hooks,
    every prompt or resource fetch is denied (with this policy's tool-drift
    reason) unless its name coincidentally matches an allowlisted suffix — in
    which case it is allowed. Both directions are safe for the Zapier surface
    (Zapier MCP exposes tools only), but attach this policy to a
    Zapier-dedicated pipeline, or add an `input.action` guard, if your
    gateway serves prompts or resources you care about.
  - **ASCII-only tool names.** Matching requires the raw tool name to be
    `[A-Za-z0-9._-]` — the shape all verified Zapier tool names and typical
    gateway server-name prefixes take. This is deliberate (it blocks Unicode
    case-fold spoofing), but a deployment whose configured MCP server name
    contains other characters (spaces, `@`, `/`, non-ASCII) would see even
    its legitimate tools denied; rename the server to an ASCII slug, or relax
    the character class, if so.
  - **No identity-based exemptions.** All callers face the same allowlist. If
    you need a break-glass group that can call unaudited tools, add a
    separate `allow if` branch gated on `input.subject.claims` groups.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - zapier
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zapier.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only via allowlist membership below.
# A missing or empty tool name matches nothing and is therefore denied.
default allow := false

# Audited Zapier tool-name suffixes — AGENTIC-MODE DEFAULT: the 15 verified
# meta-tools from Zapier's dynamic-tool-discovery mode (docs.zapier.com/mcp).
# Classic-mode operators: REPLACE this array with your tenant's enabled
# `<app>_<action>` inventory from mcp.zapier.com (see the policy description —
# per-tenant pinning is a required deployment step in classic mode).
allowed_tool_suffixes := [
    # Execution funnel — read/write proxies for every enabled action
    "execute_zapier_read_action",
    "execute_zapier_write_action",

    # Action management — enable/auto_provision/write_code are SELF-MODIFYING
    # (the agent widens its own toolset); keep them listed only if a companion
    # toolset-freeze policy gates who may call them (see Composition)
    "list_enabled_zapier_actions",
    "discover_zapier_actions",
    "enable_zapier_action",
    "disable_zapier_action",
    "auto_provision_mcp",
    "write_code_action",

    # Config
    "get_configuration_url",

    # Skills — create/update persist instructions future sessions auto-load
    # (prompt-injection persistence vector); gate with a companion policy
    "list_zapier_skills",
    "get_zapier_skill",
    "create_zapier_skill",
    "update_zapier_skill",
    "delete_zapier_skill",

    # Feedback
    "send_feedback",
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

# Character-class guard on the RAW (pre-lowercase) name. Real Zapier tool names
# (agentic meta-tools and classic `<app>_<action>` tools) and gateway
# `<server-name>-` prefixes use only ASCII letters, digits, underscore, dot,
# and the `-` separator. Checking the raw name BEFORE lower() closes a Unicode
# case-folding evasion: lower() folds some non-ASCII code points onto ASCII
# letters (e.g. the Kelvin sign U+212A -> "k"), so a tool registered as
# `send_feedbac<U+212A>` would otherwise fold to the allowlisted
# `send_feedback` and slip through the default-deny gate despite being a
# visibly different, un-audited name. Guarded by is_string so a non-string
# name still yields a clean, reasoned deny (no built-in type error).
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
# names merely end with an allowlisted string (e.g. a classic-mode
# `gmail_execute_zapier_write_action` is underscore-glued, not a gateway
# prefix) from slipping through.
allow if {
    raw_name_is_plain_ascii
    some suffix in allowed_tool_suffixes
    endswith(tool_name, sprintf("-%s", [suffix]))
}

reason := "This Zapier tool is not on the audited allowlist pinned for this gateway, so it is denied by default. Zapier can add, rename, or newly enable tools on a running server with no client-visible change — treat this deny as a drift alert and report it to your security team for review. If the tool is expected, ask a gateway admin to audit it and add its name suffix to the allowlist." if not allow
```
