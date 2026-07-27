---
name: NetSuite Guard Vendor Banking Edits (Anti-BEC)
tags:
  - netsuite
  - guard-vendor-banking
  - ingress
  - sox
publishedAt: 2026-07-12
description: |
  # netsuite / guard-vendor-banking

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny vendor banking/payment edits; allow everything else
  **Package:** `netsuite.ingress.guard_vendor_banking`

  ## What it does

  Instantiates policy family **PF-10 (guard-vendor-banking)** — the anti-BEC /
  payment-fraud control — for the Oracle NetSuite MCP Standard Tools SuiteApp.

  It denies `ns_createRecord` and `ns_updateRecord` calls when **both**:

  1. the `recordType` argument is `vendor` (case-insensitive), and
  2. the record's `data` payload contains a bank or payment-instruction field —
     a bank account number (including payment-context `*Account` fields such as
     `payeeAccount`), routing / ABA number, sort code, bank number/id, IBAN,
     SWIFT / BIC code, or a payment-method / EFT change.

  Vendor banking details are the classic business-email-compromise (BEC) fraud
  vector: once an agent (or an agent following a poisoned instruction) points a
  vendor's payments at an attacker-controlled account, the change is externally
  visible and effectively irreversible the moment a payment run executes. So the
  policy blocks **all callers by default**. An optional allowlisted IdP group —
  `ap-manager` — may perform legitimate vendor bank maintenance through the
  agent; everyone else is denied.

  Because `data` is a **JSON-encoded string** (not a nested object), the policy
  decodes it with `json.unmarshal(object.get(<args>, "data", "{}"))` before
  inspecting field names. Field-name matching walks the decoded object
  recursively, so bank fields nested inside sublists are still caught. All
  non-vendor writes, non-banking vendor edits, and read tools pass through
  unchanged; the check runs at ingress, before the call reaches NetSuite, so a
  blocked edit never touches the vendor master.

  ## Compliance alignment

  - **SOX Rule 13a-15(f)(3) — safeguarding of assets.** Directly the PF-10 row:
    blocking unattended agent edits to vendor payment routing removes the single
    highest-value payment-fraud lever from the agent channel.
  - **SOX ITGC (access to programs and data).** Supports least-privilege access
    to a financial system — a high-risk write is confined to a named AP role
    rather than every OAuth-connected user's day-job NetSuite role.
  - **SOC 2 CC6.3 — role-based access, least privilege, and segregation of
    duties.** Vendor bank maintenance through the agent is restricted to the
    `ap-manager` group; all other callers are separated out.
  - **SOC 2 CC6.1 — logical access security over protected assets.** The vendor
    master (payment-routing data) is a protected asset; the policy applies a
    default-deny boundary to its banking fields on the agent path.

  ## Tool name matching

  Matched by suffix on `lower(input.resource.name)`, so the gateway's
  server-name prefix (e.g. `netsuite-mcp-`) does not matter:

  - `*ns_createrecord` — official MCP Standard Tools SuiteApp `ns_createRecord`
    and the `dsvantien/netsuite-mcp-server` community proxy (identical names).
  - `*ns_updaterecord` — `ns_updateRecord` on the same servers.

  The `ns_` prefix is retained in the suffix match so a same-named tool on an
  unrelated server is not caught. Verify the exact name your gateway sends with
  the dump-input debug technique before relying on this in production. Other
  NetSuite MCP servers use incompatible conventions (ChatFin `get-*` is
  read-only; glints `netsuite_*` is read-only) and are not write surfaces.

  The suffix is matched against **both** `input.resource.name` (canonical) and
  `input.payload.name` (the mirrored tool id). Matching both closes a fail-open
  where a request omits `resource.name` — the check could not classify the call
  and the pass-through rule would have let a vendor bank edit through — but the
  tool id is still present in `payload.name`.

  ## Argument shape

  Verified from Oracle's docs: `ns_createRecord` and `ns_updateRecord` take
  `{ recordType: string, data: string }`, where `data` is a **JSON-encoded
  string** of field key/values, e.g. `"{\"companyName\":\"Acme\"}"`. The policy:

  - reads the argument container from `input.payload.arguments` (the key the
    NetSuite landscape note documents) **and** `input.payload.args` (the generic
    DTwo gateway argument key), merging them so it works whichever the gateway
    populates;
  - reads `recordType` and the JSON-encoded `data` from that container;
  - `json.unmarshal`s `data` (defaulting to `"{}"` when absent) before matching;
  - inspects bank-field patterns against **both** the recursively-walked keys of
    the decoded `data` **and** the top-level argument keys themselves. The
    verified shape keeps record fields inside the `data` string, but inspecting
    the top-level keys too closes the "alternate argument key" evasion where a
    call passes `accountNumber`/`routingNumber` as siblings of `data`. The
    benign `recordType`/`data` keys match no bank pattern, so this adds no false
    positives.

  A vendor write whose `data` is **present but not valid JSON** is treated as a
  banking edit and denied (fail closed) — the policy cannot prove it does not
  touch banking fields. A missing/empty `data` decodes to `{}` and, having no
  bank fields, passes.

  ## Identity gate

  The optional exemption reads the caller's IdP `groups` claim (array of
  strings, compared case-insensitively) via
  `object.get(input.subject.claims, "groups", [])`. A caller with no
  `input.subject`, no `claims`, or no `groups` claim is **not** in `ap-manager`
  and is therefore denied — `default allow := false` fails closed when identity
  is missing.

  ## Examples

  ### Allowed — non-banking vendor edit

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_updateRecord", "type": "tool" },
      "subject": { "sub": "auth0|jane", "claims": {} },
      "payload": {
        "name": "netsuite-mcp-ns_updateRecord",
        "arguments": {
          "recordType": "vendor",
          "data": "{\"companyName\":\"Acme Supplies\",\"email\":\"ap@acme.example\"}"
        }
      }
    }
  }
  ```

  `allow = true`, no reason (no bank/payment field present).

  ### Denied — vendor bank routing change by a non-AP caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_updateRecord", "type": "tool" },
      "subject": { "sub": "auth0|jane", "claims": { "groups": ["viewer"] } },
      "payload": {
        "name": "netsuite-mcp-ns_updateRecord",
        "arguments": {
          "recordType": "vendor",
          "data": "{\"accountNumber\":\"000123456789\",\"routingNumber\":\"021000021\"}"
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Editing vendor banking or payment-instruction details through the agent is blocked to prevent payment fraud. Make vendor bank changes through your reviewed accounts-payable (AP) process instead. Contact your finance team if this is a false positive."`.

  ### Allowed — AP manager performing legitimate maintenance

  Same call as above but with `"groups": ["ap-manager"]` → `allow = true`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - **PF-11 protect-closed-periods** — deny edits/voids of posted transactions
    and closed accounting periods (`journalentry`, `vendorbill`, etc.).
  - **PF-09 gate-money-movement** — group-gate and cap `vendorpayment` /
    `check` creation so a redirected invoice cannot be paid out unattended.
  - **PF-28 default-deny-unknown-tools** — mandatory on the `/services/mcp/v1/all`
    endpoint, where custom SuiteScript tools with arbitrary names could edit a
    vendor outside `ns_createRecord`/`ns_updateRecord`.
  - **PF-05/PF-02 egress redaction** on `ns_getRecord` / `ns_runCustomSuiteQL`
    so existing vendor bank details are not read back into agent context.

  ## Known limitations

  - **Update-identifier field is unverified.** The NetSuite landscape note flags
    that `ns_updateRecord`'s record-identifier field name is not published on
    Oracle's index page and could not be fetched; this policy does not depend on
    that field (it keys only on `recordType` + `data`), but confirm the argument
    shape against a live connector before extending it.
  - **Bank field names are pattern-based approximations.** NetSuite exposes
    vendor EFT / bank details through a "Financial Institution" subrecord whose
    exact JSON field keys are **unverified**. The policy matches conservative
    key patterns recursively: `account number/no/num`, `acct*`, `bankaccount`,
    payment-context `*account` fields prefixed by
    `bank|payee|payer|payto|beneficiary|remit|deposit|ach|eft|wire` (so
    `payeeAccount`, `directDepositAccount`, `achAccount` are caught),
    `bank number/no/num/id/code`, `sort code`, `routing`, `aba`, `iban`,
    `swift`, `bic`, `payment method/instruction/detail/type`, and `eft`.
    Confirm the real key names on your account and extend `bank_field_patterns`
    if needed — region-specific variants not covered above (e.g. a bare
    `sortcode`-less `branchCode`, `institutionNumber`, `transitNumber`) must be
    added per account.
    - The `aba` and `bic` acronyms are matched only at a **token-leading**
      boundary (`abaNumber`, `bicCode`, and bare `aba`/`bic` are caught; an
      acronym buried mid-camelCase such as `vendorAbaNumber` or `beneficiaryBic`
      is **not**) — kept narrow so common words that merely contain `aba`
      (e.g. `database`) do not false-positive. This is not a redirect gap on its
      own: a BIC/ABA identifies a bank but does not by itself move funds, and any
      real redirect must also change the destination **account/IBAN**, which the
      broad `account*`/`routing`/`iban`/`swift`/`*account` patterns catch.
    - A field named **exactly** `account` (or `accountId`, `glAccount`,
      `expenseAccount`) is **intentionally not matched**: on a vendor record the
      unqualified `account` field is almost always a GL-account reference, and
      matching it would false-positive on nearly every vendor edit. A genuine
      bank-account field must therefore carry a `number/no/num` suffix, an
      `acct`/`bankaccount` token, or a payment-context prefix to be caught —
      verify your account's real EFT key name and extend the patterns if it is
      an unqualified `account`.
    - Only field **keys** are inspected, not values: a bank number pasted into a
      free-text value (e.g. a `notes` field) is not treated as a banking edit
      because it does not write the vendor's routing/account field and so is not
      a payment-redirect vector.
  - **Group names are placeholders — replace `ap-manager` with your IdP's group
    name at import time.** The `groups` claim must be emitted by your IdP; many
    (including Auth0) require explicit configuration before group information
    reaches the token.
  - **Argument container key.** The policy reads both `input.payload.arguments`
    (per the landscape note) and `input.payload.args` (the generic gateway
    field). Each is coerced to `{}` if a gateway populates it with a scalar
    instead of an object, so a non-object container can neither fail the merge
    open nor evade the check. If your gateway uses a third key, capture it with
    the dump-input technique and extend the argument accessor. The `recordType`
    and `data` **keys** are read exactly as the verified MCP input schema names
    them; a differently-cased key (`recordtype`, `Data`) is not a schema-valid
    call — NetSuite rejects it rather than performing a vendor write — so it is
    correctly not treated as a guarded edit.
  - **Tool identity.** The guarded suffix is matched against both
    `input.resource.name` and `input.payload.name`, so a request missing one
    still classifies. If a request carries **no tool identity at all** (neither
    field), the policy cannot know it is a write tool and passes it through;
    pair with **PF-28 default-deny-unknown-tools** on the NetSuite endpoint,
    which denies calls whose tool name is absent or unrecognized.
  - **Record-type normalization.** `recordType` is stringified, lowercased, and
    whitespace-trimmed before the `== "vendor"` match, so casing or padded
    values (`" vendor "`) cannot slip past. Matching is still exact on the
    normalized value; the policy does not attempt fuzzy/alias record-type
    matching.
  - **Malformed-JSON handling.** A vendor write with a present-but-unparseable
    `data` string is denied (fail closed). NetSuite would reject malformed data
    too, so this blocks nothing legitimate; it only closes an inspection-evasion
    path.
  - **Other write paths.** The standard SuiteApp has no delete tool, but a
    custom SuiteScript MCP tool on `/services/mcp/v1/all` could edit a vendor
    without going through `ns_createRecord`/`ns_updateRecord`; pair with PF-28.
  - **MCP path only.** Vendor bank edits made in the NetSuite web UI, via
    SuiteTalk/REST directly, or by SuiteScript are outside the gateway's reach.

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
package netsuite.ingress.guard_vendor_banking

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# IdP groups allowed to perform vendor bank maintenance through the agent.
# PLACEHOLDER — replace `ap-manager` with your IdP's group name at import time.
# Compared case-insensitively against the caller's `groups` claim.
allowed_groups := {"ap-manager"}

