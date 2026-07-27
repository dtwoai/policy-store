---
name: Scrub Unapproved Stripe Payment-Link Redirects
tags:
  - stripe
  - guard-share-links
  - ingress
  - transform
  - phishing
  - prompt-injection
  - soc2
publishedAt: 2026-07-12
description: |
  # stripe / guard-share-links-payment-redirect

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `stripe.ingress.guard_share_links_payment_redirect`

  ## What it does

  Scrubs the post-payment redirect from Stripe payment-link creation calls. On
  `*create_payment_link` tool calls it reads the `redirect_url` argument and,
  when it is non-empty and its host is **not** on a configured domain
  allowlist, emits a transform that removes the key — the payment link is
  created without a redirect and Stripe shows its default hosted confirmation
  page instead.

  A payment link is a **public, customer-facing URL**. Its redirect is where
  the paying customer's browser is sent the moment payment completes — a
  prompt-injected agent that sets an attacker-controlled `redirect_url` turns
  every link it mints into a phishing/exfiltration vector aimed at your
  customers, on a page that carries your Stripe branding. Stripe also appends
  the checkout session id to the redirect, handing the attacker a session
  reference. Stripping the argument neutralizes the vector while letting the
  legitimate work (creating the link) proceed.

  The allowlist (`allowed_redirect_hosts`) **ships empty on purpose**: pin it
  to your own domains at import time (exact lowercase host match, e.g.
  `"checkout.example.com"`). With the empty default, **every** `redirect_url`
  is stripped. The policy runs at ingress, before the public link is minted,
  so an unapproved redirect never exists on a live URL.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission and movement of
    information by preventing an agent from wiring a customer-facing payment
    flow to an unapproved external destination on the MCP path.
  - **SOC 2 P6.1** — supports limits on disclosure of personal information to
    third parties: an attacker-controlled redirect would land paying customers
    (and the appended checkout-session reference) on a third-party host
    positioned to harvest their data.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing for the
    customer payment journey: the post-payment step cannot be diverted to
    infrastructure outside the controller's approved domains.
  - **GDPR Art. 25** — supports data protection by design and by default: the
    allowlist is empty by default, so the safe behavior (no redirect) is the
    default behavior until the tenant explicitly pins its own domains.

  ## Tool name matching

  Matches by suffix on `lower(input.resource.name)`, case-insensitively,
  because the DTwo gateway prefixes tool names with the configured MCP server
  name (e.g. `stripe-mcp-create_payment_link`) and that prefix is not
  standardized:

  - `*create_payment_link` — the legacy per-resource tool set (`@stripe/mcp`
    v0.8.x, the Claude Desktop `.dxt` manifest, and pre-migration
    `@stripe/agent-toolkit` embeddings), verified from the `stripe/ai` repo
    history.

  The **current** official meta-tool server (mcp.stripe.com / `@stripe/mcp`
  ≥ 0.9) has no dedicated payment-link tool — payment links are created through
  the generic `stripe_api_write` escape hatch, which this policy does not
  parse. See Composition and Known limitations. Composio and other aggregator
  tool names for payment links are unverified — confirm the exact name your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  Legacy `create_payment_link` takes (verified from source):

  ```jsonc
  { "price": "price_...", "quantity": 1, "redirect_url": "https://..." }
  ```

  The policy reads `redirect_url` via
  `object.get(input.payload.args, "redirect_url", "")` and never touches
  `price`/`quantity`. Host extraction drops the scheme, cuts the authority at
  the first `/`, `\`, `?`, or `#`, drops userinfo (`user@`, keeping the host
  after the **last** `@`) and the port, and lowercases. Backslash is treated
  as a path delimiter because WHATWG-conformant browsers normalize `\` to `/`
  in http/https authorities — otherwise `https://evil.example\@allowed/`
  would parse here as the allowlisted `allowed` while the browser navigated to
  `evil.example`. Values with no `://` scheme, non-string values, and anything
  else that fails to parse are treated as **unapproved (fail closed)** and
  stripped. The tool-name match reads both `resource.name` and its legacy
  `payload.name` alias via `object.get`, so a call missing one of them cannot
  slip the scrub.

  ## Examples

  ### Transformed — redirect host not on the allowlist

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-create_payment_link", "type": "tool" },
      "payload": {
        "name": "stripe-mcp-create_payment_link",
        "args": {
          "price": "price_1QxAbC",
          "quantity": 1,
          "redirect_url": "https://stripe-thanks.attacker.example/collect"
        }
      }
    }
  }
  ```

  `allow = true`, transform rewrites args to
  `{ "price": "price_1QxAbC", "quantity": 1 }` — the link is created with no
  redirect.

  ### Allowed unchanged — no redirect requested

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-create_payment_link", "type": "tool" },
      "payload": {
        "name": "stripe-mcp-create_payment_link",
        "args": { "price": "price_1QxAbC", "quantity": 2 }
      }
    }
  }
  ```

  `allow = true`, no transform.

  ## Composition

  Single-purpose by design. Pair with:

  - [`stripe/deny-escape-hatches-api-write`](../deny-escape-hatches-api-write/policy.md)
    — on the current meta-tool server, payment links (and their
    `after_completion` redirects) are created via `stripe_api_write`; this
    policy cannot see inside that call, so gate the escape hatch itself.
  - [`stripe/gate-money-movement-refund-cap`](../gate-money-movement-refund-cap/policy.md)
    — group-gates and caps the refund surface.

  ## Known limitations

  - **Allowlist ships empty — pin it at import time.** Until you add your own
    domains to `allowed_redirect_hosts`, every `redirect_url` is stripped,
    including legitimate ones. The allowed-host branch is therefore not
    exercisable against the shipped constant; verify it after pinning.
  - **Exact host match.** Subdomains are not implied — list
    `www.example.com` and `example.com` separately. IPv6-literal hosts cannot
    be allowlisted (their bracket syntax never survives host extraction) and
    are always stripped.
  - **Host extraction only bites once an allowlist is pinned.** With the
    shipped empty allowlist every redirect is stripped regardless of how its
    host parses, so the host-parsing edge cases (userinfo `@`, backslash
    authority terminators, ports) matter only after you pin
    `allowed_redirect_hosts`. The extractor models the common browser
    normalizations (`\`→`/`, last-`@` host, port drop) but is not a full
    WHATWG URL parser: other exotic normalizations (embedded tab/newline
    stripping, percent-encoded delimiters, trailing-dot FQDNs) are not
    modeled. Every one of them extracts a host that will simply fail the exact
    match and be stripped (fail closed) — the reverse (a stripped-worthy URL
    surviving) is what the backslash handling closes. Re-verify against your
    pinned hosts after import.
  - **Escape hatch not covered.** `stripe_api_write` on the current official
    server can create payment links with a redirect in nested
    `after_completion` parameters; this policy matches only the dedicated
    `*create_payment_link` tools. Compose with
    `stripe/deny-escape-hatches-api-write`.
  - **Silent scrub.** Transform-only policies do not return a reason; the
    agent learns the redirect was dropped only if it re-reads the created
    link. If you prefer a hard failure the agent can react to, convert the
    transform condition into a deny.
  - **Aggregator tool names unverified.** Composio's `STRIPE_*` slugs and
    other community servers may expose payment-link creation under names that
    do not end in `create_payment_link`; verify with the dump-input technique.
  - **No identity exemptions.** All callers are subject to the same scrub. If
    a trusted group should be allowed arbitrary redirects, add a separate
    `input.subject.claims.groups`-gated branch.

  > **Compliance note.** This policy supports alignment with the cited
  > framework controls **on the MCP path only**. No policy or bundle makes an
  > organization compliant with any framework; web-UI, native-API, and in-app
  > access are outside the gateway's reach by design. Validate against your
  > own compliance program before relying on it.
direction: ingress
apps:
  - stripe
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package stripe.ingress.guard_share_links_payment_redirect

# Transform-only policy — never denies, only scrubs unapproved redirect URLs.
default allow := true

# Hosts allowed to receive the post-payment redirect. Ships EMPTY on purpose:
# pin it to your own domains at import time (exact lowercase host match, e.g.
# "checkout.example.com"; list subdomains individually). With the empty
# default every redirect_url is stripped and the payment link falls back to
# Stripe's default hosted confirmation page.
allowed_redirect_hosts := []

# Payment-link creation tools, matched case-insensitively by suffix because
# the gateway prefixes tool names with the configured MCP server name
# (e.g. `stripe-mcp-create_payment_link`). Covers the legacy per-resource
# Stripe tool set; the current meta-tool server routes payment-link creation
# through `stripe_api_write` (see policy description — compose with
# stripe/deny-escape-hatches-api-write).
#
# Read the tool name via object.get from BOTH the PARC `resource.name` and its
# legacy `payload.name` alias (both populated on tool hooks, same value). A
# bare `input.resource.name` index is undefined when `resource`/`name` is
# absent, which would make this rule — and therefore the scrub transform —
# silently no-op and pass an attacker redirect straight through (fail open).
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

tool_name_alias := lower(object.get(object.get(input, "payload", {}), "name", ""))

is_create_payment_link if endswith(tool_name, "create_payment_link")

is_create_payment_link if endswith(tool_name_alias, "create_payment_link")

args := object.get(object.get(input, "payload", {}), "args", {})

redirect_url := object.get(args, "redirect_url", "")

# Extract the host from the redirect URL: drop the scheme, cut the authority
# at the first `/`, `?`, or `#`, drop any userinfo (`user@`), drop the port,
# and lowercase. Undefined for scheme-less or non-string values — those are
# treated as unapproved (fail closed) and stripped.
redirect_host := host if {
	parts := split(lower(trim_space(redirect_url)), "://")
	count(parts) >= 2
	# Cut the authority at the first path delimiter. Browsers following the
	# WHATWG URL spec treat a backslash in a special-scheme (http/https) URL
	# exactly like a forward slash, so `\` ALSO terminates the authority —
	# split on it too. Without this, `https://evil.example\@allowed.example/`
	# is read here as host `allowed.example` (the last `@`-segment) while the
	# browser navigates to `evil.example`, silently defeating a pinned
	# allowlist.
	authority_and_path := split(split(parts[1], "/")[0], "\\")[0]
	authority_and_query := split(authority_and_path, "?")[0]
	authority := split(authority_and_query, "#")[0]
	# Userinfo tricks like `https://trusted.example@evil.example/` put the real
	# host after the LAST `@`.
	host_candidates := split(authority, "@")
	hostport := host_candidates[count(host_candidates) - 1]
	host := split(hostport, ":")[0]
}

host_is_allowed if {
	some allowed in allowed_redirect_hosts
	lower(allowed) == redirect_host
}

# Strip redirect_url whenever it is present and its host is not approved.
transform := {"transformed_payload": object.remove(args, ["redirect_url"])} if {
	input.action == "tool_pre_invoke"
	is_create_payment_link
	redirect_url != ""
	not host_is_allowed
}
```
