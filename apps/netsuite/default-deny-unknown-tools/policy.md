---
name: NetSuite Default-Deny Unknown MCP Tools
tags:
  - netsuite
  - default-deny-unknown-tools
  - allowlist
  - access-control
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # netsuite / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only allowlisted NetSuite standard-tool names pass
  **Package:** `netsuite.ingress.default_deny_unknown_tools`

  ## What it does

  Pins an allowlist of the **audited NetSuite MCP Standard Tools** and denies
  every other tool call before it reaches the NetSuite AI Connector. A tool that
  is not on the reviewed list — a newly published standard tool, a renamed
  variant, or an **account-specific custom SuiteScript tool** — is
  denied-and-alerted instead of executing silently. A missing, non-string, or
  non-ASCII tool name also fails closed.

  This posture is **mandatory for NetSuite** rather than optional hardening. The
  official NetSuite AI Connector exposes two endpoints:

  - `…/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools` — the fixed set
    of standard `ns_*` tools this allowlist ships, and
  - `…/services/mcp/v1/all` — the standard tools **plus any custom SuiteScript
    MCP tools installed in the account** (built with Oracle's "MCP Sample
    Tools"). Those custom tools carry **developer-chosen names and side effects
    that are unknowable in advance**, so a blocklist can never keep up with them.
    Only an allowlist pinned to what you have actually audited can.

  Because custom SuiteScript tools have arbitrary names with no forced prefix,
  they do not match any allowlisted `ns_*` suffix and are denied until an
  operator reviews each one and adds it to the per-tenant allowlist.

  ## Pin the allowlist to YOUR account at import time

  The shipped `allowed_tool_suffixes` array is the **audited standard-tool set**
  verified from Oracle's "Available Tools in the MCP Standard Tools SuiteApp"
  documentation. It is complete for the standard SuiteApp, but it is **not** a
  list of your account's custom SuiteScript tools. **At import time, review your
  account's `/services/mcp/v1/all` surface and add the exact name of every
  custom SuiteScript tool you have audited** — until you do, every custom tool
  is denied (the fail-closed direction). Remove any standard tool you do not want
  agents to reach (for example, drop `ns_createrecord` / `ns_updaterecord` if the
  agent role should be read-only, and let the write-gating companion policies
  handle finer control).

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets:
    the agent channel can only reach the NetSuite tools that were explicitly
    reviewed and enumerated, not whatever the `/v1/all` endpoint happens to
    expose.
  - **SOC 2 CC6.6** — supports boundary protection: a custom SuiteScript tool
    installed in the account, or an upstream-renamed standard tool, cannot
    become reachable through the gateway boundary without an explicit allowlist
    change.
  - **SOC 2 CC6.8** — supports preventing unauthorized/unreviewed software on
    the agent channel: a custom SuiteScript MCP tool is new executable
    capability over the ERP, unauthorized-by-default until reviewed (partial —
    covers the MCP path only).
  - **SOC 2 CC7.2 / CC7.3** — deny events on unknown names surface tool-set
    drift (new, renamed, or custom tools) as observable gateway events that feed
    anomaly monitoring and event evaluation (partial — the alerting/monitoring
    pipeline itself is a platform property, not this policy).
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default posture for any new NetSuite data-access path
    (and NetSuite holds employee PII, customer/vendor bank details, and full
    financial results) is deny, and access requires a deliberate allowlist
    change.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name as
  `<server-name>-<tool-name>` (e.g. `netsuite-mcp-ns_getRecord`), and that
  prefix is not standardized across deployments. Matching is therefore
  case-insensitive on `lower(input.resource.name)` and works two ways:

  1. **Exact match** against an allowlisted suffix (covers a deployment that
     sends the bare tool name, unprefixed), or
  2. **Suffix match requiring the `-` separator** — the name must end with
     `-<suffix>`. Requiring the separator stops an unaudited tool whose name
     merely *ends with* an allowlisted string (e.g. a custom tool named
     `my_ns_getrecord`, which ends with `ns_getrecord`) from riding through on
     suffix matching.

  Both branches first require the **raw** (pre-lowercase) tool name to consist
  only of the ASCII set real tool names use — `[A-Za-z0-9._-]`. Checking the raw
  name **before** `lower()` runs closes a Unicode case-folding evasion: `lower()`
  folds a handful of non-ASCII code points onto ASCII letters, so a name built
  from homoglyphs could otherwise fold onto an allowlisted name and pass despite
  being a visibly different, un-audited tool. None of the *shipped* `ns_*` names
  contain a fold-vulnerable letter, but the guard protects any custom names you
  add later and rejects non-ASCII mimicry generally. A name containing any
  character outside that ASCII set is denied.

  The shipped allowlist is the standard SuiteApp inventory (all lower-cased):
  `ns_getrecord`, `ns_getrecordtypemetadata`, `ns_getsuiteqlmetadata`,
  `ns_runcustomsuiteql`, `ns_listsavedsearches`, `ns_runsavedsearch`,
  `ns_listallreports`, `ns_runreport`, `ns_getaccountingbooks`,
  `ns_getaccountingcontexts`, `ns_getnexusids`, `ns_getsubsidiaries`,
  `ns_createrecord`, `ns_updaterecord`. (There is no delete tool in the standard
  SuiteApp; a call to any `ns_delete*` name is unknown and denied.)

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  None. The decision is made entirely from the tool **name**
  (`input.resource.name`) — the point of this gate is that an unknown tool's
  semantics cannot be inspected from its arguments. A scoped unknown tool is
  denied even when its arguments or the whole payload are missing. A missing or
  empty `resource.name` resolves to `""` and is denied (fail closed). A
  **non-string** name (null, number, object, array — a malformed or hostile
  request) is coerced to `""` rather than handed to `lower()`, which would raise
  a built-in type error and leave `allow`/`reason` undefined; with the guard it
  is a clean, reasoned deny. A malformed **`resource`** itself — `null`, a
  string, a number, or an array in place of the expected object — is likewise
  normalized to an empty object, so `resource.name` still resolves to `""` and
  the deny carries the nameless fail-closed reason instead of silently emitting a
  reasonless deny (which would strip the drift-alert content downstream
  monitoring relies on).

  ## Examples

  ### Allowed

  ```jsonc
  // An audited standard read tool on the NetSuite server.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_getRecord", "type": "tool" },
      "payload": {
        "name": "netsuite-mcp-ns_getRecord",
        "args": { "recordType": "salesorder", "id": "12345" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  // An account-specific custom SuiteScript tool exposed on /v1/all — its name is
  // developer-chosen and was not on the audited allowlist.
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-post_bank_transfer", "type": "tool" },
      "payload": {
        "name": "netsuite-mcp-post_bank_transfer",
        "args": { "amount": "50000" }
      }
    }
  }
  ```

  `allow = false`, `reason = "The NetSuite tool 'netsuite-mcp-post_bank_transfer' is not on the pinned allowlist (...)"`.

  ## Composition

  This policy is the outer gate — it decides *which NetSuite tools exist* for
  agents. Pair it with policies that constrain *how* the allowlisted tools are
  used (all of which then only ever see a request that already passed this gate):

  - A **financial-write gate** on `ns_createRecord` / `ns_updateRecord` for
    posting record types (`journalentry`, `vendorbill`, `vendorpayment`,
    `customerpayment`, `check`, `creditmemo`) keyed to a finance IdP group.
  - An **anti-BEC vendor-banking guard** on `ns_updateRecord` where
    `recordType == "vendor"` and the record data carries bank/payment fields.
  - A **SuiteQL guard** on `ns_runCustomSuiteQL` for HR/payroll tables and a
    bulk-export cap on `pageSize`.
  - An **egress financial-PII redaction** policy on `ns_getRecord`,
    `ns_runCustomSuiteQL`, and `ns_runSavedSearch` responses.

  ## Known limitations

  - **The standard allowlist is not your full tool list.** Accounts that connect
    to `/services/mcp/v1/all` expose custom SuiteScript tools whose names this
    policy cannot anticipate; every one is denied until added. Pinning the
    allowlist at import time is a required deployment step, not a tuning step.
  - **Name-based trust only.** The policy audits tool *names*, not behavior. A
    custom SuiteScript tool published under an allowlisted `ns_*` name, or an
    upstream server that repurposes a standard name for different behavior,
    bypasses the intent while matching the letter. Re-audit whenever the account's
    installed SuiteApps or the MCP endpoint change.
  - **Suffix matching trusts the `<server-name>-` prefix convention.** A tool
    literally named `<anything>-ns_getrecord` (separator included) would match
    the `ns_getrecord` entry even though it is a different tool. This is the
    residual cost of portable suffix matching. **It applies to the write
    suffixes too, and there it is the sharp edge of this policy:** an attacker
    who can install a custom SuiteScript tool on `/services/mcp/v1/all` — the
    exact threat this gate exists to stop — can name it
    `<anything>-ns_createrecord` or `<anything>-ns_updaterecord` and it will be
    **allowed** through, smuggling an arbitrary create/update past the
    default-deny. Portable suffix matching cannot distinguish it from a
    legitimately-prefixed standard tool. For any account that connects to
    `/v1/all`, treat pinning **full exact gateway names** (prefix included, in
    place of the suffix entries) as the real fix, not an optional hardening
    step; the shipped suffix list is safe only when every tool the gateway can
    reach is a genuine standard `ns_*` tool.
  - **ASCII-only tool names.** Matching requires the raw tool name to be
    `[A-Za-z0-9._-]` (letters, digits, underscore, dot, hyphen) — the shape all
    verified NetSuite tool names and typical gateway server-name prefixes take.
    This blocks Unicode case-fold spoofing, but a deployment whose configured MCP
    server name contains other characters (spaces, `/`, non-ASCII) would see even
    its legitimate tools denied; rename the server to an ASCII slug, or relax the
    character class, if so.
  - **Strict allowlist, no per-server pass-through.** This policy denies any tool
    name it does not recognize, so attach it on the pipeline fronting the NetSuite
    server. Tools from other MCP servers sharing the same pipeline are also denied
    unless their names are added to the allowlist — govern other servers with
    their own app policies on their own pipeline rather than relaxing this one.
  - **`ns_updateRecord` identifier field unverified.** The landscape note records
    that the record-identifier field name for `ns_updateRecord` could not be
    verified from Oracle docs. This policy does not read arguments, so it is
    unaffected, but the write-gating companion policy that inspects that field
    should be confirmed against a live connector.
  - **No identity-based exemptions.** All callers face the same allowlist. If you
    need a break-glass group that can call unaudited tools, add a separate
    `allow if` branch gated on `input.subject.claims` groups (e.g. a placeholder
    `"infosec"` group — replace it with your IdP's group name at import time).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - netsuite
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package netsuite.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only via allowlist membership below.
# A missing, empty, non-string, or non-ASCII tool name matches nothing and is
# therefore denied (fail closed).
default allow := false

# Audited NetSuite MCP Standard Tools SuiteApp inventory (lower-cased), verified
# from Oracle's "Available Tools in the MCP Standard Tools SuiteApp" docs. This
# is the standard set only — the /services/mcp/v1/all endpoint can additionally
# expose ACCOUNT-SPECIFIC CUSTOM SuiteScript tools whose developer-chosen names
# are unknowable in advance. Review each custom tool and add its exact name at
# import time; until then every custom tool is denied. Remove any standard tool
# the agent role should not reach (e.g. the ns_createrecord / ns_updaterecord
# writes if read-only). Lower-case only.
allowed_tool_suffixes := [
    # Reads
    "ns_getrecord",
    "ns_getrecordtypemetadata",
    "ns_getsuiteqlmetadata",
    "ns_runcustomsuiteql",
    "ns_listsavedsearches",
    "ns_runsavedsearch",
    "ns_listallreports",
    "ns_runreport",
    "ns_getaccountingbooks",
    "ns_getaccountingcontexts",
    "ns_getnexusids",
    "ns_getsubsidiaries",
    # Writes (governed further by the finance-gate / vendor-banking companions)
    "ns_createrecord",
    "ns_updaterecord",
]

# Resource object from the request. A null / non-object `resource` (a malformed
# or hostile request) is normalized to {} so name resolution stays a clean ""
# instead of a runtime type error. object.get(<non-object>, ...) raises a
# built-in type error at eval, which would leave `raw_tool_name`, `tool_name`,
# `reasons`, and `reason` all undefined — i.e. a deny with NO reason, stripping
# the drift-alert content the CC7.2/7.3 audit value depends on. Normalizing here
# keeps a structurally-malformed resource a clean, reasoned fail-closed deny.
resource_obj := r if {
    r := object.get(input, "resource", {})
    is_object(r)
}

resource_obj := {} if not is_object(object.get(input, "resource", {}))

# Raw tool name straight from the request. Missing resource/name resolves to ""
# via object.get and matches nothing (fail closed).
raw_tool_name := object.get(resource_obj, "name", "")

# Tool name, lowercased. A non-string name (null, number, object, array — a
# malformed or hostile request) is coerced to "" instead of being handed to
# lower(), which would raise a built-in type error and leave `allow`/`reason`
# undefined. Coercing keeps the decision a clean, reasoned deny (fail closed).
tool_name := lower(raw_tool_name) if is_string(raw_tool_name)

tool_name := "" if not is_string(raw_tool_name)

# Character-class guard on the RAW (pre-lowercase) name. Real NetSuite tool names
# (`ns_*`) and gateway `<server-name>-` prefixes use only ASCII letters, digits,
# underscore, dot, and the `-` separator. Checking the raw name BEFORE lower()
# closes a Unicode case-folding evasion: lower() folds some non-ASCII code points
# onto ASCII letters, so a homoglyph name could otherwise fold onto an
# allowlisted name and slip through the default-deny gate despite being a
# visibly different, un-audited tool. Guarded by is_string so a non-string name
# still yields a clean, reasoned deny (no built-in type error).
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
# Requiring the `-` separator before the suffix stops unaudited tools whose names
# merely end with an allowlisted string (e.g. a custom tool `my_ns_getrecord`,
# which ends with `ns_getrecord`) from slipping through.
allow if {
    raw_name_is_plain_ascii
    some suffix in allowed_tool_suffixes
    endswith(tool_name, sprintf("-%s", [suffix]))
}

# Named-but-unknown tool — the drift/alert deny. The offending name is included
# so tool-set drift (new, renamed, or custom SuiteScript tools) surfaces in the
# gateway's deny events instead of executing silently.
reasons contains msg if {
    not allow
    tool_name != ""
    msg := sprintf("The NetSuite tool '%s' is not on the pinned allowlist of audited NetSuite standard MCP tools, so it is denied by default. The NetSuite AI Connector's /services/mcp/v1/all endpoint can expose account-specific custom SuiteScript tools (built with Oracle's MCP Sample Tools) whose developer-chosen names and side effects are unknowable in advance, so an unrecognized name may be a new, renamed, or custom tool that has not been reviewed. If this tool is legitimate, ask your gateway operator to audit it and add its exact tool-name suffix to the allowlist in this policy before agents can call it.", [tool_name])
}

# Missing/empty/non-string tool name — cannot be verified, denied (fail closed).
reasons contains "This request carries no tool name, so it cannot be matched against the pinned NetSuite allowlist and is denied by default (fail closed). Verify the gateway is populating input.resource.name with the dump-input debug technique; if tool names are missing systemically, fix the gateway configuration rather than relaxing this policy." if {
    not allow
    tool_name == ""
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