# Field-name patterns (RE2, matched against lowercased keys) that indicate a
# bank or payment-instruction field on a vendor record. Conservative shapes —
# NetSuite's exact EFT/bank subrecord field keys are unverified, so confirm and
# extend for your account.
bank_field_patterns := [
	`account[_ ]?(number|no|num)`, # bank account number (accountNumber, account_no)
	`acct`, # acct, acctNum, bankAcctNumber
	`bankaccount`, # bankAccount*
	# Payment-context "…account" fields with no numeric suffix (payeeAccount,
	# directDepositAccount, achAccount) — a bank-context prefix keeps a bare GL
	# `account`/`expenseAccount`/`accountId` reference from being caught.
	`(bank|payee|payer|payto|beneficiary|benef|remit|deposit|ach|eft|wire)[a-z0-9_ ]*acc`,
	`bank[_ ]?(number|no|num|id|code)`, # bank routing/identifier (bankNumber, bankId, bank_code); NOT bankName
	`sort[_ ]?code`, # UK/IE sort code (routing equivalent)
	`routing`, # routing / routingNumber
	`\baba`, # ABA routing number (aba, abaNumber, abaRoutingNo — token-leading)
	`iban`, # IBAN
	`swift`, # SWIFT code
	`\bbic`, # BIC code (bic, bicCode — token-leading)
	`payment[_ ]?(method|instruction|detail|type)`, # payment-method / instruction change
	`eft`, # EFT / electronic funds transfer
]

