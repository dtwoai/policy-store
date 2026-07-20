---
name: "Stripe: Redact Customer PII from Bulk Reads"
tags:
  - stripe
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # stripe / redact-pii-egress-customer

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `stripe.egress.redact_pii_customer`

  ## What it does

  Masks customer PII in the responses of Stripe's bulk PII egress channels
  before they reach the agent. On responses from `*list_customers`,
  `*search_stripe_resources`, `*fetch_stripe_resources`, and
  `*stripe_api_read`, the policy rewrites these fields to fixed redaction
  tokens:

  | Field | Where it appears | Token |
  |---|---|---|
  | `email` | customer objects, `billing_details`, receipts | `[REDACTED-EMAIL]` |
  | any `*phone*` key | customer objects, `billing_details`, `shipping`, dispute evidence (`customer_phone_number`, `phone_number`) | `[REDACTED-PHONE]` |
  | any `*address*` key | customer objects, `billing_details`, `shipping`, dispute evidence (`billing_address`, `shipping_address`) — object or string value | `[REDACTED-ADDRESS]` |
  | `last4` | cards, payment methods, bank accounts | `[REDACTED-LAST4]` |

  The phone and address rewrites match any JSON key whose name *contains*
  `phone` or `address` (case-insensitively), so compound keys reached through
  the meta-tools (`fetch_stripe_resources`/`stripe_api_read` can return dispute
  objects whose evidence carries `billing_address`, `shipping_address`, and
  `customer_phone_number`) are masked, not just the bare `phone`/`address`
  keys. Over-matching a benign `*address*` key on egress is over-redaction, not
  disclosure.

  A generic email-address pattern also runs over the response text, so an
  email embedded in prose (e.g. a `description` string) is masked even when it
  is not under an `email` key.

  The policy is transform-only (`default allow := true`): it never denies a
  call, so a legitimate customer lookup still succeeds — it just comes back
  with identifiers masked and the record structure (IDs, created timestamps,
  subscription status, currency, amounts) intact. Responses with no matches,
  and all out-of-scope tools, pass through byte-identical. Every field is read
  via `object.get`, so a missing or oddly-shaped payload is never an error —
  it simply passes through.

  **Scope note:** Stripe never returns raw PANs — PCI scope for card numbers
  stays with Stripe. What these channels do leak is *linkable* PII: a customer
  list pairs name + email + phone + address, and card records add `last4`,
  which together identify and profile real people. This policy targets that
  linkable set, not PAN (see the companion `mask-pan-egress` family for PAN
  masking on apps that can return card numbers).

  ### Group exemption

  Redaction is gated by IdP group. Callers whose `groups` claim contains
  `finance` (a placeholder name — see Known limitations) receive the response
  **unmodified**. The check reads `input.subject.claims.groups` via
  `object.get` chains: a missing subject, missing claims, or missing `groups`
  claim means the caller is *not* in finance and receives the redacted view —
  the grant fails closed, toward redaction. That failure mode is safe: a
  caller whose claims fail to arrive gets over-redaction, never disclosure.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in Stripe reads as
    they leave the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the payments read path; **P4.1** — supports limiting
    personal-information use to identified purposes (agents get working
    records without identifiers they don't need); **P6.1** — supports
    controls over personal-information disclosure by keeping raw identifiers
    out of agent context.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of customer
    personal data: non-finance callers see the record, not the identifiers;
    **Art. 5(1)(f) / Art. 32** — supports security of processing on the agent
    channel.
  - **CCPA/CPRA §1798.150** — reduces nonredacted-PI breach exposure if agent
    context or downstream logs are later compromised.

  ## Why egress

  The PII already lives in Stripe — there is nothing to block at ingress, and
  denying customer reads outright would make the agent useless for everyday
  billing-support work. The leak happens when the customer list or fetched
  object is returned to the MCP client, so the response path is the only
  place to catch it while keeping the result useful. Gating *which* tools and
  endpoints can be called at all is a separate concern handled by companion
  ingress policies.

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to the bulk PII
  egress channels identified in the Stripe landscape review, matched
  case-insensitively **by suffix** from `input.resource.name` with
  `input.tool_metadata.name` as a fallback. Suffix matching keeps the policy
  portable across the gateway server-name prefix (which is not standardised —
  different deployments name the Stripe MCP server differently).

  - `*list_customers` — legacy per-resource customer listing (v0.8.x
    `@stripe/mcp`, Claude Desktop `.dxt`, pre-migration agent-toolkit embeds)
  - `*search_stripe_resources` — official server cross-object search
    (customers, charges, invoices, …)
  - `*fetch_stripe_resources` — official server fetch-any-object-by-ID
  - `*stripe_api_read` — official server execute-any-GET meta-tool

  All four names are verified from docs.stripe.com/mcp and the `stripe/ai`
  repo history. Verify the exact names your gateway emits with the dump-input
  debug technique before relying on this in production.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block.
  Stripe MCP tools return serialized JSON API objects in those blocks, so the
  field rewrites use key-anchored patterns (`"email": "…"`,
  `"address": {…}`, `"last4": "…"`) that replace only the value and keep the
  surrounding JSON valid and parseable. Non-string blocks pass through
  unmodified. When at least one block changes, the policy emits
  `transform.transformed_payload` containing the original payload with the
  rewritten `text` array (all other payload keys preserved). When nothing
  changes, no transform is emitted and the response passes through
  byte-identical.

  ## Examples

  ### Redacted (in-scope tool, non-finance caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "stripe-list_customers", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["support"] } },
      "payload": {
        "name": "stripe-list_customers",
        "text": ["{\"id\": \"cus_9s6XKzkNRiz8i3\", \"name\": \"Jane Diaz\", \"email\": \"jane@acme.com\", \"phone\": \"+15551234567\", \"address\": {\"city\": \"Seattle\", \"line1\": \"1 Main St\"}}"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["{\"id\": \"cus_9s6XKzkNRiz8i3\", \"name\": \"Jane Diaz\", \"email\": \"[REDACTED-EMAIL]\", \"phone\": \"[REDACTED-PHONE]\", \"address\": \"[REDACTED-ADDRESS]\"}"]`.

  ### Passed through (finance caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "stripe-search_stripe_resources", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "stripe-search_stripe_resources",
        "text": ["{\"email\": \"jane@acme.com\"}"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `finance` group receives the raw
  response.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny/transform policies on the same pipeline. Recommended
  companions for `apps/stripe`:

  - **`deny-escape-hatches-api-write`** — this policy masks the read path;
    that one closes the `stripe_api_write` write escape hatch.
  - **`gate-money-movement-refund-cap`** — caps refunds on the money-out
    path.
  - A **`cap-bulk-export`-style ingress guard** (PF-08) clamping `limit` on
    list/search calls, bounding the blast radius of any redaction miss.
  - A **`role-gate-writes`-style ingress policy** (PF-12) keeping the agent
    read-only for non-finance groups in the first place.

  Layer with Stripe Restricted API Key (RAK) scoping — DTwo policy and key
  scoping are complementary control planes, not either/or.

  ## Known limitations

  - **Group names are placeholders — replace `finance` with your IdP's group
    name at import time.** The exemption expects the `groups` claim as an
    array of strings (a single bare string is also handled); if your IdP
    emits roles under a namespaced claim, adjust `caller_groups`. Missing
    claims always mean the redacted view — the failure mode is
    over-redaction, never disclosure. Never rely on stripped
    ContextForge-internal claims (`is_admin`, `teams`, `user`) for the
    exemption.
  - **Customer `name` is not redacted.** The policy masks the fields that
    make a name linkable and contactable (email, phone, address, last4); a
    bare name with no other identifiers is left so results stay usable for
    support workflows. Add a `"name"` key pattern if your posture requires
    masking it too.
  - **Key-anchored patterns assume Stripe's serialized-JSON response shape.**
    The field rewrites match Stripe's serialized JSON keys as its API emits
    them: `"email"` exactly, any key *containing* `phone` or `address`
    (case-insensitively, so `billing_address`/`customer_phone_number` are
    covered), and `"last4"` exactly. What is *not* matched: a value under a
    differently-worded key (e.g. a mobile number under `"mobile"` or a location
    under `"location"`), `last4` outside the `"last4"` key, and PII in
    reformatted prose (e.g. `Email — jane@acme.com`, which is covered for email
    only via the generic email pattern). A bare `4242` in prose is not matched
    — four digits alone would over-fire on amounts and dates. Note that a
    compound *email* key (`customer_email_address`) is masked, but with the
    `[REDACTED-ADDRESS]` token rather than `[REDACTED-EMAIL]` because the
    address rewrite runs first — the value is still fully redacted, only the
    token label differs.
  - **Other Stripe read surfaces are out of scope.** `get_stripe_account_info`
    (account business email), `stripe_report` (report runs can embed customer
    columns), and the remaining legacy list tools (`list_invoices`,
    `list_payment_intents`, `list_subscriptions`, and **`list_disputes`** —
    whose dispute objects carry the most customer PII of the legacy read tools:
    `customer_name`, `customer_email_address`, `billing_address`,
    `shipping_address`) are not matched, so a whole-list read through one of
    those tool names passes through unredacted. Only the four verified bulk
    channels in `bulk_read_suffixes` are in scope; extend it if your deployment
    exposes these and your posture requires it.
  - **Non-official servers break suffix symmetry.** The community
    `atharvagupta2003/mcp-stripe` server uses inverted `noun_verb` names
    (e.g. `customer_list`) and Composio uses `STRIPE_*` slugs across ~415
    tools — neither matches this suffix set. Pin your deployment's actual
    tool names in `bulk_read_suffixes`. Treasury "agentic finance" preview
    tool names are unpublished (unverified) and therefore not matched.
  - **PAN is a non-issue on this surface, by Stripe's design.** The Stripe
    API never returns full card numbers, so no PAN masking is attempted here;
    `last4` is the only card identifier present and it is masked.
  - **The generic email pattern can over-match** `user:password@host`
    substrings inside connection-string-shaped values. On egress this is
    over-redaction (safe), not disclosure.
  - **Non-string content blocks pass through unmodified.** Redaction applies
    to string entries of `input.payload.text` (including serialized-JSON
    strings). If your gateway emits structured non-string blocks for Stripe
    results, verify their shape with the dump-input technique.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - stripe
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package stripe.egress.redact_pii_customer

# Transform-only egress policy: masks customer email, phone, address, and card
# last4 in the responses of Stripe's bulk PII egress channels (list_customers,
# search_stripe_resources, fetch_stripe_resources, stripe_api_read) before the
# response reaches the agent. Never denies — a legitimate lookup still
# succeeds, just with identifiers masked. Stripe never returns raw PANs (PCI
# scope stays with Stripe), so this targets linkable PII (name + email +
# last4), not PAN. Callers in the placeholder `finance` IdP group receive
# unmodified responses; the group check fails closed, so a caller with missing
# claims gets the redacted view, never disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Scope: the bulk PII egress channels. The gateway prefixes tool names with the
# configured MCP server name (not standardised), so we match by suffix,
# case-insensitively. All four names are verified from docs.stripe.com/mcp and
# the stripe/ai repo history (legacy v0.8.x tool set). Community/aggregator
# servers use different shapes (customer_list, STRIPE_*) — pin your
# deployment's names here. See the policy's Known limitations.
# -----------------------------------------------------------------------------

bulk_read_suffixes := {
    # Legacy per-resource customer listing (v0.8.x @stripe/mcp, .dxt manifest)
    "list_customers",
    # Official server — cross-object search (customers, charges, invoices, ...)
    "search_stripe_resources",
    # Official server — fetch any Stripe object by ID
    "fetch_stripe_resources",
    # Official server — execute any Stripe API GET method
    "stripe_api_read",
}

is_bulk_pii_tool if {
    input.mode == "output"
    some suffix in bulk_read_suffixes
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), suffix)
}

is_bulk_pii_tool if {
    # Egress hooks also expose the tool name under tool_metadata.name — check
    # both so we match regardless of which surface the gateway populates.
    input.mode == "output"
    some suffix in bulk_read_suffixes
    meta := object.get(input, "tool_metadata", {})
    endswith(lower(object.get(meta, "name", "")), suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP group whose members receive unmodified
# responses. Replace "finance" with your IdP's group name at import time.
# object.get chains mean a missing subject/claims/groups claim is never
# exempt: the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

finance_groups := {"finance"}

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

is_finance if {
    some g in caller_groups
    lower(g) in finance_groups
}

is_finance if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) in finance_groups
}

# -----------------------------------------------------------------------------
# Redaction steps. Stripe MCP tools return serialized JSON API objects in the
# response content blocks, so the field rewrites are anchored to Stripe's
# lowercase snake_case JSON keys and replace only the value (the ${1} capture
# keeps the key), leaving the surrounding JSON valid and parseable. Each step
# is total over strings: it returns its input unchanged when its pattern
# doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

# `"...address...": {...}` — customer/billing_details/shipping address objects.
# The key match accepts any JSON key that *contains* `address` (case-
# insensitive) so compound keys like `billing_address` / `shipping_address`
# — which appear in dispute evidence and Checkout/PaymentIntent shapes reached
# via fetch_stripe_resources / stripe_api_read — are covered, not just the bare
# `address` key. Stripe address objects are flat ({city, country, line1, line2,
# postal_code, state}), so a non-nested {...} match suffices. Null addresses
# carry no PII and are left alone. Over-matching a non-PII "*address*" key on
# egress is over-redaction (safe), never disclosure.
redact_address_object(t) := regex.replace(
    t,
    `(?i)("[a-z0-9_]*address[a-z0-9_]*"\s*:\s*)\{[^{}]*\}`,
    `${1}"[REDACTED-ADDRESS]"`,
)

# `"...address...": "..."` — string-valued address fields (dispute-evidence
# `billing_address`/`shipping_address` free text, metadata copies, etc.).
redact_address_string(t) := regex.replace(
    t,
    `(?i)("[a-z0-9_]*address[a-z0-9_]*"\s*:\s*)"[^"]*"`,
    `${1}"[REDACTED-ADDRESS]"`,
)

# `"email": "..."` — customer, billing_details, and receipt email fields. Other
# email-bearing keys (`receipt_email`, `customer_email_address`, prose) are
# caught by the generic email sweep below.
redact_email_field(t) := regex.replace(
    t,
    `("email"\s*:\s*)"[^"]*"`,
    `${1}"[REDACTED-EMAIL]"`,
)

# `"...phone...": "..."` — customer, billing_details, shipping, and dispute-
# evidence phone fields. The key match accepts any JSON key that *contains*
# `phone` (case-insensitive) so `customer_phone_number` / `phone_number` are
# covered, not just the bare `phone` key. Over-redaction on egress is safe.
redact_phone_field(t) := regex.replace(
    t,
    `(?i)("[a-z0-9_]*phone[a-z0-9_]*"\s*:\s*)"[^"]*"`,
    `${1}"[REDACTED-PHONE]"`,
)

# `"last4": "..."` — card / payment-method / bank-account last-four digits.
redact_last4_field(t) := regex.replace(
    t,
    `("last4"\s*:\s*)"[^"]*"`,
    `${1}"[REDACTED-LAST4]"`,
)

# Bare email addresses anywhere in the text (word-boundary anchored:
# local part, "@", domain, TLD of at least two letters) — catches emails
# embedded in prose/description strings outside an "email" key.
redact_email_text(t) := regex.replace(
    t,
    `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`,
    "[REDACTED-EMAIL]",
)

# Order: the key-anchored field rewrites first (their tokens contain no "@",
# braces, or quoted digits, so no later step can re-match an emitted token),
# then the generic email sweep over whatever text remains.
redact_block(b) := redact_email_text(
    redact_last4_field(
        redact_phone_field(
            redact_email_field(
                redact_address_string(redact_address_object(b)),
            ),
        ),
    ),
) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not in the finance
# group, and at least one block actually changed. Otherwise the rule is
# undefined and the aggregator skips this policy, returning the response
# byte-identical.
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
    is_bulk_pii_tool
    not is_finance
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
