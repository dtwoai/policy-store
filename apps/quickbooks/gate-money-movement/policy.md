---
name: Gate QuickBooks Money-Movement by Finance Group
tags:
  - quickbooks
  - gate-money-movement
  - ingress
  - sox
  - pci-dss
publishedAt: 2026-07-12
description: |
  # quickbooks / gate-money-movement

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny for money-movement tools unless the caller is in a finance group and the amount is under the ceiling; allow everything else
  **Package:** `quickbooks.ingress.gate_money_movement`

  ## What it does

  Gates the QuickBooks Online money-movement creation tools — `create_payment`,
  `create_bill_payment`, `create_refund_receipt`, `create_transfer`, and
  `create_deposit` — behind two checks, applied in order:

  1. **Finance-group gate.** The call is denied unless the caller's IdP claims put
     them in the `finance` or `accounting` group. Everyone else (including callers
     with no group claim at all) is denied with a reason that points at the AP/AR
     owner in Finance.
  2. **Amount ceiling.** For in-group callers, the policy sums the transaction
     amount from the known candidate fields and denies when the total exceeds a
     configurable ceiling (default **$5,000**), so larger disbursements are routed
     through the human approval workflow instead of being initiated by an agent.

  Reads (`get_*` / `search_*` / reports) and non-money-movement writes
  (`create_invoice`, `create_customer`, `update_*`, etc.) pass through unchanged —
  this policy only touches the five disbursement tools above. Compose it with the
  finance-group write gate and the delete/void freeze for full coverage.

  ### Fail-closed amount extraction

  QBO money-movement payloads do not expose one canonical amount field. The official
  `create_invoice` shape, for example, has **no top-level total** — the amount must be
  summed from `line_items[].qty * unit_price` — and the payment tools' exact
  amount-field names are **not verified** in the landscape note. So the policy reads
  the amount from several candidate sources and takes the **maximum** of everything it
  finds:

  - top-level scalar keys: `amount`, `Amount`, `total`, `total_amt`, `TotalAmt`,
    `total_amount` (covers the snake_case official wrapper and the raw-QBO PascalCase
    variants);
  - the official line-item sum: `sum(line_items[].qty * unit_price)`;
  - the raw-QBO line sum: `sum(Line[].Amount)`.

  Taking the maximum is deliberate: as long as the real amount lands in one of the
  recognized fields above, a caller cannot slip a large disbursement past the ceiling by
  *also* including a small decoy `amount` field — the max still sees the real one. The
  ceiling is applied to the **largest absolute value** among the candidates, so a
  large *negative* amount (a reversal or credit that still moves money in magnitude)
  is denied just like the equivalent positive — it cannot slip under the positive
  ceiling. If
  **no** parseable amount is found in **any** candidate source, the policy **fails
  closed** — the call is denied and the caller is asked to route it through the approval
  workflow.

  This max-of-candidates guard has one residual (see *Known limitations*): if the
  server's true amount lives in a field name this policy does **not** recognize *and* the
  caller adds a small recognized decoy (e.g. `amount: 1`), extraction "succeeds" on the
  decoy and the call is allowed while the real, larger amount is never counted. The
  fail-closed deny only fires when *no* recognized field is present at all. This is why
  `amount_keys` and the line-item paths **must** be reconciled against your server's live
  schema before the ceiling can be trusted.

  ## Compliance alignment

  - **SOX — ITGC access to programs & data** (least-privilege access to financial
    systems, **Enforceable** via PF-09/PF-12): only finance/accounting identities can
    initiate money movement over the agent channel.
  - **SOX — Rule 13a-15(f)(3), safeguarding of assets** (**Enforceable** via
    PF-09/PF-10): the amount ceiling caps agent-initiated disbursements, limiting the
    blast radius of a compromised or misdirected agent.
  - **SOX — Rule 13a-15(f)(2)(ii), transaction authorization** (**Partial** via PF-09
    thresholds / PF-15): disbursements above the ceiling are forced onto the human
    approval workflow rather than being auto-authorized by the agent.
  - **SOC 2 CC6.3** (role-based access, least privilege, segregation of duties,
    **Enforceable** via PF-09/PF-12): the finance-group gate enforces a role boundary
    on the highest-risk QBO writes.
  - **PCI DSS Req 7.2.1 / 7.2.2 — least-privilege access model.** QuickBooks Online
    can process and store cardholder data — customer card payments and card refunds
    flow through `create_payment` / `create_refund_receipt` — so confining these
    money-movement tools to the finance/accounting role enforces a role-based,
    least-privilege access boundary on the card-touching disbursement operations over
    the agent channel (matrix PF-09 → 7.2.x).

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `quickbooks-mcp-create_payment`), and that prefix is not standardized. Matching is
  **case-insensitive** (`lower(input.resource.name)`) and **suffix-based**
  (`endswith`) on the five verb_entity names, so it stays portable across the Intuit
  official server, the Intuit Claude connector, and the LibreChat community server.
  Verify the exact tool names your gateway emits with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  Amounts are read from the candidate keys/paths listed under *Fail-closed amount
  extraction* above, always via `object.get(...)` with defaults, and coerced with
  `to_number` (so a non-numeric value simply doesn't count as a parseable amount).
  Group membership is read via `object.get(input.subject, "claims", {})` →
  `groups`, and matched case-insensitively against `finance` / `accounting`; a missing
  claims block yields no groups and therefore a deny.

  ## Examples

  ### Allowed — finance caller, under the ceiling

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-mcp-create_payment", "type": "tool" },
      "subject": { "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "quickbooks-mcp-create_payment",
        "args": { "customer_ref": "42", "amount": 1200 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — caller not in a finance group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-mcp-create_transfer", "type": "tool" },
      "subject": { "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "quickbooks-mcp-create_transfer",
        "args": { "amount": 300 }
      }
    }
  }
  ```

  `allow = false`, reason points at the AP/AR owner.

  ### Denied — finance caller, over the ceiling

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-mcp-create_bill_payment", "type": "tool" },
      "subject": { "claims": { "groups": ["accounting"] } },
      "payload": {
        "name": "quickbooks-mcp-create_bill_payment",
        "args": { "amount": 7500 }
      }
    }
  }
  ```

  `allow = false`, reason cites the $7500 total against the $5000 ceiling.

  ## Composition

  - **`quickbooks/role-gate-writes`** (PF-12) — the broader finance-group gate on all
    `create_*`/`update_*` writes; this policy narrows the disbursement subset with an
    amount ceiling on top.
  - **`quickbooks/freeze-destructive-ops`** (PF-06) — deny hard deletes/voids of
    transactions.
  - An **egress PII policy** on `get_employee`/`get_vendor` to mask SSN/bank fields.

  ## Known limitations

  - **Group names are placeholders — replace `finance` / `accounting` with your IdP's
    group names at import time.** Membership is read from `input.subject.claims.groups`;
    if your IdP emits roles under a different claim (e.g. Auth0 `permissions`, or a
    namespaced `https://acme.com/roles`), adjust `finance_groups` and the claim path.
  - **The ceiling is a constant.** Edit `amount_ceiling` in the Rego (default `5000`)
    to your organization's approval threshold; there is no per-request override.
  - **Amount-field names are unverified.** The candidate key list is derived from the
    official server's snake_case wrapper and the raw-QBO PascalCase shapes described in
    the landscape note, not from a verified live schema. Capture the live `tools/list`
    and a sample payload and extend `amount_keys` / the line-item paths if your server
    exposes the total under a different key. When a money-movement call carries **no**
    recognized amount field at all, extraction fails closed and the call is denied
    (safe). **Residual bypass:** if the real amount is in an unrecognized field *and* the
    caller also supplies a small recognized decoy (e.g. `amount: 1`), the decoy satisfies
    extraction and the call is allowed under the ceiling while the real amount goes
    uncounted. The max-of-candidates rule only defends across fields the policy already
    knows, so reconcile `amount_keys` / the line-item paths with the live schema before
    relying on the ceiling.
  - **Currency is ignored.** The ceiling is compared as a bare number; multi-currency
    companies should normalize before relying on the threshold. The ceiling bounds the
    **magnitude** (absolute value) of the total, so both large positive and large
    negative amounts are denied; a zero total (or a set of lines that nets to zero) is
    treated as no movement and passes.
  - **Suffix list is snake_case only.** Matching is `endswith` on the five
    `verb_entity` names (e.g. `create_payment`), which is portable across the surveyed
    servers (Intuit official, the Intuit Claude connector, and LibreChat — all
    snake_case). A server that named the same tool in camelCase (`createPayment`, no
    underscore) would **not** match the suffix and would pass through unchanged. This is
    not the case for any surveyed implementation, but confirm the exact tool strings your
    gateway emits with the dump-input technique before relying on this.
  - **The no-amount denial message hardcodes "$5,000".** If you change `amount_ceiling`,
    update that string too — only the over-ceiling reason interpolates the constant via
    `sprintf`; the no-amount reason is a fixed literal.
  - **Only the five `create_*` disbursement tools are gated.** The matching `update_*`
    tools (`update_payment`, `update_bill_payment`, `update_transfer`,
    `update_refund_receipt`, `update_deposit`) can also alter payee or amount on an
    existing disbursement, but they pass through this policy unchanged — for *any*
    caller, not just finance. That is by design (this policy owns the ceiling; the
    finance-group boundary on all writes belongs to `role-gate-writes`), but it means
    this policy alone does **not** stop a non-finance caller from mutating a payment via
    `update_*`. Deploy it together with `quickbooks/role-gate-writes`.
  - **Parameterized servers not covered.** The archived hvkshetry server exposes money
    movement through a single `transaction` tool with the verb in an `operation`
    argument; a suffix match on `create_*` does not see it, so such a call passes through
    unchanged. Add an argument-level rule (inspect `input.payload.args.operation` /
    `entity_type`) if that server is in scope.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - quickbooks
industries: []
bundles:
  - sox
  - pci-dss
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package quickbooks.ingress.gate_money_movement

# Deny-by-default: money-movement tools are only permitted by the explicit allow
# rules below. Non-money-movement tools are allowed by the pass-through rule.
default allow := false

# Configurable disbursement ceiling (USD). Edit to your approval threshold.
amount_ceiling := 5000

# IdP groups permitted to initiate money movement. Placeholders — replace with
# your IdP's group names at import time.
finance_groups := {"finance", "accounting"}

# Money-movement creation tools, matched case-insensitively by suffix so the
# gateway's server-name prefix (e.g. `quickbooks-mcp-`) doesn't matter.
money_movement_suffixes := [
    "create_payment",
    "create_bill_payment",
    "create_refund_receipt",
    "create_transfer",
    "create_deposit",
]

# Top-level scalar keys that may carry the transaction total. Covers the official
# snake_case wrapper and the raw-QBO PascalCase variants; unverified, so extraction
# fails closed if none match.
amount_keys := ["amount", "Amount", "total", "total_amt", "TotalAmt", "total_amount"]

is_money_movement_tool if {
    name := lower(input.resource.name)
    some suffix in money_movement_suffixes
    endswith(name, suffix)
}

# Caller is in a finance/accounting group. Reads claims via object.get and fails
# closed: no claims / no groups => not in group => denied.
caller_in_finance_group if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    some g in groups
    finance_groups[lower(g)]
}

