---
name: "Linear: Redact Customer Revenue and Contacts"
tags:
  - linear
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - gdpr-ccpa
  - soc2
publishedAt: 2026-07-12
description: |
  # linear / redact-customer-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never blocks the read)
  **Package:** `linear.egress.redact_customer_data`

  ## What it does

  Masks commercial and contact identifiers in the **responses** of Linear's
  Customers read tools before they reach the agent. On responses from
  `*getCustomers`, `*getCustomerNeeds`, and `*getCustomerTiers` the policy
  rewrites three field classes to fixed redaction tokens and leaves the rest of
  the record — customer name, need text, IDs, timestamps — intact:

  | Field class | Matched JSON key | Token |
  |---|---|---|
  | Revenue (any key containing `revenue`, e.g. `revenue`, `annualRevenue`) | string, object (up to one level of nesting), or numeric value | `[REDACTED-REVENUE]` |
  | Tier / segment (any key containing `tier`, e.g. `tier`, `customerTier`, `tierName`) | string, object (up to one level of nesting), or numeric value | `[REDACTED-TIER]` |
  | Contact email (any key containing `email`, e.g. `email`, `contactEmail`) | string value | `[REDACTED-EMAIL]` |

  A generic email-address sweep also runs over the response text, so a contact
  email embedded in prose (e.g. a customer need that reads "follow up with
  buyer@bigco.com") is masked even when it is not under an `email` key.

  Linear's Customers feature links customer records, needs, tiers, and revenue
  to issues, so an unfiltered read egresses commercial financial data
  (deal-size / ARR) and contact PII (external buyer email addresses). This
  policy targets that linkable set while keeping the record usable: the agent
  can still reason over **customer names and needs** without seeing revenue,
  tier, or contact emails.

  The policy is transform-only (`default allow := true`): it never denies a
  call, so a legitimate customer lookup still succeeds — it just comes back with
  those fields masked and the record structure intact. Responses with no
  matches, and all out-of-scope tools, pass through byte-identical. Every field
  is read via `object.get` chains, so a missing or oddly-shaped payload is never
  an error — it simply passes through.

  ## Why egress and not ingress

  The revenue, tier, and contact data live in the **response**, not the request:
  a customer-read tool's arguments (a customer ID, a filter, a page cursor)
  don't reveal ARR or buyer emails — only the returned records do. Ingress can't
  see what a read will surface, so redaction has to happen on the way back. The
  read itself is harmless and is allowed to proceed. Gating *which* customer
  tools can be called at all is a separate concern for a companion ingress
  policy.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking commercial and contact identifiers in
    Linear customer reads as they leave the gateway toward the agent (PF-02).
    **C1.1 / P4.1 / P6.1** — supports identifying and protecting confidential
    information, limiting personal-information use to identified purposes (the
    agent gets working records without the identifiers it doesn't need), and
    constraining personal-information disclosure to third parties (here, the
    agent) — all Partial on the MCP path.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of customer
    personal data: the record comes back without the contact identifiers not
    needed for the task. **Art. 5(1)(f) / Art. 32** — supports security of
    processing on the agent channel.
  - **CCPA/CPRA §1798.121** — supports the consumer right to limit use of
    sensitive personal information by keeping contact identifiers out of agent
    context; **§1798.150** — reduces nonredacted-PI breach exposure if agent
    context or downstream logs are later compromised.

  ## Tool name matching

  Applies on the output path to the Customers read channels, matched
  case-insensitively **by suffix** across three egress surfaces —
  `input.resource.name`, `input.tool_metadata.name`, and `input.payload.name` —
  so a gateway that populates a different surface can't slip a read past the
  scanner. Suffix matching keeps the policy portable across the gateway
  server-name prefix, which is not standardised.

  - `*getCustomers` — customer records (name, revenue, tier, contacts)
  - `*getCustomerNeeds` — customer needs linked to issues
  - `*getCustomerTiers` — customer tier definitions

  These three names are **verified** from the tacticlaunch/mcp-linear
  [TOOLS.md](https://github.com/tacticlaunch/mcp-linear/blob/main/TOOLS.md)
  community inventory (`linear_` + camelCase). The **official** Linear remote
  server also reads customer data per third-party catalogs, but its exact
  customer-read tool names are **unverified** in the landscape note — see Known
  limitations. Verify the exact names your gateway emits with the dump-input
  debug technique before relying on this in production.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block.
  Linear MCP tools return serialized JSON in those blocks, so the field rewrites
  use key-anchored patterns (`"revenue": …`, `"...tier...": …`, `"email": …`)
  that replace only the value and keep the surrounding JSON valid and parseable.
  Non-string blocks pass through unmodified. When at least one block changes,
  the policy emits `transform.transformed_payload` containing the original
  payload with the rewritten `text` array (all other payload keys preserved).
  When nothing changes, no transform is emitted and the response passes through
  byte-identical.

  ## Examples

  ### Redacted (in-scope customer read)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "linear-mcp-linear_getCustomers", "type": "tool" },
      "payload": {
        "name": "linear-mcp-linear_getCustomers",
        "text": ["{\"id\":\"cus_1\",\"name\":\"Acme Corp\",\"revenue\":1500000,\"tier\":\"Enterprise\",\"contacts\":[{\"name\":\"Jane Roe\",\"email\":\"jane@acme.com\"}]}"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["{\"id\":\"cus_1\",\"name\":\"Acme Corp\",\"revenue\":\"[REDACTED-REVENUE]\",\"tier\":\"[REDACTED-TIER]\",\"contacts\":[{\"name\":\"Jane Roe\",\"email\":\"[REDACTED-EMAIL]\"}]}"]`.
  Customer and contact **names** survive; revenue, tier, and email are masked.

  ### Passed through (out-of-scope tool)

  A `linear_getIssues` / `linear_getProjects` response does not end in a
  Customers-read suffix, so `transform` is undefined and the aggregator skips
  this policy for that call.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny/transform policies on the same pipeline. Recommended companions for
  `apps/linear`:

  - A **roadmap/initiative egress gate** for pre-announcement product data.
  - A **membership + impersonation deny** on the write path.
  - A **default-deny-unknown-tools** ingress guard to catch drift as Linear's
    customer toolset expands.

  Egress transforms attached to the same direction compose in pipeline order.

  ## Known limitations

  - **No identity exemption — all callers get the redacted view.** This policy
    does not gate redaction on IdP group: every caller sees revenue, tier, and
    contact emails masked. If an authorized group (e.g. `sales-ops`) needs the
    raw values, add a `not is_exempt` guard to the `transform` rule that reads
    `input.subject.claims.groups` via `object.get` chains (see the Stripe/Docusign
    redact policies for the fail-closed pattern) — never rely on stripped
    ContextForge-internal claims (`is_admin`, `teams`, `user`).
  - **Field key names are documented, not schema-verified.** The tokens key on
    JSON keys *containing* `revenue`, `tier`, or `email` (case-insensitively).
    Those key names are documented in the landscape note, not confirmed against a
    live customer-read schema. Confirm the actual keys your deployment returns
    with a captured response (dump-input technique) and extend the patterns if
    Linear names them differently (e.g. `arr`, `mrr`, `segment`, `contact_email`
    is covered; `arr`/`mrr`/`segment` are **not**).
  - **Official-server tool names are unverified.** Only the three
    tacticlaunch names (`getCustomers`, `getCustomerNeeds`, `getCustomerTiers`)
    are verified. The official Linear remote server reads customer data too, but
    its exact tool names are unverified in the landscape note and are therefore
    **not** in scope. Pin them into `customer_read_suffixes` once confirmed via a
    live `tools/list`.
  - **Deeply nested and array-valued revenue/tier are residuals.** The revenue
    and tier object branches mask an object value including **one level** of
    nested braces (e.g. `"revenue":{"amount":{"value":…}}` and
    `"tier":{"meta":{…}}` are masked whole — red-team hardening, 2026-07). Two
    residuals remain and pass through unredacted: (a) an object nested **two or
    more** levels deep (`"revenue":{"a":{"b":{"c":…}}}`), and (b) a value
    expressed as a JSON **array** (`"tier":["Enterprise"]`, `"revenue":[…]`),
    because the object pattern matches braces, not brackets. Both shapes are
    unusual for a money/tier field; extend the patterns if your response nests
    that deeply or arrays these fields. Contact emails inside such structures are
    still caught by the generic email sweep; only revenue/tier numbers leak.
  - **Over-redaction is possible and safe.** Any key containing `revenue` /
    `tier` / `email` is masked, so a benign `revenueNote` or `tierId` is masked
    too. On egress this is over-redaction, never disclosure.
  - **Key-anchored patterns assume serialized-JSON response shape.** A value
    under a differently-worded key, or PII in reformatted prose, is only caught
    for **email** (via the generic email sweep). Revenue/tier in free prose is
    not matched. Non-string content blocks pass through unmodified — verify their
    shape with the dump-input technique if your gateway emits structured blocks.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version before production, and mind
    attachment order if other egress transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - linear
industries: []
bundles:
  - gdpr-ccpa
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package linear.egress.redact_customer_data

# Transform-only egress policy: masks customer revenue, tier/segment, and
# contact email in the responses of Linear's Customers read tools
# (getCustomers, getCustomerNeeds, getCustomerTiers) before the response reaches
# the agent. Never denies — a legitimate customer lookup still succeeds, just
# with those fields masked and the record structure (IDs, names, need text)
# intact. No identity exemption: every caller receives the redacted view.
default allow := true

# -----------------------------------------------------------------------------
# Egress scope. Match the post-invoke/output path on EITHER mode or action. If
# we keyed on input.mode alone and a gateway build left it unset, the scope
# check would silently fail and redaction would no-op (fail open, leaking
# revenue/PII). Ingress (tool_pre_invoke / mode "input") satisfies neither
# branch.
# -----------------------------------------------------------------------------
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC),
# tool_metadata.name (legacy), and payload.name (tool-hook canonical). Collect
# all three (lower-cased) and match if ANY carries a Customers-read suffix, so a
# gateway that populates a different surface can't slip a read past the scanner.
# object.get chains keep a missing surface from failing the rule.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

# Customers read channels. Verified from tacticlaunch/mcp-linear TOOLS.md
# (linear_ + camelCase). The gateway prepends its configured server-name prefix,
# so we match by suffix, case-insensitively. The official Linear server's
# customer-read tool names are unverified (landscape note) and are NOT pinned
# here — add them once confirmed via a live tools/list.
customer_read_suffixes := {
	"getcustomers",
	"getcustomerneeds",
	"getcustomertiers",
}

is_customer_read_tool if {
	is_egress
	some suffix in customer_read_suffixes
	some n in candidate_names
	endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Redaction steps. Linear MCP tools return serialized JSON in the response
# content blocks, so the field rewrites are anchored to JSON keys and replace
# only the value (the ${1} capture keeps the key), leaving the surrounding JSON
# valid and parseable. Each step is total over strings: it returns its input
# unchanged when its pattern doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

# `"...revenue...": <value>` — any key containing `revenue` (case-insensitive,
# so `annualRevenue`/`revenue`/`annual-revenue` are covered; the key char class
# allows `_` and `-`). Masks an object value first (a `{amount,currency,…}` money
# object is replaced whole — otherwise the inner amount would leak). The object
# pattern tolerates ONE level of nested braces (`{"amount":{"value":…}}`), so a
# nested money object is caught too; objects nested two or more levels deep are a
# documented residual. Then a quoted-string value, then a bare numeric value
# including an optional exponent (`1.5e6`) so the whole number is consumed and the
# surrounding JSON stays valid. null carries no data and is left alone.
redact_revenue(t) := out if {
	o := regex.replace(t, `(?i)("[a-z0-9_-]*revenue[a-z0-9_-]*"\s*:\s*)\{(?:[^{}]|\{[^{}]*\})*\}`, `${1}"[REDACTED-REVENUE]"`)
	s := regex.replace(o, `(?i)("[a-z0-9_-]*revenue[a-z0-9_-]*"\s*:\s*)"[^"]*"`, `${1}"[REDACTED-REVENUE]"`)
	out := regex.replace(s, `(?i)("[a-z0-9_-]*revenue[a-z0-9_-]*"\s*:\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`, `${1}"[REDACTED-REVENUE]"`)
}

# `"...tier...": <value>` — any key containing `tier` (case-insensitive, so
# `customerTier`/`tierName`/`customer-tier` are covered; the key char class allows
# `_` and `-`, matching the revenue/email branches). Masks an object value first
# (so a `{name,level,...}` tier object is replaced whole), tolerating ONE level of
# nested braces like the revenue branch, then a quoted string, then a bare number.
# A tier object nested two or more levels deep is a documented residual.
redact_tier(t) := out if {
	o := regex.replace(t, `(?i)("[a-z0-9_-]*tier[a-z0-9_-]*"\s*:\s*)\{(?:[^{}]|\{[^{}]*\})*\}`, `${1}"[REDACTED-TIER]"`)
	s := regex.replace(o, `(?i)("[a-z0-9_-]*tier[a-z0-9_-]*"\s*:\s*)"[^"]*"`, `${1}"[REDACTED-TIER]"`)
	out := regex.replace(s, `(?i)("[a-z0-9_-]*tier[a-z0-9_-]*"\s*:\s*)-?\d+(?:\.\d+)?`, `${1}"[REDACTED-TIER]"`)
}

# `"...email...": "..."` — any key containing `email` (case-insensitive, so
# `contactEmail`/`email`/`contact-email` are covered; the key char class allows
# `_` and `-`). String value only; other email-bearing text is caught by the
# generic sweep below.
redact_email_field(t) := regex.replace(
	t,
	`(?i)("[a-z0-9_-]*email[a-z0-9_-]*"\s*:\s*)"[^"]*"`,
	`${1}"[REDACTED-EMAIL]"`,
)

# Bare email addresses anywhere in the text (word-boundary anchored: local part,
# "@", domain, TLD of at least two letters) — catches contact emails embedded in
# prose (e.g. a customer-need description string) outside an "email" key.
redact_email_text(t) := regex.replace(
	t,
	`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
	"[REDACTED-EMAIL]",
)

# Order: the key-anchored field rewrites first (their tokens contain no "@",
# braces, or quoted digits, so no later step can re-match an emitted token),
# then the generic email sweep over whatever text remains.
redact_block(b) := redact_email_text(
	redact_email_field(redact_tier(redact_revenue(b))),
) if {
	is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope and at least one block actually
# changed. Otherwise the rule is undefined and the aggregator skips this policy,
# returning the response byte-identical.
# -----------------------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

redacted_blocks := [out |
	some block in text_blocks
	out := redact_block(block)
]

transform := {
	"transformed_payload": object.union(response_payload, {"text": redacted_blocks}),
} if {
	is_customer_read_tool
	is_array(text_blocks)
	redacted_blocks != text_blocks
}
```
