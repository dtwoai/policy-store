---
name: Deny Stripe API-Write Escape Hatch
tags:
  - stripe
  - deny-escape-hatches
  - ingress
  - sox
  - soc2
publishedAt: 2026-07-12
description: |
  # stripe / deny-escape-hatches-api-write

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny
  **Package:** `stripe.ingress.deny_escape_hatches_api_write`

  ## What it does

  Denies the `stripe_api_write` meta-tool — the single raw passthrough on the
  official Stripe MCP server that can execute **any** Stripe `POST`, `PATCH`,
  `PUT`, or `DELETE` method (payouts, transfers, account mutations, refunds,
  subscription changes) and would otherwise bypass every named-tool policy —
  in two layers:

  1. **Role gate:** callers whose IdP `groups` claim does not include
     `finance` or `billing-admin` cannot use the passthrough at all.
  2. **Endpoint hard stop:** even for those groups, the call is denied when
     the serialized argument object contains a money-movement or account
     token — `payouts`, `transfers`, `topups`, `financial_connections`,
     Connect `accounts`, or any connected-account id (`acct_…`). The account
     tokens are bare (not `/v1/accounts`) so they catch account mutation and
     Connect money routing regardless of how the passthrough names the field
     (a path string, a `resource` key, or a `transfer_data.destination` /
     `on_behalf_of` id).

  All other tools pass through unchanged. The check runs at ingress, so a
  blocked call never reaches Stripe and no side effect occurs.

  ## Compliance alignment

  - **PCI DSS 7.2.1 / 7.2.2** — supports the least-privilege access model:
    the raw write passthrough is a privileged channel into the payment
    account, and this policy restricts it to defined roles with defined
    endpoint limits. **7.2.5** — supports least privilege for the agent's
    application account by narrowing what its Stripe grant can reach over MCP.
  - **SOC 2 CC6.1** — supports logical access security over protected assets;
    **CC6.3** — supports role-based access and least privilege on the one
    tool that collapses Stripe's entire write surface into a single name.
  - **SOX ITGC (access to programs & data)** — supports least-privilege
    access to a financial system's write path; **Rule 13a-15(f)(3)** —
    supports safeguarding of assets by blocking payout, transfer, top-up,
    and account-mutation endpoints outright on the agent channel.

  ## Why ingress and not egress

  `stripe_api_write` executes irreversible, externally visible writes — a
  payout that has left the balance cannot be recalled by redacting the
  response. Ingress denial is the only placement that actually prevents the
  action.

  ## Tool name matching

  Matches by suffix on `lower(input.resource.name)`:

  - `*stripe_api_write` — the official server's passthrough (verified from
    docs.stripe.com/mcp)
  - `*api_write` — broader stem for renamed deployments that keep the suffix

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `stripe-mcp-stripe_api_write`), and that prefix is not standardized —
  suffix matching keeps the policy portable. Verify the exact name your
  gateway sends with the dump-input debug technique before relying on this
  in production.

  ## Argument shape

  The exact argument field names of `stripe_api_write` (e.g. `path` vs
  `method` vs `params`) are **not published and are unverified** — the
  landscape research could not capture a live schema without an authenticated
  `tools/list`. The policy therefore does not index any specific key: it
  serializes the whole of `input.payload.args` with `json.marshal` and
  matches the endpoint tokens case-insensitively on `lower(...)` as
  substrings. This makes the endpoint hard stop hold regardless of the real
  key shape, including tokens nested arbitrarily deep in the argument object.

  ## Examples

  ### Allowed — finance caller, non-money endpoint

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-stripe_api_write", "type": "tool" },
      "subject": { "sub": "auth0|cfo", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "stripe-mcp-stripe_api_write",
        "args": { "path": "/v1/customers", "method": "POST", "params": { "name": "Acme" } }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — caller outside finance/billing-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-stripe_api_write", "type": "tool" },
      "subject": { "sub": "auth0|dev", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "stripe-mcp-stripe_api_write",
        "args": { "path": "/v1/customers", "method": "POST" }
      }
    }
  }
  ```

  `allow = false`, reason directs the caller to the dedicated named tools.

  ### Denied — money-movement endpoint, even for finance

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-stripe_api_write", "type": "tool" },
      "subject": { "sub": "auth0|cfo", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "stripe-mcp-stripe_api_write",
        "args": { "path": "/v1/payouts", "method": "POST", "params": { "amount": 500000 } }
      }
    }
  }
  ```

  `allow = false` for everyone — money movement goes through the dedicated
  named tools or the Stripe dashboard.

  ## Composition

  This policy closes the passthrough so it cannot reach a surface the named-
  tool policies restrict. Pair it with its Stripe companions from the same
  family set:

  - the **refund-cap** policy (PF-09), which bounds `*create_refund` amounts —
    without this policy, `stripe_api_write` could issue an uncapped refund
    directly against `/v1/refunds`;
  - the **role-gate / read-only** policy (PF-12), which restricts the named
    write tools (`*create_*`, `*update_*`, `*cancel_subscription`, …) to the
    same finance groups.

  Layer all of them with Stripe Restricted API Key (RAK) scoping — DTwo
  policy and key scoping are complementary control planes, not either/or.

  ## Known limitations

  - **Group names are placeholders** — replace `finance` and `billing-admin`
    with your IdP's group names at import time. Missing or malformed `groups`
    claims fail closed (the caller is treated as unprivileged).
  - **Unverified argument schema.** The endpoint tokens are matched as
    substrings of the serialized argument object because the passthrough's
    field names are unverified. Capture a live schema from your gateway and
    tighten the match to the real endpoint key if you need fewer false
    positives.
  - **Substring false positives.** A privileged caller writing a benign value
    that merely *mentions* a token (e.g. a description string containing
    "payouts", or any argument carrying a connected-account `acct_…` id) is
    denied. On Connect platforms the `accounts` / `acct_` tokens will deny a
    broad range of connected-account operations — this is the deliberate
    fail-closed trade-off for the account hard stop; the deny reason carries an
    escalation hint.
  - **Parameter-level money movement not fully covered.** The hard stop keys on
    endpoint/account tokens, not on every money-moving *parameter*. A Connect
    charge that routes money via `transfer_data.destination` or `on_behalf_of`
    is caught because those values carry an `acct_…` id, but a direct-charge
    `application_fee_amount` with no account reference carries none of the
    tokens and passes the endpoint check (the group gate still applies). Money
    movement that must name a destination account is covered; fee-only
    parameters on non-money endpoints are a residual — pair with RAK scoping.
  - **Missing args pass the endpoint check.** A privileged caller invoking
    the passthrough with no arguments at all serializes to `{}` and passes
    the endpoint hard stop (the group gate still applies). Such a call
    carries no endpoint and fails at the Stripe API anyway.
  - **Obfuscation residual.** Endpoint strings encoded (base64, URL-escaped,
    split across fields) would not match the tokens — though such values
    would also not be valid Stripe method identifiers. RAK scoping is the
    backstop control plane.
  - **Scope.** Legacy per-resource write tools (`create_refund`,
    `update_subscription`, …) are governed by the companion role-gate and
    refund-cap policies, not this one. Stripe Treasury preview tool names are
    unpublished/unverified and are not covered. Composio's `STRIPE_*` action
    slugs do not share the `api_write` suffix and are out of scope.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - stripe