# --- Candidate amounts (a set; take the max as the enforced total) ---

# Scalar top-level amount fields.
candidate_amounts contains n if {
    some key in amount_keys
    raw := object.get(input.payload.args, key, null)
    raw != null
    n := to_number(raw)
}

# Official line-item sum: sum(qty * unit_price). Only lines with both fields present
# and numeric contribute; if none do, no candidate is produced (fail closed).
candidate_amounts contains total if {
    items := object.get(input.payload.args, "line_items", [])
    count(items) > 0
    amounts := [(q * p) |
        some item in items
        raw_q := object.get(item, "qty", null)
        raw_p := object.get(item, "unit_price", null)
        raw_q != null
        raw_p != null
        q := to_number(raw_q)
        p := to_number(raw_p)
    ]
    count(amounts) > 0
    total := sum(amounts)
}

# Raw-QBO line sum: sum(Line[].Amount).
candidate_amounts contains total if {
    items := object.get(input.payload.args, "Line", [])
    count(items) > 0
    amounts := [a |
        some item in items
        raw_a := object.get(item, "Amount", null)
        raw_a != null
        a := to_number(raw_a)
    ]
    count(amounts) > 0
    total := sum(amounts)
}

amount_found if {
    count(candidate_amounts) > 0
}

# The enforced total is the largest-MAGNITUDE candidate found: we take the max of
# the absolute values so a large negative amount (e.g. a reversal that still moves
# money) cannot slip under the positive ceiling. Undefined when the set is empty,
# so any rule that references it fails closed.
total_amount := max([abs(c) | some c in candidate_amounts])

