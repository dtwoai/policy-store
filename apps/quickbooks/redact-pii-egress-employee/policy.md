---
name: "QuickBooks: Redact Employee & Vendor PII on Read"
tags:
  - quickbooks
  - redact-pii
  - pii
  - redaction
  - dlp
  - egress
  - gdpr-ccpa
  - soc2
publishedAt: 2026-07-12
description: |
  # quickbooks / redact-pii-egress-employee

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `quickbooks.egress.redact_pii_employee`

  ## What it does

  On the read path, this policy masks sensitive identifiers in the responses of
  four QuickBooks Online (QBO) name-entity read tools — `get_employee`,
  `search_employees`, `get_vendor`, and `search_vendors` — before the response
  reaches the agent. QBO Employee records carry an SSN, a home address, and pay
  data; QBO Vendor records can carry bank-account and tax-ID (EIN) details used
  for ACH bill-pay and 1099 reporting. Those fields are rewritten to a fixed
  redaction token (`[REDACTED]`) in the response so an out-of-group agent never
  receives them.

  The redaction happens **only in the response returned to the caller** — the
  underlying QBO record is untouched. All other tools, and responses with none
  of the targeted fields, pass through byte-identical. The policy is
  transform-only (`default allow := true`): it never denies a call.

  ### Group exemption (fails closed)

  Callers whose IdP `groups` claim contains `hr` or `finance` (placeholder
  names — see Known limitations) receive the **unredacted** response. Group
  membership is read via an `object.get` chain rooted at
  `object.get(input.subject, "claims", {})`: a missing subject, missing claims,
  or missing/`non-array` `groups` claim means the caller is *not* exempt and
  redaction applies. The grant **fails closed** — no group means redaction.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in QBO
    Employee/Vendor records as they leave the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the read path; **P4.1** — supports limiting personal
    information use to identified purposes by keeping direct identifiers out of
    agent context that doesn't need them; **P6.1** — supports controlling
    disclosure of personal information by masking it before it reaches the
    agent channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data:
    only placeholder `hr`/`finance` members see raw identifiers, everyone else
    gets working records with SSN/address/bank/EIN masked.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing by
    keeping high-value identifiers (SSN, bank account, EIN) out of the agent
    channel.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information; under CPRA, SSN and financial-account
    numbers are expressly sensitive PI.

  ## Why egress

  The PII already lives in QBO — there is nothing to block at ingress, and
  denying the read outright would make Employee/Vendor records unusable for
  legitimate agent tasks (e.g. reconciling a vendor by name). The leak happens
  when the record is returned to the MCP client, so the response path is the
  only place to mask the identifiers while keeping the rest of the record
  usable.

  ## Tool name matching

  Applies on the output path — scoped when **any** of the three egress signals
  holds: `input.mode == "output"`, the PARC `input.action == "tool_post_invoke"`,
  or the legacy `input.kind == "tool_post_invoke"`. Keying on only a subset
  fails open (redaction no-ops, leaking PII) on a build that populates a
  different one — an older gateway near the minimum version may emit only the
  legacy `kind`. Tools are matched case-insensitively **by
  suffix**, so the policy works regardless of the MCP server-name prefix the
  gateway adds (`quickbooks-mcp-…`, `qbo-prod-…`, etc.). The tool name is read
  from all three egress surfaces — `input.resource.name`,
  `input.tool_metadata.name`, and `input.payload.name` — and a suffix hit on
  **any** of them puts the call in scope.

  Matched suffixes (Intuit official `verb_entity` vocabulary; the Claude
  connector is assumed to share it — see Known limitations):

  - `get_employee`
  - `search_employees`
  - `get_vendor`
  - `search_vendors`

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production.

  ## Response / field shape

  Redaction is applied by the gateway from this policy's `transform` object,
  which combines two mechanisms (see the DTwo transform reference):

  - **`redact_fields`** — QBO object keys matched case-insensitively and
    recursively, so listing a top-level key (e.g. `PrimaryAddr`) also masks its
    nested values (`Line1`, `City`, `PostalCode`, …). Covers SSN, home address,
    and pay data on Employee; tax ID, bank account, and ACH bank detail on
    Vendor.
  - **`redact_patterns`** — field-name-agnostic regex backstops for the two
    highest-signal identifier shapes (US SSN `XXX-XX-XXXX`, US EIN
    `XX-XXXXXXX`), so a value carried under an unexpected key is still masked.

  Both are keyed to the exact QBO object shapes, which the landscape research
  does **not** verify — confirm the field names against a live sample response
  before production use (see Known limitations).

  ## Examples

  ### Redacted (Employee read, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "quickbooks-mcp-get_employee", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["sales"] } },
      "payload": {
        "name": "quickbooks-mcp-get_employee",
        "text": ["{\"Employee\":{\"SSN\":\"123-45-6789\",\"PrimaryAddr\":{\"Line1\":\"1 Main St\"}}}"]
      }
    }
  }
  ```

  `allow = true`, with `transform` present: the gateway masks the `SSN` and
  `PrimaryAddr` fields (and the SSN pattern) to `[REDACTED]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "quickbooks-mcp-get_vendor", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "quickbooks-mcp-get_vendor",
        "text": ["{\"Vendor\":{\"TaxIdentifier\":\"12-3456789\"}}"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `finance` group receives the raw record.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny policies on the same egress pipeline. Recommended
  companions in `apps/quickbooks`:

  - **A finance-group write gate** (ingress) so redacted-on-read records
    aren't simply re-created or exfiltrated through a write.
  - **A bulk-export throttle** on `search_*` (ingress) that strips `fetchAll`
    and caps `limit`, so a non-exempt caller can't pull the entire
    employee/vendor roster in one call and dilute the value of per-record
    masking.

  ## Known limitations

  - **QBO field names are unverified.** The `redact_fields` list uses the QBO
    v3 object shapes (`SSN`, `PrimaryAddr`, `BillRate`, `TaxIdentifier`,
    `AcctNum`, `BankAccountNumber`, `BankBranchIdentifier`,
    `VendorPaymentBankDetail`), but the landscape note does not verify the JSON
    keys the MCP server actually returns. **Confirm the field paths against a
    live sample response before production use** and add any deployment-specific
    keys. The SSN/EIN `redact_patterns` are a shape-based backstop for values
    under unexpected keys, but they only catch the canonical hyphenated forms.
    The field list is intentionally scoped to **high-value identifiers** (SSN,
    home address, pay, tax ID, bank/ACH detail). Other personal data these
    records carry — employee/vendor **email** (`PrimaryEmailAddr`), **phone**
    (`PrimaryPhone`/`Mobile`), and **date of birth** (`BirthDate`) — is *not*
    in `redact_field_names` and does not match the SSN/EIN patterns, so it
    passes through to a non-exempt caller. This is a minimum-necessary layer,
    not blanket PII redaction; add those keys to `redact_field_names` if your
    minimisation obligation requires masking them too.
  - **Redaction is scoped to four name-entity read tools.** Field- *and*
    pattern-redaction fire only for `get_employee` / `search_employees` /
    `get_vendor` / `search_vendors`. The same SSN/EIN/bank identifier reaching
    the agent through a **different** read surface — a financial report
    (General Ledger, Vendor Expenses), `get_company_info`, or
    `get_attachable`/`search_attachables` (attachment notes can embed a scanned
    W-9/W-4 with an SSN/EIN) — is **not** masked, because the transform (and
    therefore the pattern backstop) is never emitted for out-of-scope tools.
    Pair this policy with a report/attachable read gate or a broader
    all-tools `redact_patterns` egress policy if those surfaces are reachable.
  - **Tool names assumed for the Claude connector.** The Intuit official server
    uses the `verb_entity` names above; the Anthropic-directory "Intuit
    QuickBooks" connector does not publish its tool names, so they are treated
    as *unverified* — capture the live `tools/list` through the gateway and add
    exact suffixes if they differ. The parameterized community server
    (`hvkshetry/quickbooks-mcp`, archived) exposes a single `party` tool with a
    `party_type` argument and is **not** matched by these suffixes.
  - **Pattern detection is best-effort.** Obfuscated, spelled-out, split, or
    non-hyphenated identifiers are not caught by `redact_patterns`; over-broad
    matches (a 9-digit EIN-shaped run that is not an EIN) can be over-redacted.
    Treat this as a high-signal minimum-necessary layer, not a complete DLP
    solution.
  - **Group names are placeholders — replace `hr` and `finance` with your
    IdP's group names at import time.** The exemption is granted only for a
    `groups` claim shaped as an array of strings (a single bare string is also
    handled). Any other shape fails closed → redaction applies: a missing
    subject/claims/`groups`, an object/map (e.g. a namespaced claim like
    `{"department": "finance"}`), and nested/non-string array elements are all
    treated as *not exempt*. If your IdP emits roles under a namespaced claim,
    adjust `caller_groups` to point at the array before matching.
  - **Egress redaction only.** This masks what the agent reads; it does not stop
    an exempt caller from re-sharing raw data, nor does it touch the web-UI or
    native-API paths into QBO.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - quickbooks
industries: []
bundles:
  - gdpr-ccpa
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package quickbooks.egress.redact_pii_employee

# Transform-only egress policy: rewrites Employee/Vendor PII in QuickBooks
# Online name-entity read responses to a fixed redaction token before the
# response reaches the agent. Never denies. Callers in an exempt IdP group
# (hr/finance) receive unredacted responses.
default allow := true

# -----------------------------------------------------------------------------
# Scope: QBO name-entity read tools whose responses carry Employee/Vendor PII.
# Suffix matching keeps the policy portable across gateway server-name prefixes.
# Names follow the Intuit official `verb_entity` vocabulary; the Claude
# connector is assumed to share it (unverified — see Known limitations).
# -----------------------------------------------------------------------------

pii_read_suffixes := {
    "get_employee",
    "search_employees",
    "get_vendor",
    "search_vendors",
}

# Egress scope: match the post-invoke/output path on ANY of the three egress
# signals the gateway may populate — mode ("output"), the PARC action, or the
# legacy `kind` alias. Keying on only a subset fails open (redaction no-ops,
# leaking PII) on a build that populates a different one: an older gateway near
# the minimum version may emit only the legacy `kind` while leaving `action`/
# `mode` unset. Ingress (tool_pre_invoke / mode "input") satisfies no branch.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

is_egress if { input.kind == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a targeted suffix — matching only a subset would let a gateway that
# populates a different surface slip a record past the scanner.
candidate_names contains lower(object.get(input.resource, "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

is_pii_read_tool if {
    is_egress
    some suffix in pii_read_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP groups whose members receive unredacted
# responses. Replace "hr" / "finance" with your IdP's group names at import
# time. Group membership is read via an object.get chain rooted at
# object.get(input.subject, "claims", {}): a missing subject/claims/groups
# claim is never exempt — the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"hr", "finance"}

caller_groups := object.get(object.get(input.subject, "claims", {}), "groups", [])

is_exempt if {
    # Only a flat array of group strings grants the exemption. The is_array guard
    # is load-bearing: `some g in caller_groups` over an OBJECT iterates its
    # values, so a namespaced/metadata claim like {"department": "finance"} would
    # else wrongly exempt the caller. is_string(g) keeps nested/non-string
    # elements from matching. Anything but a clean array of strings fails closed.
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    lower(g) in exempt_groups
}

is_exempt if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) in exempt_groups
}

# -----------------------------------------------------------------------------
# Redaction instruction. QBO object keys carrying Employee/Vendor PII, matched
# case-insensitively and recursively by the gateway (so a top-level key also
# masks its nested values, e.g. PrimaryAddr.{Line1,City,PostalCode}). These key
# names are the QBO v3 object shapes and are NOT verified in the landscape note
# — confirm against a live sample response before production use.
# -----------------------------------------------------------------------------

redact_field_names := [
    # Employee PII
    "SSN", # Social Security Number
    "PrimaryAddr", # home / primary address (structured sub-object)
    "BillRate", # pay / billing rate
    # Vendor PII
    "TaxIdentifier", # EIN / tax ID (1099)
    "AcctNum", # vendor-assigned account number
    "BankAccountNumber", # ACH bank account
    "BankBranchIdentifier", # ACH routing / branch
    "VendorPaymentBankDetail", # ACH bank-detail sub-object
]

# Field-name-agnostic backstops for the two highest-signal identifier shapes,
# so a value carried under an unexpected key is still masked. Anchored to the
# canonical hyphenated forms to limit false positives.
redact_patterns_list := [
    `\b\d{3}-\d{2}-\d{4}\b`, # US SSN, canonical XXX-XX-XXXX form
    `\b\d{2}-\d{7}\b`, # US EIN, canonical XX-XXXXXXX form
]

# Transform — emitted only when this is a targeted read tool on the egress path
# and the caller is not exempt. Otherwise the rule is undefined and the
# aggregator skips this policy, returning the response unchanged.
transform := {
    "redact_fields": redact_field_names,
    "redact_patterns": redact_patterns_list,
    "replacement": "[REDACTED]",
} if {
    is_pii_read_tool
    not is_exempt
}
```
