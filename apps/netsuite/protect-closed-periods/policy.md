---
name: Protect Financial Postings by Role
tags:
  - netsuite
  - protect-closed-periods
  - ingress
  - sox
publishedAt: 2026-07-12
description: |
  # netsuite / protect-closed-periods

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny financial-transaction writes unless the caller is in a finance/controller group; allow everything else
  **Package:** `netsuite.ingress.protect_closed_periods`

  ## What it does

  Denies the NetSuite record-write tools `ns_createRecord` and `ns_updateRecord`
  when they target a **financial-transaction record type** — `journalentry`
  (including the `intercompanyjournalentry`, `advintercompanyjournalentry`, and
  `statisticaljournalentry` variants, which all post to the GL), `vendorbill`,
  `vendorpayment`, `customerpayment`, `check`, or `creditmemo` — unless the
  caller carries a `finance` or `controller` group claim in
  `input.subject.claims.groups`. Every other tool call, and every write to a
  non-gated record type, passes through unchanged. The `recordType` value is
  lowercased and whitespace-trimmed before the gated-set lookup, so casing and
  padding tricks cannot dodge the gate.

  Posting or altering these records changes the general ledger. In a closed
  accounting period that is a restatement risk, and separating who may initiate
  a posting from who may approve it is core segregation-of-duties (SoD)
  territory. Enforcing the role gate at ingress means an over-broad OAuth role,
  an agent error, or a prompt-injection attempt can never post or overwrite a
  financial transaction on behalf of a caller who is not a finance or controller
  user — the write is blocked before it reaches NetSuite, so it has no ledger
  side effect.

  Because MCP tool arguments do **not** expose whether the target accounting
  period is actually closed, this is a **role-based proxy** for closed-period
  protection, not a period-state check — see Known limitations.

  ## Compliance alignment

  - **SOX §802 / 18 U.S.C. §1519 (anti-destruction/alteration of records)** —
    supports the prohibition on altering financial records by blocking agent-driven
    edits and postings of ledger transactions outside the finance/controller roles.
  - **SOC 2 PI1.5 (integrity of stored records)** — supports processing-integrity
    by keeping the agent channel from mutating posted financial transactions.
  - Reinforces the **segregation-of-duties** posture behind **SOX COSO Principle 10**
    and **SOC 2 CC6.3** (role-based access / least privilege / SoD): the caller's
    IdP group, not the breadth of their NetSuite role, decides whether a financial
    posting is permitted over MCP.

  ## Tool name matching

  The policy matches the two write tools by suffix on `lower(input.resource.name)`:

  - `*ns_createrecord`
  - `*ns_updaterecord`

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `netsuite-mcp-ns_createRecord`), and that prefix is not standardized.
  Matching on the `ns_*` suffix keeps the policy portable across the official
  Oracle AI Connector server and the dsvantien community proxy, which expose
  identical `ns_*` tool names and argument shapes. Verify the exact name your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  `ns_createRecord` and `ns_updateRecord` take `{ recordType: string, data: string }`
  (the `data` field is a JSON-encoded string of the record's fields). This policy
  only needs `recordType`, which it reads with `object.get(<args>, "recordType", "")`
  and matches **case-insensitively** against the gated set.

  `recordType` is read from both `input.payload.args` (the key the DTwo gateway
  schema documents) **and** `input.payload.arguments` (the key the NetSuite
  landscape note documents). The two containers are inspected **independently,
  not merged** — the gate fires if *either* container names a gated record type.
  This keeps the gate working whichever key the gateway populates and, crucially,
  prevents a decoy value in one container from hiding a gated `recordType`
  supplied in the other (a single-winner merge would fail open for a deny gate).
  Each container is coerced to `{}` if a gateway populates it with a scalar
  instead of an object, so a non-object container can neither type-error the read
  nor evade the gate. If your gateway uses a third key, capture it with the
  dump-input technique and add it to `arg_containers`.

  The `data` payload and the `ns_updateRecord` record-identifier field are not
  inspected — this control is purely about *which record type* is being written,
  not its contents.

  ## Identity

  The gate reads `input.subject.claims.groups` (an array) through
  `object.get` chains, so a missing subject or missing claim deterministically
  **fails closed**: no `finance`/`controller` group → the caller is not exempt →
  the gated write is denied. Group membership is compared case-insensitively and
  requires an exact group name (`finance` or `controller`); near-misses such as
  `financeadmin` do not match.

  ## Examples

  ### Allowed — finance user posts a journal entry

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_createRecord", "type": "tool" },
      "subject": { "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "netsuite-mcp-ns_createRecord",
        "args": { "recordType": "journalentry", "data": "{\"memo\":\"accrual\"}" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — non-financial record type

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_createRecord", "type": "tool" },
      "payload": {
        "name": "netsuite-mcp-ns_createRecord",
        "args": { "recordType": "customer", "data": "{\"companyName\":\"Acme\"}" }
      }
    }
  }
  ```

  `allow = true` — creating a customer is outside this policy's scope.

  ### Denied — non-finance caller updates a vendor bill

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_updateRecord", "type": "tool" },
      "subject": { "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "netsuite-mcp-ns_updateRecord",
        "args": { "recordType": "vendorbill", "data": "{\"amount\":9000}" }
      }
    }
  }
  ```

  `allow = false`, `reason = "NetSuite financial-transaction writes (recordType 'vendorbill') are restricted to finance and controller roles. ..."`.

  ## Composition

  This policy is single-purpose (role-gate the six ledger record types). Useful
  companions for NetSuite:

  - **`guard-vendor-banking`** (PF-10) — deny edits to vendor bank/payment
    details (anti-BEC); this policy deliberately does **not** gate `recordType == "vendor"`.
  - **`gate-money-movement`** (PF-09) — cap/deny payments and payouts outside
    finance groups.
  - **`default-deny-unknown-tools`** (PF-28) — mandatory on the
    `/services/mcp/v1/all` endpoint, where custom SuiteScript tools with arbitrary
    names could otherwise write financial records without triggering the `ns_*`
    suffix match here.
  - **`guard-warehouse-sql`** (PF-07) — constrain `ns_runCustomSuiteQL`.

  ## Known limitations

  - **Role proxy, not a period-state check.** MCP arguments do not expose whether
    the target accounting period is open or closed, so this policy cannot detect
    a genuinely closed period. It approximates closed-period protection by
    restricting *all* postings/edits of the gated record types to finance and
    controller roles. A finance user can still post into a closed period; pair
    with in-NetSuite period-close locking for the true control.
  - **Group names are placeholders — replace `finance` and `controller` with your
    IdP's group names at import time.** They are matched against
    `input.subject.claims.groups`; if your IdP emits roles under a different claim
    (e.g. `roles`, or a namespaced claim like `https://acme.com/roles`), adjust the
    `caller_in_finance_group` rule accordingly.
  - **Record-type key casing.** `recordType` is read from the exact `args` key
    `"recordType"` (the verified NetSuite parameter name). A client that sent the
    type under a differently-cased key would not populate NetSuite's `recordType`
    either, so the write would fail server-side rather than bypass the gate — but
    if you observe alternate casings in `dump-input`, widen the read to scan keys
    case-insensitively.
  - **Missing / omitted / malformed `recordType` passes.** A
    `ns_createRecord`/`ns_updateRecord` call with no readable `recordType` — or one
    supplied as a non-string (array/object) or with *internal* whitespace
    (`"journal entry"`), which stringifies to a value outside the gated set — is
    allowed, because none of those can create or update a gated
    financial-transaction record: NetSuite requires a well-formed string
    `recordType` and rejects the write server-side, so there is no ledger side
    effect. The gate fires only when a gated record type is actually named. (This
    is why leading/trailing padding *is* defeated via `trim_space` but interior
    corruption is not — a corrupted type never reaches the ledger.) See the
    `tests.yaml` cases covering an omitted `recordType` and an array-valued one.
  - **`groups` must be a JSON array.** The gate iterates `input.subject.claims.groups`
    with `some group in …`, so a `groups` claim emitted as a bare scalar string
    (`"finance"` rather than `["finance"]`) matches nothing and the caller is
    treated as **not** in a finance/controller group — the gated write is denied.
    This is fail-closed (safe) but can be a false positive for IdPs that flatten
    single-group claims to a string; normalize the claim to an array at the IdP or
    widen `caller_in_finance_group` to also accept a scalar `groups` value if your
    IdP emits one. See the `tests.yaml` case covering this.
  - **Gated set is a fixed enumeration — other posting transaction types are not
    covered.** The gate lists the journal-entry family plus the classic
    SoD-sensitive AP/AR types. Several *other* record types also post to the
    ledger and are deliberately **out of scope** here — notably `invoice`,
    `vendorcredit`, `customerrefund`, `deposit`, `cashsale`, `cashrefund`,
    `expensereport`, and `paycheck`. Gating all of them at ingress would produce
    heavy false positives on routine sales/AP flows, so this policy targets the
    postings most associated with closed-period restatement and journal
    manipulation. A non-finance caller can still create an `invoice` or
    `vendorcredit` over MCP. For fuller coverage pair with **`role-gate-writes`**
    (PF-12, read-only-by-default per app) and **`gate-money-movement`** (PF-09,
    refunds/payments). Add the extra record types to `gated_record_types` if your
    close process requires it. See the `tests.yaml` case covering `invoice`.
  - **`ns_updateRecord` identifier field is unverified.** Oracle's help page for the
    update record-identifier argument could not be fetched during research; this
    policy does not depend on it (it keys only on `recordType`), but confirm the full
    argument shape against a live connector before layering content-level rules on top.
  - **Standard tools only.** Custom SuiteScript MCP tools on `/services/mcp/v1/all`
    have arbitrary names and are not caught by the `ns_*` suffix match — combine with
    `default-deny-unknown-tools` (PF-28).
  - **Ingress write-gate only.** This policy does not restrict reads of financial
    data; use the egress redaction and SuiteQL policies for that.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - netsuite
industries: []
bundles:
  - sox
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package netsuite.ingress.protect_closed_periods

# Deny-by-default: financial-transaction writes are blocked unless the caller
# is explicitly in a finance/controller group. Every non-gated call is allowed
# by the first `allow` rule below.
default allow := false

# General-ledger record types whose creation/edit alters the books. Editing
# these after posting — or in a closed period — is a restatement risk, so they
# are gated behind a finance/controller role. Lowercase for case-insensitive
# matching against the request's recordType. The journal-entry family includes
# the intercompany / advanced-intercompany / statistical variants, which post
# to the GL exactly like a plain journalentry and would otherwise let a caller
# reroute a blocked "post a journal entry" request through an ungated type id.
gated_record_types := {
    "journalentry",
    "intercompanyjournalentry",
    "advintercompanyjournalentry",
    "statisticaljournalentry",
    "vendorbill",
    "vendorpayment",
    "customerpayment",
    "check",
    "creditmemo",
}

# IdP groups permitted to post/alter financial transactions. Placeholders —
# remap to the tenant's IdP group names at import time.
finance_groups := {"finance", "controller"}

# Tool name, lowercased and defensively defaulted. The gateway prefixes the
# configured server name, so match on the ns_ tool suffix for portability.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# The two NetSuite record-write tools.
is_financial_write if {
    endswith(tool_name, "ns_createrecord")
}

is_financial_write if {
    endswith(tool_name, "ns_updaterecord")
}

# Coerce a value to an object, defaulting to {} when it is not one. Keeps the
# recordType read below from type-erroring (which would leave a candidate
# undefined and silently disable the gate — a fail-open) if a gateway populates
# an argument container with a scalar instead of an object.
as_object(x) := x if is_object(x)

as_object(x) := {} if not is_object(x)

# Argument containers. The DTwo gateway schema documents tool arguments under
# `payload.args`; the NetSuite landscape note documents `payload.arguments`.
# We inspect BOTH independently rather than merging them into one object with a
# single winner: a merge (e.g. `object.union` with `arguments` winning) lets a
# decoy value in the winning container hide a gated recordType supplied in the
# losing one, which is fail-open for a deny gate. Gating on either container
# closes that hole regardless of which key the gateway actually populates.
arg_containers := [
    as_object(object.get(object.get(input, "payload", {}), "args", {})),
    as_object(object.get(object.get(input, "payload", {}), "arguments", {})),
]

# recordType read from a single container, stringified (so a stray numeric id
# can't type-error lower()), lowercased, and whitespace-trimmed. "" when
# recordType is absent. trim_space defeats leading/trailing-whitespace padding
# (e.g. " journalentry") that would otherwise miss the gated-set lookup.
record_type_in(container) := trim_space(lower(sprintf("%v", [object.get(container, "recordType", "")])))

# Every gated recordType named across either argument container. A non-empty
# set means the write targets a gated financial-transaction type; a decoy value
# in one container cannot suppress a gated value in the other.
gated_targets := {rt |
    some container in arg_containers
    rt := record_type_in(container)
    gated_record_types[rt]
}

# A gated write = a create/update that names a gated financial-transaction
# record type in either argument container.
is_gated_write if {
    is_financial_write
    count(gated_targets) > 0
}

# True only when the caller carries a finance or controller group claim.
# Uses object.get chains so a missing subject/claims/groups fails closed.
caller_in_finance_group if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    some group in object.get(claims, "groups", [])
    is_string(group)
    finance_groups[lower(group)]
}

# Allow anything that isn't a gated financial write.
allow if {
    not is_gated_write
}

# Allow gated financial writes only for finance/controller callers.
allow if {
    is_gated_write
    caller_in_finance_group
}

# Deny a gated write when the caller is not in a finance/controller group.
reasons contains msg if {
    is_gated_write
    not caller_in_finance_group
    msg := sprintf("NetSuite financial-transaction writes (recordType '%s') are restricted to finance and controller roles. Posting or altering ledger transactions — especially in a closed accounting period — is a restatement risk, so segregation-of-duties controls gate this action. Ask a finance or controller colleague to make the change, or request the appropriate group membership from your finance systems administrator if you believe this is a false positive.", [concat(", ", sort(gated_targets))])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