# --- Allow rules ---

# Everything that isn't a money-movement tool passes through (reads, reports,
# non-money-movement writes).
allow if {
    not is_money_movement_tool
}

# Money movement is allowed only for in-group callers whose parseable total is at
# or below the ceiling. If no amount was parsed, total_amount is undefined and this
# body fails => deny.
allow if {
    is_money_movement_tool
    caller_in_finance_group
    total_amount <= amount_ceiling
}

# --- Deny reasons ---

reasons contains "This QuickBooks money-movement tool is limited to callers in the finance or accounting group. Ask the AP/AR owner in Finance to run this disbursement, or request finance-group membership from your IdP administrator if this is a mistake." if {
    is_money_movement_tool
    not caller_in_finance_group
}

reasons contains "This money-movement call was denied because no transaction amount could be read from the request, so the $5,000 approval ceiling cannot be verified. Route this disbursement through the human approval workflow, or resend with an explicit amount if you believe this is a false positive." if {
    is_money_movement_tool
    caller_in_finance_group
    not amount_found
}

reasons contains msg if {
    is_money_movement_tool
    caller_in_finance_group
    amount_found
    total_amount > amount_ceiling
    msg := sprintf("This money-movement call totals $%v, which exceeds the $%v ceiling for agent-initiated disbursements. Route amounts above the ceiling through the human approval workflow.", [total_amount, amount_ceiling])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