# Coerce a value to an object, defaulting to {} when it is not one. Keeps
# object.union below from type-erroring (which would leave `ns_args` undefined
# and silently disable the whole check — a fail-open) if a gateway populates an
# argument container with a scalar instead of an object.
as_object(x) := x if is_object(x)

as_object(x) := {} if not is_object(x)

# Argument container: merge the generic gateway key (`args`) and the NetSuite
# landscape-note key (`arguments`), with `arguments` winning on conflict. Works
# whichever the gateway populates; a non-object container coerces to {} so the
# other container (or the fail-closed default) still governs.
ns_args := object.union(
	as_object(object.get(object.get(input, "payload", {}), "args", {})),
	as_object(object.get(object.get(input, "payload", {}), "arguments", {})),
)

# Candidate tool names: the canonical `input.resource.name` AND the mirrored
# `input.payload.name`. Matching both closes a fail-open where a request omits
# `resource.name` (the check could not classify the call and `allow if not
# is_target_write_tool` let it through) but still carries the tool id in
# `payload.name`. Empty/missing names are dropped.
candidate_tool_names contains name if {
	some raw in [
		object.get(object.get(input, "resource", {}), "name", ""),
		object.get(object.get(input, "payload", {}), "name", ""),
	]
	name := lower(sprintf("%v", [raw]))
	name != ""
}

