---
name: Freeze Payroll Writes in Gusto
tags:
  - gusto
  - freeze-destructive-ops
  - ingress
publishedAt: 2026-07-12
description: |
  # gusto / freeze-payroll-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny write-shaped tools, allow reads
  **Package:** `gusto.ingress.freeze_payroll_writes`

  ## What it does

  Freezes every write and delete operation on a Gusto pipeline. Any tool call whose
  name looks write-shaped is denied at ingress, before it reaches the upstream MCP
  server, so a payroll, compensation, bank-account, or employee mutation initiated by
  an agent never executes.

  Gusto is unusual among tier-1 connectors: the **official Gusto MCP server**
  (`mcp.api.gusto.com`) is strictly **read-only** — all 36 of its tools are reads, and
  the docs state verbatim that "All tools provided by the Gusto MCP server are
  read-only." Against that server this policy is a **no-op**: no official tool name is
  write-shaped, so every call passes through untouched.

  Its value is the moment a tenant wires Gusto through a third-party **aggregator**.
  StackOne's Gusto connector exposes 72 actions — ~33 reads plus **15 create / 13
  update / 9 delete** actions covering employees, contractors, compensations, benefits,
  **bank accounts**, pay schedules, time-off, and **payroll deletion**. Those are
  money-movement-adjacent and effectively irreversible once a pay run processes. From
  the instant that server is attached, this policy blocks all of them — no re-authoring
  required — because it matches on write-verb shape, not on a fixed official tool list.

  The policy normalizes camelCase word boundaries to an underscore, then matches
  case-insensitively:

  - **create / update / delete** appearing as a delimited verb token anywhere in the
    (server-prefixed) tool name, in the underscore, hyphen, **or dot** dialect **and in
    camelCase** (which is normalized to underscores first), and whether the verb
    **leads** the action id (`create_employee`, `hris_create_employee`, `createEmployee`)
    or **trails** it (`hris_employee_create`, `employeeCreate`). This covers
    `create_*`/`create-*`/`create.*`/`createX`, `update_*`/`update-*`/`update.*`/`updateX`,
    and `delete_*`/`delete-*`/`delete.*`/`deleteX`.
  - any name containing **`submit`** (`*submit*`) — payroll submission and re-submission
    are money-movement writes.

  `default allow := false`. A call is allowed only when it presents a **non-empty,
  non-write-shaped** tool name, so a call whose name is missing entirely is denied
  rather than passed. There is no group exemption: agent-initiated payroll mutations are
  out of policy for everyone, and the deny reason points the caller to the Gusto UI.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519** — anti-destruction/alteration of records: an agent
    cannot delete payrolls or mutate payroll/compensation/bank-account records on the
    MCP path, supporting the record-preservation obligation over financial data in
    Gusto (coverage-matrix §2.5, PF-06).
  - **SOX Rule 13a-15(f)(3)** — safeguarding of assets: freezing payroll-submit and
    bank-account create/delete on the agent channel supports the safeguarding-of-assets
    control; this policy is the destructive-freeze half of that posture and composes
    with a money-movement cap (PF-09) once aggregator write tool-name strings are
    verified per tenant.
  - **SOC 2 PI1.5** — integrity of stored records: preventing agent-initiated creation,
    update, and deletion of payroll records supports the stored-record-integrity
    criterion (coverage-matrix §2.1, PF-06).

  ## Tool name matching

  Matches case-insensitively on `input.resource.name`. The DTwo gateway prefixes tool
  names with the configured MCP server name (e.g. `gusto-mcp-create_employee`), so the
  policy detects the write verb as a **delimited token** (`(^|[._-])(create|update|delete)([._-]|$)`)
  rather than anchoring on the start of the full name. camelCase / PascalCase names
  are first normalized in two passes — an acronym→word split
  (`HRISCreateEmployee` → `HRIS_CreateEmployee`) then a lower/digit→upper split
  (`createEmployee` → `create_employee`, `v2CreateEmployee` → `v2_create_employee`) —
  so the same delimited-token match covers camelCase, acronym-prefixed, and
  digit-prefixed dialects. That keeps it portable across the known Gusto naming
  dialects:

  - **Official** (`snake_case`, no vendor prefix on most tools): every tool is a `list_*`
    / `get_*` read — none match, so the policy is a verified no-op there.
  - **StackOne aggregator** (`hris_*` unified action IDs): the exact tool-name strings
    are **not published verbatim** and are **unverified**, but StackOne's documented
    naming follows `hris_*` action IDs. The verb-token match catches the write/delete
    subset of those actions (`hris_create_*`, `hris_update_*`, `hris_delete_*`, and any
    `hris_*_create`/`_update`/`_delete` suffix form) while leaving `hris_get_*`/`hris_list_*`
    reads alone. Verify the exact strings your tenant's aggregator emits with the
    dump-input debug technique and pin them explicitly if you want name-exact denies.
  - **Community** (`kebab-case`, e.g. `get-all-employees`): the read tools do not match;
    the hyphen dialect of the write verbs (`create-`/`update-`/`delete-`) does.
  - **camelCase / dot-namespaced** (e.g. a Workato/Scalekit-style aggregator emitting
    `createEmployee`, `employeeCreate`, `HRISCreateEmployee`, `v2CreateEmployee`, or
    `svc.delete.payroll`): the camelCase / PascalCase boundary is normalized to an
    underscore — including where an acronym (`HRIS`) or version digit (`v2`) sits
    immediately before the verb's capital — and `.` is treated as a delimiter, so
    these write verbs are caught while camelCase reads (`getEmployee`,
    `HRISGetEmployee`, `listCreatedReports`) are not.

  The `submit` match is a substring (`*submit*`) because no official Gusto read tool
  contains that string; on write-capable servers it catches `submit_payroll`,
  `payroll_submit`, and `resubmit_payroll`.

  ## Argument shape

  This policy is **name-only** — it never inspects `input.payload.args`, so no argument
  key, encoding, or nesting can route a write past it. Every field it does read
  (`input.resource.name`) is fetched with `object.get` chains that resolve a missing
  resource or name to `""`, which fails closed to deny.

  ## Examples

  ### Allowed — official read tool, untouched

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-list_company_payrolls", "type": "tool" },
      "payload": { "name": "gusto-mcp-list_company_payrolls", "args": { "company_uuid": "abc" } }
    }
  }
  ```

  `allow = true`, no reason. (No write verb, no `submit`.)

  ### Denied — aggregator payroll deletion

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stackone-hris_delete_payroll", "type": "tool" },
      "payload": { "name": "stackone-hris_delete_payroll", "args": { "id": "pay_123" } }
    }
  }
  ```

  `allow = false`, reason says payroll mutations are frozen and to use the Gusto UI.

  ### Denied — bank-account create (hyphen dialect)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-create-bank_account", "type": "tool" },
      "payload": { "name": "gusto-mcp-create-bank_account", "args": {} }
    }
  }
  ```

  `allow = false`.

  ## Composition

  Single-purpose: this policy only freezes writes/deletes by tool-name shape. Useful
  companions on a Gusto pipeline:

  - **PF-09 money-movement cap** — a value-aware policy that denies/caps payroll runs and
    payouts above a ceiling or outside a finance IdP group. This freeze is the coarse
    destructive-ops half; the cap is the fine-grained transaction-authorization half.
    Compose them once the aggregator's write tool-name strings are verified per tenant so
    the cap can key on exact names and amount arguments.
  - **Egress PII/financial redaction** on Gusto read tools (salaries, home addresses,
    bank/routing numbers surfaced by community/aggregator servers).
  - **Ingress compensation/payroll read gating** by IdP group for need-to-know reads.

  ## Known limitations

  - **Aggregator tool names are unverified.** StackOne's exact MCP tool-name strings are
    not published verbatim; matching relies on the documented `hris_*` action-ID shape
    plus the create/update/delete verb tokens. If your aggregator uses a different verb
    vocabulary, the names slip past — verify with the dump-input technique and pin them.
  - **Verb vocabulary is scoped to create/update/delete/submit.** Other write-ish verbs
    (`void`, `cancel`, `approve`, `run`, `process`, `post`, `pay`, `remove`, `terminate`,
    `set`) are **not** matched. If your server exposes destructive actions under those
    verbs, add them to `write_verb_pattern` / the substring checks. This is deliberate:
    broadening the verb set raises false-positive risk against reads, so it is left as a
    per-tenant tuning step. (`submit` is caught, so `resubmit_payroll` is denied.)
  - **Delimiters and casing covered: `_`, `-`, `.`, camelCase, PascalCase, acronym- and
    digit-prefixed camelCase.** camelCase names are normalized to underscores before
    matching (a two-pass split that also breaks `acronym→word` and `digit→word`
    boundaries) and `.` counts as a delimiter, so `createEmployee`, `employeeCreate`,
    `HRISCreateEmployee`, `v2CreateEmployee`, and `svc.delete.payroll` are all denied.
    Residual slips remain for names where the verb is **fused with no word boundary at all**
    (e.g. `createbankaccount` — no delimiter and no case change after `create`) or where
    the tool name is **malformed** with an embedded/trailing newline (Go's `$` matches
    end-of-text only, so a trailing-position verb followed by `\n` escapes the
    `([._-]|$)` right anchor). Neither shape appears in any known Gusto server; if your
    aggregator produces them, pin exact tool names per tenant.
  - **Server-prefix collisions.** The verb-token match keys on delimiters, so an MCP
    server whose configured name itself contains `create`/`update`/`delete`/`submit` as a
    delimited token (e.g. a server literally named `gusto-update-mcp`) would match every
    call. Name your Gusto server without those verb tokens, or pin exact tool names.
  - **No identity exemption.** All callers are frozen equally. If you need a break-glass
    path for a finance/HR admin, add an `allow if` branch gated on
    `input.subject.claims.groups` (a placeholder group like `hr-payroll-admins`) — read
    it fail-closed with `object.get` chains so a missing claim never exempts.
  - **Name-only.** The policy does not inspect arguments, so it cannot distinguish a
    benign update from a destructive one within the same tool. That is intentional for a
    freeze — pair with PF-09 for value-aware allow/cap decisions.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - gusto
industries: []
bundles: []
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gusto.ingress.freeze_payroll_writes

# Deny-by-default: only the explicit allow rule below permits the request. A
# call whose name is missing entirely resolves to "" and never satisfies the
# allow rule, so it is denied rather than passed.
default allow := false

# Raw (original-case) tool name; missing resource/name resolves to "" (denied).
raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

# Normalize camelCase / PascalCase word boundaries to an underscore BEFORE
# lowercasing, so a camelCase dialect (createEmployee, employeeCreate,
# updateCompensation) reduces to the same delimited-token form as the snake/kebab
# dialects (create_employee, employee_create, update_compensation). Two passes are
# required so that an ACRONYM or DIGIT sitting immediately before the verb's
# capital letter still produces a boundary — a single `[a-z]->[A-Z]` pass leaves
# the verb glued to the acronym/digit (HRISCreateEmployee -> hriscreateemployee,
# v2CreateEmployee -> v2createemployee) and the write tool slips past the match:
#   1. acronym -> word boundary  (HRISCreateEmployee -> HRIS_CreateEmployee)
#   2. lower/digit -> upper       (HRIS_CreateEmployee -> HRIS_Create_Employee,
#                                  v2CreateEmployee -> v2_Create_Employee)
# Reads with leading acronyms (HRISGetEmployee -> hris_get_employee) are split the
# same way and still carry no write verb, so this adds no false positives.
_split_acronym := regex.replace(raw_tool_name, `([A-Z]+)([A-Z][a-z])`, "${1}_${2}")

tool_name := lower(regex.replace(_split_acronym, `([a-z0-9])([A-Z])`, "${1}_${2}"))

# Write/destructive verb tokens. Matches create/update/delete as a DELIMITED
# token anywhere in the (server-prefixed, camelCase-normalized) tool name — the
# underscore, hyphen, or dot dialect, and whether the verb leads the action id
# (create_employee, hris_create_employee) or trails it (hris_employee_create).
# Anchored on start-of-string or a `.`/`-`/`_` delimiter on the left and a
# delimiter or end-of-string on the right, so it will not match substrings like
# "created" or "updated" (the trailing letter is not a delimiter). No official
# Gusto read tool (all list_*/get_*) matches this.
write_verb_pattern := `(^|[._-])(create|update|delete)([._-]|$)`

is_write_shaped if {
    regex.match(write_verb_pattern, tool_name)
}

# Submit-shaped calls (payroll submission / money movement). Substring match
# per the `*submit*` spec — catches submit_payroll, payroll_submit, and
# resubmit_payroll. No official Gusto read tool contains "submit".
is_write_shaped if {
    contains(tool_name, "submit")
}

# Allow only a present, non-write-shaped tool name. An empty/missing name
# (tool_name == "") fails this and falls through to the default deny.
allow if {
    tool_name != ""
    not is_write_shaped
}

# Denied because the call is write-shaped (create/update/delete/submit).
reasons contains "Agent-initiated payroll writes and deletions are frozen by policy on this Gusto pipeline. Create, update, delete, and payroll-submit actions — including any wired through an aggregator such as StackOne — are blocked because they are money-movement-adjacent and effectively irreversible once a pay run processes. Make the change as a human in the Gusto UI. Contact your InfoSec team if this block is a false positive." if {
    is_write_shaped
}

# Denied because the call arrived without a recognizable tool name (fail-closed).
reasons contains "This Gusto call was denied because it arrived without a recognizable tool name. Retry with a valid Gusto tool, or make the change as a human in the Gusto UI. Contact your InfoSec team if this block is a false positive." if {
    tool_name == ""
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
