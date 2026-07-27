---
name: Read-Only Stripe by Default (Role-Gate Billing Writes)
tags:
  - stripe
  - role-gate-writes
  - ingress
  - least-privilege
  - rbac
  - soc2
  - pci-dss
  - sox
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # stripe / role-gate-writes-billing

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny gated billing writes unless the caller is in an allowed IdP group; allow everything else
  **Package:** `stripe.ingress.role_gate_writes`

  ## What it does

  Establishes a read-only-by-default Stripe posture over the MCP path. The named write
  and destructive billing tools —

  - `*create_customer`, `*create_product`, `*create_price`, `*create_payment_link`
  - `*create_invoice`, `*create_invoice_item`, `*finalize_invoice`, `*create_coupon`
  - `*update_subscription`, `*update_dispute`, `*cancel_subscription`

  — are denied unless the caller's IdP `groups` claim includes `finance` or
  `billing-admin`. Read, search, and fetch tools (`*list_*`, `*search_stripe_resources`,
  `*fetch_stripe_resources`, `*stripe_api_read`, `*retrieve_balance`,
  `*get_stripe_account_info`, documentation/search tools) always pass — they never match
  the gated suffix list, so the blocklist design leaves them untouched.

  Missing identity fails closed for the gate: if the gateway populates no `subject`,
  no `claims`, or no `groups` claim, the caller is not in an allowed group and the
  write is denied. Reads remain available to everyone regardless of claims.

  Refunds (`*create_refund`) and the `*stripe_api_write` passthrough are **intentionally
  out of scope** — they are governed by the dedicated refund-cap and escape-hatch
  companion policies (see Composition). This keeps the policy to the single job of
  gating ordinary billing writes.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over a protected financial system by restricting who can mutate Stripe billing objects through the agent channel; **CC6.3** — supports role-based access and least privilege: writes are tied to named IdP groups, read-only is the default for everyone else; **CC6.2** — because the gate reads live IdP claims per call, deprovisioning a user from the `finance` group revokes agent write access at the next token; **PI1.2** — supports input authorization: billing inputs enter Stripe only from authorized roles.
  - **PCI DSS 7.2.1 / 7.2.2** — supports a least-privilege access model over the cardholder-adjacent billing environment: access to modify customers, invoices, subscriptions, and disputes is limited to job-classified roles; **7.2.5** — supports least privilege for application/system accounts by narrowing what the agent's broad OAuth grant or restricted key can actually be used for on the MCP path.
  - **SOX ITGC — access to programs and data** — supports least-privilege access to a financial system that feeds revenue records (invoices, subscriptions, coupons, disputes); **SoD (COSO Principle 10)** — supports initiate/approve separation by keeping billing mutations out of non-finance hands.
  - **GDPR Art. 25** — supports data protection by design/default on the agent channel: creating customer objects (name, email — PII) requires an authorized role; **Art. 29 / 32(4)** — supports processing only on the controller's instructions: unauthorized actors (including a prompt-injected agent acting for a non-finance user) cannot mutate personal or billing data; **Art. 5(1)(b)** — supports purpose limitation; **CCPA §1798.100(e)** — supports reasonable security procedures over consumers' personal information.

  ## Tool name matching

  Matching is by suffix on `lower(input.resource.name)` — the DTwo gateway prefixes
  tool names with the configured MCP server name (e.g. `stripe-mcp-create_invoice`),
  and that prefix is not standardized. Suffix matching keeps the policy portable across:

  - **Official legacy `@stripe/mcp` (≤ v0.8.x) `verb_resource` names** — all eleven
    gated names verified from the `stripe/ai` repo history (the Claude Desktop `.dxt`
    manifest still ships them).
  - **Community `noun_verb` names** (`atharvagupta2003/mcp-stripe` style, e.g.
    `customer_create`) — the inverted forms of the same eleven tools are also gated.
    Only `customer_create` is verified from that repo; the other inversions are
    defensive and unverified (see Known limitations).
  - **Official current server (mcp.stripe.com)** — its per-resource write surface is
    collapsed into `stripe_api_write`, which this policy deliberately does not match
    (see Composition). Its read/meta tools never match the gated suffixes and pass.

  Verify the exact names your gateway sends with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  None. The decision is made purely from the tool name and the caller's identity
  (`input.subject.claims.groups`); `input.payload.args` is never inspected. The
  tool name is read from **both** `input.resource.name` and `input.payload.name`,
  and the gate fires if *either* ends with a gated suffix — so a call that carries
  the tool name only in the payload (a missing/empty `resource.name`) is still
  gated rather than falling through to the read-only allow branch. The `groups`
  claim is expected to be an **array of strings** (the common IdP shape); group
  comparison is case-insensitive. Any other shape (single string, CSV, object,
  null) fails closed — the caller is treated as not in an allowed group.

  ## Examples

  ### Allowed — read tool, no identity needed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-list_customers", "type": "tool" },
      "payload": { "name": "stripe-mcp-list_customers", "args": { "limit": 10 } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — billing write from a finance-group member

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-create_invoice", "type": "tool" },
      "subject": {
        "sub": "google-apps|ap@example.com",
        "claims": { "groups": ["finance", "employees"] }
      },
      "payload": {
        "name": "stripe-mcp-create_invoice",
        "args": { "customer": "cus_123", "days_until_due": 30 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — billing write without an allowed group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-create_customer", "type": "tool" },
      "subject": {
        "sub": "google-apps|dev@example.com",
        "claims": { "groups": ["engineering"] }
      },
      "payload": {
        "name": "stripe-mcp-create_customer",
        "args": { "name": "Jane Doe", "email": "jane@example.com" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Stripe billing writes (creating or updating customers, products, prices, payment links, invoices, coupons, subscriptions, or disputes) are restricted to the finance and billing-admin groups — your account is not in either group. Read and search tools remain available. Ask a billing administrator to make this change, or contact your InfoSec team if you believe you should have write access."`

  ## Composition

  This policy is single-purpose: it gates ordinary billing writes by role. Pair it with:

  - **Refund cap** (`apps/stripe`, PF-09 family) — governs `*create_refund` /
    `*refund_create`: amount ceilings and deny-on-full-refund. Refunds move money and
    deserve their own thresholds, not just a group gate.
  - **Escape-hatch deny** (`apps/stripe`, PF-22 family) — governs `*stripe_api_write`,
    the current official server's generic POST/PATCH/PUT/DELETE passthrough. Without
    that companion, a caller on the current server bypasses this policy's gate entirely.
  - **Dispute-submit gate** (PF-15 family) — `update_dispute` with `submit: true` files
    evidence irreversibly with the card network; a human-approval policy can strip or
    deny `submit` even for finance-group members.
  - **Egress PII redaction / PAN masking** (PF-02 / PF-01 families) — the read tools
    this policy leaves open are bulk PII egress channels (customer lists with emails).

  ## Known limitations

  - **Group names are placeholders — replace `finance` and `billing-admin` with your
    IdP's group names at import time.** If your IdP emits roles under a different claim
    (e.g. Auth0 `permissions`, or a namespaced claim like `https://acme.com/groups`),
    change the claim key in `caller_groups`.
  - **No claims → no writes.** If the gateway's `jwt_audience` is misconfigured or the
    IdP omits the `groups` claim, every gated write is denied for everyone. That is the
    intended fail-closed direction, but verify claims with `dtwo-list-claims` or the
    dump-input technique before rollout.
  - **`groups` must be an array.** A string-valued claim (`"finance"`) or CSV
    (`"finance,hr"`) does not iterate and fails closed. Adapt `caller_groups` if your
    IdP emits a non-array shape.
  - **Unverified community suffixes.** Of the `noun_verb` inversions, only
    `customer_create` is verified from the community server's source; the other ten are
    defensive guesses. Over-matching on the deny side fails safe, but a community tool
    with a different name (e.g. a hypothetical `invoice_send`) would not be gated.
  - **Enumerated allowlist, not a `create_*`/`update_*` wildcard.** The gate matches a
    fixed list of eleven known write/destructive tools (plus their community
    inversions), *not* every `create_*`/`update_*` tool. This is deliberate — a broad
    `*create_*` wildcard would also catch `create_refund`, which is intentionally
    delegated to the refund-cap companion. The trade-off: **money-relevant writes that
    exist under other names are not gated here.** In particular the community
    `atharvagupta2003/mcp-stripe` server exposes `payment_intent_create` (and, by the
    same `noun_verb` convention, plausibly `charge_create` / `payout_create` /
    `transfer_create` / `topup_create`); none of these are on the list, so an
    unauthorized caller can invoke them through this policy. Charges, payment intents,
    payouts, and transfers are **money movement** — gate them with the PF-09
    `gate-money-movement` companion (and RAK scoping), not this role gate. On the
    official current server the same operations arrive as `stripe_api_write` (see
    below), which this policy also does not match.
  - **Not a complete write freeze.** `*stripe_api_write`, `*create_refund`, and
    `stripe_report` (whose report *creation* is a write) pass through this policy by
    design — deploy the companion policies above for full coverage. Composio's
    `STRIPE_*` catalog (~415 auto-generated tools) and Stripe's unpublished Treasury
    "agentic finance" preview tools use different names and are not covered by these
    suffixes.
  - **MCP path only.** The Stripe dashboard, direct API keys, and webhooks are outside
    the gateway's reach — layer this policy with Restricted API Key (RAK) scoping
    rather than treating either as sufficient alone.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - stripe
industries: []
bundles:
  - soc2
  - pci-dss
  - sox
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package stripe.ingress.role_gate_writes

# Read-only Stripe by default: deny the gated billing writes below unless the
# caller's IdP groups include an allowed billing role. Everything else passes.
default allow := false

# Ordinary billing write / destructive tool suffixes to gate.
# The gateway prefixes tool names with the configured MCP server name
# (e.g. `stripe-mcp-create_invoice`), so we match on the suffix.
# NOTE: `*create_refund` and `*stripe_api_write` are intentionally absent —
# they are governed by the dedicated refund-cap and escape-hatch policies.
gated_write_suffixes := [
    # Official legacy @stripe/mcp (<= v0.8.x) verb_resource names — verified
    # from the stripe/ai repo history and the Claude Desktop .dxt manifest.
    "create_customer",
    "create_product",
    "create_price",
    "create_payment_link",
    "create_invoice",
    "create_invoice_item",
    "finalize_invoice",
    "create_coupon",
    "update_subscription",
    "update_dispute",
    "cancel_subscription",
    # Community noun_verb inversions (atharvagupta2003/mcp-stripe style).
    # Only customer_create is verified from that repo's source; the rest are
    # defensive inversions — over-matching on the deny side fails safe.
    "customer_create",
    "product_create",
    "price_create",
    "payment_link_create",
    "invoice_create",
    "invoice_item_create",
    "invoice_finalize",
    "coupon_create",
    "subscription_update",
    "dispute_update",
    "subscription_cancel",
]

# IdP groups permitted to perform billing writes. PLACEHOLDERS — replace with
# your IdP's group names at import time. Compared case-insensitively.
allowed_groups := {"finance", "billing-admin"}

# All tool-name fields this call carries. The gateway normally populates
# resource.name; we also consider payload.name so the gate still fires when
# resource.name is absent — a gated write is never allowed merely because the
# name field the policy reads happened to be empty (fail-safe).
candidate_tool_names := {name |
    some raw in [
        object.get(object.get(input, "resource", {}), "name", ""),
        object.get(object.get(input, "payload", {}), "name", ""),
    ]
    name := lower(raw)
}

# The call targets one of the gated billing write tools (matched on either the
# resource name or the payload name).
is_gated_write if {
    some name in candidate_tool_names
    some suffix in gated_write_suffixes
    endswith(name, suffix)
}

# Caller's IdP groups. Missing subject/claims/groups resolves to [] — the
# membership check below then never fires, so the gate fails closed.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# Caller is in at least one allowed billing group (case-insensitive).
caller_in_allowed_group if {
    some group in caller_groups
    allowed_groups[lower(group)]
}

# Reads, searches, fetches, and anything else not on the gated list pass.
allow if {
    not is_gated_write
}

# Gated billing writes require an allowed IdP group.
allow if {
    is_gated_write
    caller_in_allowed_group
}

reasons contains "Stripe billing writes (creating or updating customers, products, prices, payment links, invoices, coupons, subscriptions, or disputes) are restricted to the finance and billing-admin groups — your account is not in either group. Read and search tools remain available. Ask a billing administrator to make this change, or contact your InfoSec team if you believe you should have write access." if {
    is_gated_write
    not caller_in_allowed_group
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