# Target write tools, matched by suffix (keeps the `ns_` prefix so unrelated
# same-named tools are not caught).
is_target_write_tool if {
	some name in candidate_tool_names
	endswith(name, "ns_createrecord")
}

is_target_write_tool if {
	some name in candidate_tool_names
	endswith(name, "ns_updaterecord")
}

# Normalize the record type: stringify (so a stray numeric id can't type-error
# lower()), lowercase, and trim surrounding whitespace/tabs/newlines so a padded
# `" vendor "` cannot slip past the exact `== "vendor"` match.
record_type := trim_space(lower(sprintf("%v", [object.get(ns_args, "recordType", "")])))

# The JSON-encoded `data` argument decoded to an object. `data` is a
# JSON-encoded string, not a nested object; default "{}" when absent. Undefined
# (rule fails) when `data` is present but not valid JSON.
vendor_data := json.unmarshal(object.get(ns_args, "data", "{}"))

# True only when `data` decodes successfully (missing/empty "{}" counts).
data_parseable if {
	json.unmarshal(object.get(ns_args, "data", "{}"))
}

# Keys to inspect for bank-field patterns, lowercased. Two contributors:
#   1. the top-level argument keys themselves (defense in depth — the verified
#      shape keeps fields inside the `data` string, but a variant/flattened call
#      that passed `accountNumber`/`routingNumber` as sibling args to `data`
#      would otherwise slip past); the benign `recordType`/`data` keys match no
#      pattern, so this adds no false positives.
#   2. every key appearing anywhere in the decoded `data` (recursively) — so
#      bank fields nested inside sublists are inspected too.
vendor_data_keys contains key if {
	some raw in object.keys(ns_args)
	key := lower(sprintf("%v", [raw]))
}

vendor_data_keys contains key if {
	some path
	walk(vendor_data, [path, _])
	some raw in path
	key := lower(sprintf("%v", [raw]))
}

bank_field_present if {
	some key in vendor_data_keys
	some pattern in bank_field_patterns
	regex.match(pattern, key)
}

# A vendor write that touches banking/payment fields.
is_vendor_banking_edit if {
	record_type == "vendor"
	bank_field_present
}

# Fail closed: a vendor write whose `data` cannot be parsed is treated as a
# banking edit — we cannot prove it does not touch banking fields.
is_vendor_banking_edit if {
	record_type == "vendor"
	not data_parseable
}

# Fail closed on identity: missing subject, claims, or groups means no
# membership and therefore no exemption.
caller_in_allowed_group if {
	claims := object.get(object.get(input, "subject", {}), "claims", {})
	groups := object.get(claims, "groups", [])
	some group in groups
	allowed_groups[lower(group)]
}

# Pass through anything that is not a create/update write tool.
allow if {
	not is_target_write_tool
}

# Create/update calls that are not vendor-banking edits pass through.
allow if {
	is_target_write_tool
	not is_vendor_banking_edit
}

# Vendor-banking edits are allowed only for the AP-manager allowlist.
allow if {
	is_target_write_tool
	is_vendor_banking_edit
	caller_in_allowed_group
}

reasons contains "Editing vendor banking or payment-instruction details through the agent is blocked to prevent payment fraud. Make vendor bank changes through your reviewed accounts-payable (AP) process instead. Contact your finance team if this is a false positive." if {
	is_target_write_tool
	is_vendor_banking_edit
	not caller_in_allowed_group
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
