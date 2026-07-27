---
name: Salesforce Deny API Escape Hatches
tags:
  - salesforce
  - deny-escape-hatches
  - access-control
  - ingress
  - soc2
  - iso27001-nist
publishedAt: 2026-07-12
description: |
  # salesforce / deny-escape-hatches

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `salesforce.ingress.deny_escape_hatches`

  ## What it does

  Unconditionally denies the raw-code and raw-API tools exposed by the community
  Salesforce MCP servers — tools that bypass every object- and argument-level
  policy on the gateway:

  - **tsmztech/mcp-server-salesforce (Node):**
    - `salesforce_execute_anonymous` — arbitrary anonymous Apex, i.e. arbitrary
      DML and HTTP callouts in one call
    - `salesforce_write_apex` / `salesforce_write_apex_trigger` — plants
      persistent code; a trigger runs on every future record change
      (write-once, execute-forever)
    - `salesforce_manage_field_permissions` — can silently widen field-level
      security by profile
  - **smn2gnt/MCP-Salesforce (Python):**
    - `apex_execute` — Apex REST execution
    - `tooling_execute` — raw Tooling API calls
    - `restful` — arbitrary REST endpoint + payload

  These tools accept raw code or raw API paths/payloads, so they are effectively
  unpolicable at argument granularity — no SOQL guard, object allowlist, or
  field-strip transform can inspect what an anonymous Apex block or an arbitrary
  REST call will do. The only safe posture is allow/deny, and the answer is
  deny. There is **no group exemption by design**: an identity carve-out here
  would hand that identity a bypass of every other Salesforce policy on the
  gateway.

  All other tools — the scoped record tools (`query`, `create_record`,
  `update_record`, `salesforce_query_records`, `salesforce_dml_records`, the
  hosted `sobject-*` tools, and everything non-Salesforce) — pass through
  unchanged.

  ## Compliance alignment

  - **SOC 2 CC6.3 / CC6.8** — least privilege and prevention of unauthorized
    software: raw anonymous-Apex, Tooling-API, and arbitrary-REST passthrough are
    privileged, effectively unpoliceable execution paths; denying them on the
    agent channel supports confining privileged functions to authorized paths
    (CC6.3) and keeps unauthorized/arbitrary code off the gateway path (CC6.8).
  - **ISO 27001 A.8.2 / NIST 800-53 AC-6(9), AC-6(10)** — privileged access
    restriction: raw code execution and raw API passthrough are privileged
    functions; denying them on the agent channel supports restricting
    privileged functions to authorized paths and auditing their non-use.

  ## Why ingress

  Anonymous Apex, a deployed trigger, or an arbitrary REST call executes the
  moment it reaches Salesforce — DML is committed, callouts fire, triggers
  persist. Egress inspection would see only the aftermath. Denying at ingress is
  the only point where the action can actually be prevented.

  ## Tool name matching

  Matching is case-insensitive by suffix on the tool name, after surrounding
  whitespace is stripped (`lower(trim_space(input.resource.name))`) so a
  trailing space, newline, or CRLF cannot slip a name past the anchored
  checks. Suffix matching is used because the DTwo gateway prefixes tool names
  with the configured MCP server name (e.g.
  `sf-community-salesforce_execute_anonymous`) and that prefix is not
  standardized. Suffixes matched:

  - `salesforce_execute_anonymous`
  - `salesforce_write_apex`
  - `salesforce_write_apex_trigger`
  - `salesforce_manage_field_permissions`
  - `apex_execute`
  - `tooling_execute`
  - `restful` — matched as the exact tool name or when preceded by any
    non-alphanumeric separator (`-`, `_`, `.`, `/`, … — whatever a gateway uses
    to namespace it), since the bare word is short enough to appear inside
    unrelated tool names. A name where a letter or digit immediately precedes
    it (e.g. a hypothetical `getrestful`) is **not** matched.

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  None. The decision is made entirely from the tool name — these tools carry
  raw code/paths in their arguments, which is precisely why argument inspection
  is not attempted. A matched tool is denied even when its arguments are empty
  or missing.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "sf-community-salesforce_query_records", "type": "tool" },
      "payload": {
        "name": "sf-community-salesforce_query_records",
        "args": { "objectName": "Case", "fields": ["Subject", "Status"] }
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
      "resource": { "name": "sf-community-salesforce_execute_anonymous", "type": "tool" },
      "payload": {
        "name": "sf-community-salesforce_execute_anonymous",
        "args": { "apexCode": "delete [SELECT Id FROM Contact];" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This tool executes raw code or raw API requests against Salesforce (...)"`.

  ## Composition

  This policy is single-purpose defense-in-depth for deployments using the
  community stdio servers. Useful companions from the same app directory:

  - [`apps/salesforce/read-only`](../read-only/policy.md) — allowlist read-only
    posture; new/unknown write tools fail closed.
  - [`apps/salesforce/query-allowlist`](../query-allowlist/policy.md) — object
    scoping on the query tools this policy leaves open.
  - [`apps/salesforce/protect-contact-fields`](../protect-contact-fields/policy.md)
    and [`apps/salesforce/redact-pii`](../redact-pii/policy.md) — field- and
    response-level guards that only work because this policy closes the paths
    around them.

  See the [`bundles/crm`](../../../bundles/crm/README.md) bundle for the
  curated set.

  ## Known limitations

  - **Blocklist, not allowlist.** A new escape-hatch tool added upstream (or a
    renamed one) is not caught until this list is updated. For a fail-closed
    posture, pair with an allowlist policy such as `apps/salesforce/read-only`
    or a default-deny-unknown-tools policy.
  - **No-op on the hosted servers.** The Salesforce hosted `sobject-*` servers
    do not expose these tools, so on those deployments this policy matches
    nothing — that is the intended defense-in-depth behavior, not a gap.
  - **Salesforce DX MCP server not covered.** The developer-tooling server
    (`@salesforce/mcp`, 60+ tools) has its own code-deployment surfaces with
    different names; govern it separately if you enable it.
  - **Tool names sourced from the community repos** (tsmztech/mcp-server-salesforce,
    smn2gnt/MCP-Salesforce) as documented in the mid-2026 landscape research.
    Community servers can rename tools between versions — validate against your
    deployed server's actual `tools/list`.
  - **No identity-based exemptions — intentionally.** Unlike group-gated
    policies, there is no break-glass group: exempting anyone re-opens the
    bypass for that identity. If an admin genuinely needs anonymous Apex, they
    should use the Salesforce Developer Console or CLI outside the agent
    channel, where their own credentials and audit trail apply.
  - **`restful` matching is boundary-based, not a full allowlist.** It fires on
    the exact name or a non-alphanumeric separator immediately before `restful`;
    a name where a letter or digit precedes it (e.g. `getrestful`) is
    intentionally not matched, to avoid false positives on unrelated tools.
    Confirm your deployed server's exact `restful` tool name with the dump-input
    technique. A request that carries **no tool name at all** is treated as "not
    an escape hatch" and allowed — the gateway does not route a tool call
    without a name, so this is not a reachable bypass, but the policy asserts
    nothing over nameless input.
  - **Name normalization / non-string names.** Tool names are trimmed of
    surrounding whitespace and lower-cased before matching, so a trailing
    space/newline/CRLF (e.g. `restful\n`) can no longer evade a match — a
    red-team regression closed in this policy. A name that is not a string
    (e.g. a number) makes `trim_space` undefined, so `is_escape_hatch` fails
    and the request is allowed; the gateway only ever sends a string tool name,
    so this fail-open branch is not reachable in practice.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - crm
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.deny_escape_hatches

# Deny-by-default: only the explicit allow rule below permits the request.
default allow := false

# Raw-code / raw-API tools that bypass object- and argument-level policy.
# Names verified against tsmztech/mcp-server-salesforce (salesforce_* prefix)
# and smn2gnt/MCP-Salesforce (unprefixed snake_case). The gateway prefixes
# tool names with the configured MCP server name, so we match by suffix.
escape_hatch_suffixes := [
    # tsmztech: arbitrary anonymous Apex = arbitrary DML and callouts
    "salesforce_execute_anonymous",
    # tsmztech: plants persistent Apex code
    "salesforce_write_apex",
    # tsmztech: trigger runs on every future record change
    "salesforce_write_apex_trigger",
    # tsmztech: can silently widen field-level security by profile
    "salesforce_manage_field_permissions",
    # smn2gnt: Apex REST execution
    "apex_execute",
    # smn2gnt: raw Tooling API calls
    "tooling_execute",
]

# Normalize the tool name once: strip surrounding whitespace (so a trailing
# newline / space / CRLF cannot slip a match past the anchored checks below),
# then lower-case it for case-insensitive matching. If no name is present this
# is undefined and both is_escape_hatch rules fail — nameless input is allowed
# (the gateway never routes a nameless tool call; see Known limitations).
normalized_name := lower(trim_space(input.resource.name))

is_escape_hatch if {
    some suffix in escape_hatch_suffixes
    endswith(normalized_name, suffix)
}

# smn2gnt `restful` (arbitrary REST endpoint + payload): the bare word is
# short/generic, so match it only as the whole tool name or when preceded by a
# non-alphanumeric separator (`-`, `_`, `.`, `/`, … — whatever a gateway uses to
# namespace the tool). The `(^|[^a-z0-9])` boundary still excludes unrelated
# names where a letter or digit immediately precedes it (e.g. `getrestful`),
# while closing the gap where a non-`-`/`_` separator would have slipped through.
is_escape_hatch if {
    regex.match(`(^|[^a-z0-9])restful$`, normalized_name)
}

# Allow everything that is not a raw-code / raw-API escape hatch.
allow if {
    not is_escape_hatch
}

reasons contains "This tool executes raw code or raw API requests against Salesforce and bypasses the gateway's object- and argument-level policies, so it is disabled for all users on this path. Use the scoped record tools (query, create, update) instead; for genuine Apex or Tooling API work, use the Salesforce Developer Console or CLI outside the agent channel. Contact your InfoSec team if you believe this block is a mistake." if {
    is_escape_hatch
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