industries: []
bundles:
  - sox
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package stripe.ingress.deny_escape_hatches_api_write

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# IdP groups permitted to touch the raw API-write passthrough at all.
# Placeholders — replace with your IdP's group names at import time.
allowed_groups := {"finance", "billing-admin"}

# Endpoint tokens that indicate money movement or account mutation. Matched
# case-insensitively as substrings of the serialized argument object because
# the passthrough's argument field names are unverified (see Known
# limitations in the description).
blocked_endpoint_tokens := [
	# /v1/payouts — money out of the Stripe balance to an external account
	"payouts",
	# /v1/transfers — Connect money movement between accounts
	"transfers",
	# /v1/topups — funding the Stripe balance from a bank account
	"topups",
	# accounts — Connect account creation/mutation/deletion. Bare token (NOT
	# "/v1/accounts") so it matches whatever shape the passthrough uses to
	# express the endpoint (a "/v1/accounts" path, a "resource": "accounts"
	# key, external_accounts/bank_accounts sub-resources). "/v1/accounts" alone
	# would only catch the full-path form and miss the others.
	"accounts",
	# acct_ — any reference to a connected-account id (destination charges,
	# transfer_data.destination, on_behalf_of, direct account updates) is
	# Connect money-movement / account-mutation surface expressed by id rather
	# than by endpoint path.
	"acct_",
	# /v1/financial_connections — linked bank-account sessions and data
	"financial_connections",
]

# Tool name, lowercased; empty string when the resource block is absent.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# The official Stripe server's raw write passthrough. Suffix match keeps the
# policy portable across gateway server-name prefixes. Verify the exact name
# your gateway sends with the dump-input debug technique.
is_api_write_tool if {
	endswith(tool_name, "stripe_api_write")
}

# Broader stem for renamed deployments that keep the api_write suffix.
is_api_write_tool if {
	endswith(tool_name, "api_write")
}

# Caller belongs to a group allowed to use the passthrough. Missing or
# malformed claims fail closed: no groups -> not privileged.
caller_is_privileged if {
	claims := object.get(object.get(input, "subject", {}), "claims", {})
	groups := object.get(claims, "groups", [])
	some g in groups
	lower(g) in allowed_groups
}

# Serialize the whole argument object so the endpoint check holds regardless
# of the passthrough's (unverified) argument key shape.
serialized_args := lower(json.marshal(object.get(object.get(input, "payload", {}), "args", {})))

args_reference_blocked_endpoint if {
	some token in blocked_endpoint_tokens
	contains(serialized_args, token)
}

# Any tool other than the API-write passthrough is out of this policy's scope.
allow if {
	not is_api_write_tool
}

# The passthrough is allowed only for privileged callers, and never toward
# money-movement or account endpoints.
allow if {
	is_api_write_tool
	caller_is_privileged
	not args_reference_blocked_endpoint
}

reasons contains "The Stripe API-write passthrough can execute any Stripe write and is restricted to the finance and billing-admin groups. Use the dedicated named Stripe tools for routine changes, or ask your Stripe administrator for access. Contact your InfoSec team if this was a false positive." if {
	is_api_write_tool
	not caller_is_privileged
}

reasons contains "This Stripe API-write call references a money-movement or account endpoint (payouts, transfers, topups, /v1/accounts, financial_connections), which is blocked for every caller on the agent channel. Use the dedicated named Stripe tools or the Stripe dashboard for money movement. Contact your InfoSec team if this was a false positive." if {
	is_api_write_tool
	args_reference_blocked_endpoint
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
