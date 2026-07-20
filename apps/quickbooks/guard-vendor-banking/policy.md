---
name: Guard Vendor Banking and Tax-ID Changes
tags:
  - quickbooks
  - vendor-banking
  - anti-bec
  - ingress
  - sox
publishedAt: 2026-07-12
description: |
  # quickbooks / guard-vendor-banking

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `quickbooks.ingress.guard_vendor_banking`

  ## What it does

  Blocks `create_vendor` and `update_vendor` calls whose arguments carry a
  vendor's **payment coordinates** — bank account number, routing / ACH branch
  details — or its **tax identity** — the EIN/SSN used for 1099 reporting. Any
  vendor create/update that touches one of these fields is denied at ingress,
  before it reaches the QuickBooks MCP server, so the change never lands in the
  books of record.

  Silently repointing a vendor's bank account is the core **business-email-
  compromise (BEC)** vector: an injected agent instruction that rewrites a
  vendor's ACH details quietly reroutes every future payment to that vendor to
  an attacker-controlled account. Because the mutation looks like an ordinary
  vendor edit, it is easy to miss in a review of agent activity — so the gateway
  refuses it outright and points the caller at the human, dual-approval path in
  QuickBooks.

  Non-banking vendor edits — display name, print-on-check name, payment terms,
  email, phone, billing address — pass through unchanged. Vendor
  deletes/deactivations are **out of scope here**; they are covered by the
  companion `freeze-destructive-ops` policy.

  ## Compliance alignment

  - **SOX — Exchange Act Rule 13a-15(f)(3) (17 CFR §240.13a-15), safeguarding of
    assets.** Preventing unauthorized change to a vendor's payment coordinates
    is a direct "prevent or timely detect unauthorized … disposition of assets"
    control on the agent path — a rerouted ACH account is asset disposition to
    an unauthorized party. The gateway logs every attempt with a deny reason.
  - **SOX — COSO 2013 Principle 10 (segregation of duties).** Blocking the agent
    from setting vendor banking/tax details keeps the "who can change where money
    goes" step in a human, dual-approval lane rather than letting an agent both
    initiate and effect it.
  - **SOC 2 CC6.1 (logical access controls) / PI1.5 (integrity of stored records).**
    Denying agent-initiated changes to a vendor's payment coordinates and tax
    identity is a logical-access boundary that prevents unauthorized modification of
    financial master data over the agent channel, supporting the integrity of the
    vendor records QuickBooks holds.

  This policy addresses the PF-10 family (`guard-vendor-banking`) row of the
  coverage matrix (SOX §2.5, Rule 13a-15(f)(3)).

  ## Tool name matching

  The policy matches the vendor create/update tools by suffix on the
  **separator-normalized** tool name — `input.resource.name` lowercased with
  underscores, hyphens, and spaces stripped:

  - `*createvendor` (matches `create_vendor`, `createVendor`, `create-vendor`)
  - `*updatevendor` (matches `update_vendor`, `updateVendor`, `update-vendor`)

  Normalizing the tool name means a server that uses camelCase or hyphenated
  tool names cannot silently bypass the policy (a plain `endswith` on
  `create_vendor` would miss `createVendor` and no-op the whole policy). Matching
  the `createvendor` / `updatevendor` verb+entity suffix still targets the
  **`_vendor` entity** while `create_vendor_credit` / `update_vendor_credit` (a
  *different* entity, normalizing to `...vendorcredit`, ending in `credit`) is
  naturally excluded, and vendor **reads** (`get_vendor`, `search_vendors`) and
  **deletes** (`delete_vendor`) fall through to `allow` — deletes are handled by
  `freeze-destructive-ops`, not here.

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `qbo-mcp-create_vendor`), and that prefix is not standardized — suffix matching
  keeps the policy portable. Verify the exact names your gateway sends with a
  live `tools/list` (or the dump-input debug technique) before relying on this in
  production.

  ## Argument shape

  The policy inspects **field names** in `input.payload.args`, recursively
  (including nested objects), and normalizes each key (lowercase, underscores /
  hyphens / spaces removed) so it matches both server conventions:

  - **Intuit official server** — snake_case wrapper keys, e.g.
    `bank_account_number`, `routing_number`, `tax_identifier`,
    `vendor_payment_bank_detail`.
  - **LibreChat community server** — raw-QBO PascalCase keys, e.g.
    `BankAccountNumber`, `BankBranchIdentifier`, `TaxIdentifier`,
    `VendorPaymentBankDetail`.

  Normalization collapses both to the same token (`bankaccountnumber`,
  `taxidentifier`, …), so the single `sensitive_fields` allowlist covers both
  shapes. As a defense-in-depth second branch, the policy also denies when any
  string value in the payload is shaped like a US tax identifier (SSN
  `123-45-6789` or EIN `12-3456789`) — this catches a tax ID smuggled under a
  benign key.

  > **The exact QBO Vendor bank/tax field keys are not verified** in the app
  > landscape note. Treat `sensitive_fields` as a documented **candidate
  > allowlist to confirm against a live `tools/list`** for your server, and tune
  > it to the keys your deployment actually emits (see Known limitations).

  ## Examples

  ### Allowed — non-banking vendor edit

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "qbo-mcp-update_vendor", "type": "tool" },
      "payload": {
        "name": "qbo-mcp-update_vendor",
        "args": { "id": "56", "display_name": "Acme Supplies", "terms_ref": "NET30" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — bank account on a vendor create

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "qbo-mcp-create_vendor", "type": "tool" },
      "payload": {
        "name": "qbo-mcp-create_vendor",
        "args": {
          "display_name": "New Vendor LLC",
          "bank_account_number": "000123456789",
          "routing_number": "021000021"
        }
      }
    }
  }
  ```

  `allow = false`, reason names the BEC risk and the dual-approval path.

  ## Composition

  This policy is single-purpose. Useful companions on the same QuickBooks
  gateway:

  - [`freeze-destructive-ops`](../../../bundles/sox/README.md) — denies
    `delete_vendor` (deactivation) and other destructive verbs.
  - `gate-money-movement` (PF-09) — caps/denies `create_payment` /
    `create_bill_payment` so a mis-set vendor cannot be paid at scale.
  - `role-gate-writes` (PF-12) — restricts all vendor writes to a finance IdP
    group as the least-privilege baseline.
  - An egress PII/DLP policy that redacts SSN/EIN/bank-account values from
    `get_vendor` / `search_vendors` responses.

  ## Known limitations

  - **Field-name allowlist is unverified.** The exact QuickBooks Vendor
    bank/tax field keys are not confirmed in the landscape note. `sensitive_fields`
    is a candidate list — confirm it against a live `tools/list` and add any keys
    your server uses (some servers may nest bank details under a container object
    with a name not in the list). Missing a key means that field is **not**
    blocked.
  - **Shapeless values in free-text fields.** A bank account number pasted into a
    benign free-text field (e.g. `print_on_check_name`, `notes`, a QBO
    `CustomField` `StringValue`, or a stringified-JSON blob whose keys are not
    real object keys) has no fixed shape and no sensitive key name, so it is
    **not** caught — only the tax-ID value branch (SSN/EIN shapes) inspects
    values, and the field-name branch inspects only real object keys, not the
    contents of a string. Pair with an egress DLP policy for the read path if
    this residual matters.
  - **Field-name matching is exact on the normalized token, not substring.** The
    banking-synonym list was broadened after red-team review (adds `bankaccountno`,
    `accountno`, `aba`/`abanumber`/`abaroutingnumber`, `wireroutingnumber`,
    `iban`, `swift`/`swiftcode`, `bic`, `sortcode`), but a key must normalize to a
    token that is *exactly* in the set — a novel key such as
    `vendor_bank_acct_number` (normalizes to `vendorbankacctnumber`) will not
    match. Confirm the keys your server actually emits and extend the list.
  - **Tax-ID value branch can over-block.** The dash-delimited value regex will
    also fire on a benign value that happens to share the SSN (`\d{3}-\d{2}-\d{4}`)
    or EIN (`\d{2}-\d{7}`) grouping — e.g. a foreign registration number or an
    oddly-formatted reference. Because this is a deny policy the over-block is
    fail-safe (the caller is pointed at finance), but tune the pattern or the
    scope if legitimate dash-delimited values in your data collide.
  - **Tax-ID value regex is US-shaped and dash-delimited only.** The value branch
    matches the **dash-delimited** US SSN (`123-45-6789`) and EIN (`12-3456789`)
    formats only. A tax ID written **without separators** (`123456789`) or with
    **spaces** (`123 45 6789`) under a benign free-text key is **not** caught by
    the value branch — matching bare 9-digit runs would over-block every order
    number, phone, and quantity, so the pattern is deliberately conservative.
    Non-US tax identifiers are likewise caught only by field name. This is
    defense-in-depth behind the field-name allowlist, which remains the primary
    control; pair with an egress DLP policy if the read path matters.
  - **Parameterized / mega-tool servers are not covered.** This policy matches on
    the `create_vendor` / `update_vendor` tool-name suffix, which fits the Intuit
    official server and the LibreChat community server (`verb_entity` naming). It
    does **not** cover servers that expose a single parameterized tool and carry
    the verb+entity in an argument — e.g. the archived `hvkshetry/quickbooks-mcp`
    `party` tool called as `party(operation="update", party_type="vendor", …)`.
    Such a call has a tool name (`party`) that matches neither suffix, so banking
    and tax fields in its arguments pass through unblocked. If your deployment
    uses a parameterized server, add a companion policy that inspects the
    `operation` / `party_type` (or equivalent) arguments; a suffix-matching
    policy alone cannot see the verb.
  - **No identity-based exemptions.** All callers are subject to the same check.
    To allow a break-glass finance controller to set banking details via the
    agent, add an `allow if` branch gated on `input.subject.claims.groups`
    (group names are placeholders — replace with your IdP's group name at import
    time).
  - **Reads and deletes are out of scope.** Vendor reads pass through; vendor
    deletes/deactivations are governed by `freeze-destructive-ops`.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - quickbooks
industries: []
bundles:
  - sox
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package quickbooks.ingress.guard_vendor_banking

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Normalized (lowercase, no separators) vendor field-name tokens that carry
# banking or tax-identity data. CANDIDATE LIST — the exact QBO Vendor keys are
# not verified; confirm against a live tools/list and tune per deployment.
# Normalization collapses snake_case (official server) and PascalCase
# (LibreChat raw-QBO) to the same token, so one list covers both conventions.
sensitive_fields := {
    # --- Banking / ACH payment coordinates ---
    "bankaccountnumber",
    "accountnumber",
    "bankaccount",
    "routingnumber",
    "bankroutingnumber",
    "achroutingnumber",
    "bankbranchidentifier", # QBO routing/branch identifier
    "vendorpaymentbankdetail", # QBO nested bank-detail container
    "bankaccountdetail",
    "achenabled",
    # Common banking-identifier synonyms / abbreviations and intl. equivalents
    # (added after red-team review — all are bank routing/account identifiers,
    # not plausible benign vendor field names).
    "bankaccountno",
    "accountno",
    "aba",
    "abanumber",
    "abaroutingnumber",
    "wireroutingnumber",
    "iban",
    "swift",
    "swiftcode",
    "bic",
    "sortcode",
    # --- Tax identity (EIN/SSN for 1099) ---
    "taxidentifier", # QBO TaxIdentifier -> tax_identifier
    "taxid",
    "taxidentificationnumber",
    "taxregistrationnumber",
    "ein",
    "ssn",
    "tin",
}

# US tax-identifier value shapes: SSN 123-45-6789 or EIN 12-3456789.
# Anchored with word boundaries to stay conservative (won't match a longer
# digit run). Catches a tax ID smuggled under a non-sensitive key name.
tax_id_value_pattern := `\b(\d{3}-\d{2}-\d{4}|\d{2}-\d{7})\b`

# Tool arguments, safely defaulted so a missing `args` yields an empty object
# rather than a rule-body failure.
args := object.get(input.payload, "args", {})

# Normalize a field name: lowercase and strip underscores, hyphens, spaces so
# `bank_account_number` and `BankAccountNumber` compare equal.
normalize(key) := lower(regex.replace(key, `[_\-\s]`, ""))

# Vendor create/update tools. We match on the SEPARATOR-NORMALIZED tool name
# (lowercase + underscores/hyphens/spaces stripped) so `create_vendor`,
# `createVendor`, and `create-vendor` all match — otherwise a server using
# camelCase or hyphenated tool names would silently bypass the whole policy.
# Matching the `createvendor` / `updatevendor` suffix targets the `_vendor`
# entity and still naturally excludes `create_vendor_credit` /
# `update_vendor_credit` (normalizes to `...vendorcredit`, ends in `credit`)
# and `delete_vendor` / `get_vendor` / `search_vendors`.
is_vendor_write if {
    endswith(normalize(input.resource.name), "createvendor")
}

is_vendor_write if {
    endswith(normalize(input.resource.name), "updatevendor")
}

# True if any argument key (at any depth) is a banking/tax-identity field.
banking_field_present if {
    walk(args, [path, _])
    some key in path
    is_string(key)
    sensitive_fields[normalize(key)]
}

# True if any string value (at any depth) is shaped like a US tax identifier.
tax_id_value_present if {
    walk(args, [_, value])
    is_string(value)
    regex.match(tax_id_value_pattern, value)
}

# Allow anything that isn't a vendor create/update call (reads, deletes,
# vendor-credit tools, and every non-vendor tool).
allow if {
    not is_vendor_write
}

# Allow vendor create/update only when no banking/tax field or tax-ID-shaped
# value is present.
allow if {
    is_vendor_write
    not banking_field_present
    not tax_id_value_present
}

reasons contains "Creating or updating a vendor with bank-account, routing/ACH, or tax-identity (EIN/SSN) fields is blocked at the gateway. Silently repointing a vendor's payment coordinates is the primary business-email-compromise (BEC) vector: a rerouted bank account diverts every future ACH payment. Change vendor banking or tax-ID details directly in QuickBooks under dual approval, or ask your finance/AP administrator to make the change or grant an exception." if {
    is_vendor_write
    banking_field_present
}

reasons contains "This vendor create/update carries a value shaped like a US tax identifier (SSN or EIN). Tax IDs for 1099 vendors must be set in QuickBooks under finance review, not through the agent. Contact your finance/AP administrator if this change is legitimate." if {
    is_vendor_write
    tax_id_value_present
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
