---
name: "Slack: Redact Sensitive Information from Messages"
tags:
  - slack
  - pii
  - secrets
  - dlp
  - redaction
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
  - iso27001-nist
publishedAt: 2026-07-12
description: |
  # slack / redact-sensitive-info

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `slack.ingress.redact_sensitive_info`

  ## What it does

  Redacts sensitive content from outgoing Slack message arguments before the call
  reaches Slack. It is transform-only — it never denies a call, it only rewrites
  matching content to `[REDACTED]`. Any tool that is not a Slack tool, and any
  message with no matches, passes through untouched.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission of confidential
    information: PII and credentials are masked before they move into Slack.
  - **PCI DSS 3.2.1** — supports minimizing account-data sprawl by masking
    card-number-shaped strings before they land in a system outside the CDE;
    **8.6.2** — supports keeping credentials out of chat by redacting keys,
    tokens, and passwords.
  - **HIPAA §164.502(b) / §164.514(b)** — supports minimum necessary and
    de-identification: several Safe-Harbor identifier classes (SSN, phone,
    email) are redacted from outbound messages.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent channel;
    **CCPA §1798.150** — reduces nonredacted-PI exposure if chat history is
    later breached.
  - **ISO 27001 A.8.11** — data masking; **A.8.12** — data leakage prevention on
    the agent's Slack write path.

  ## Why ingress

  Sending a Slack message is a write with permanent side effects — once the call
  reaches Slack the content exists in channel history and may be syndicated to
  search, digests, and other members. Redacting on the request (ingress) path is
  the only way to keep the secret out of Slack entirely; an egress policy could
  only mask what is read back, not what was posted.

  ## Scope / tool matching

  Applies to any tool whose first hyphen-separated name segment starts with
  `slack`, so it works regardless of how the Slack MCP server is named on a
  given gateway (`slack-...`, `slack-prod-...`, `slack-mcp-...`). Confirm the
  exact tool names your gateway emits with the dump-input debug technique.

  ## Fields inspected

  - `text` and `message` — string bodies; redacted in place when they match.
  - `blocks` (Block Kit) and `attachments` (legacy) — serialized to JSON, byte-
    replaced, then reparsed.

  Only fields that actually contain a match are rewritten. Clean fields, absent
  fields, and all other arguments (`channel`, `thread_ts`, etc.) pass through
  unchanged. For `blocks`/`attachments`, if the replacement would produce invalid
  JSON the field's patch is silently omitted, so the policy never emits malformed
  arguments (fail-safe).

  ## What gets redacted

  A single alternation pattern covers:

  - **PII** — US SSN, credit-card numbers, email addresses, US phone numbers.
  - **Cloud / SaaS API keys (vendor-prefixed)** — AWS (`AKIA`/`ASIA`), Google
    (`AIza`, `ya29.`), GitHub (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`), GitLab
    (`glpat-`), Slack (`xox[abprs]-`), Stripe (`sk_live_`/`sk_test_`/`pk_live_`/
    `pk_test_`).
  - **OAuth / bearer** — `Authorization: Bearer <token>` and JWTs
    (`header.payload.signature`).
  - **Generic secrets** — `api_key`/`apikey`/`secret_key` and
    `password`/`secret`/`token`/`credentials`/`client_secret` assignments.
  - **Database connection strings** — URI (`postgres://`, `mysql://`,
    `mongodb+srv://`, `redis://`, `amqp://`, `mssql://`), JDBC, and ADO.NET
    (`Server=...;User Id=...;Password=...`).
  - **PEM private keys** — `-----BEGIN ... PRIVATE KEY----- ... -----END ...-----`.

  The pattern set is shared with the JIRA egress redaction policy
  (`jira.egress.redact_sensitive_info`). Tune it for your environment — add token
  shapes for providers you use, and remove patterns that are noisy for your
  traffic.

  ## Examples

  ### Redacted

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack-post-message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack-post-message",
        "args": { "channel": "C123", "text": "here's the api_key: sk-abcd1234..." }
      }
    }
  }
  ```

  The `text` argument is rewritten to `here's the [REDACTED]`; `channel` is
  untouched. `allow = true`.

  ### Passthrough

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "slack-mcp-slack-post-message", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack-post-message",
        "args": { "channel": "C123", "text": "lunch in 5" }
      }
    }
  }
  ```

  No match, no transform — args pass through unchanged. `allow = true`.

  ## Composition

  Transform-only and `default allow := true`, so it composes cleanly with deny
  policies on the same ingress pipeline (e.g.
  [`block-secrets`](../block-secrets/policy.md),
  [`deny-direct-messages`](../deny-direct-messages/policy.md)). `block-secrets`
  *blocks* a message that looks like it contains a secret; this policy *redacts*
  the secret and lets the message through — choose one posture per deployment, or
  order them deliberately if you attach both.

  ## Known limitations

  - **Regex over text.** Expect general-purpose false positives (e.g. an email-
    shaped substring inside a longer token) and false negatives (custom-format or
    short-lived secrets that match no known shape). Treat this as a high-signal
    first line of defense, not a complete DLP solution.
  - **Inspected fields are fixed.** Only `text`, `message`, `blocks`, and
    `attachments` are scanned. If your Slack MCP server carries body content under
    another argument, add a corresponding patch rule.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - slack
industries: []
bundles:
  - slack
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.ingress.redact_sensitive_info

# Transform-only policy: redacts sensitive content from outgoing Slack message
# args before the call reaches Slack. Never denies. Uses the same pattern set
# as the JIRA egress redact policy (jira.egress.redact_sensitive_info).
default allow := true

# -----------------------------------------------------------------------------
# Tool matching — any tool whose server-name segment starts with "slack".
# Matches "slack-...", "slack3-...", "slack-prod-...", etc.
# -----------------------------------------------------------------------------

is_slack_tool if {
    name := lower(input.resource.name)
    server_name := split(name, "-")[0]
    startswith(server_name, "slack")
}

# -----------------------------------------------------------------------------
# Sensitive-content regex — every shape we want to redact, joined into a
# single alternation so one regex.replace call covers them all per field.
# (?i:...) groups scope case-insensitive matching to specific alternatives so
# vendor-prefixed shapes (AKIA, ghp_, sk_live_, etc.) stay case-sensitive.
# -----------------------------------------------------------------------------

sensitive_pattern := concat("|", [
    # ---- PII ----
    `\d{3}-\d{2}-\d{4}`,                                    # US SSN
    `\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}`,                  # Credit card
    `[\w.-]+@[\w.-]+\.[\w.-]+`,                             # Email
    `\+?1?[- .]?\(?\d{3}\)?[- .]?\d{3}[- .]?\d{4}`,         # US phone

    # ---- Cloud / SaaS API keys (vendor-prefixed) ----
    `AKIA[0-9A-Z]{16}`,                                     # AWS access key ID
    `ASIA[0-9A-Z]{16}`,                                     # AWS temporary (STS) access key
    `AIza[0-9A-Za-z_-]{35}`,                                # Google API key
    `ya29\.[0-9A-Za-z_-]+`,                                 # Google OAuth access token
    `ghp_[A-Za-z0-9]{36}`,                                  # GitHub personal access token
    `gho_[A-Za-z0-9]{36}`,                                  # GitHub OAuth token
    `ghu_[A-Za-z0-9]{36}`,                                  # GitHub user-to-server token
    `ghs_[A-Za-z0-9]{36}`,                                  # GitHub server-to-server token
    `ghr_[A-Za-z0-9]{36}`,                                  # GitHub refresh token
    `glpat-[A-Za-z0-9_-]{20}`,                              # GitLab personal access token
    `xox[abprs]-[A-Za-z0-9-]+`,                             # Slack tokens (bot/app/user/refresh/etc.)
    `sk_live_[A-Za-z0-9]{24,}`,                             # Stripe live secret key
    `sk_test_[A-Za-z0-9]{24,}`,                             # Stripe test secret key
    `pk_live_[A-Za-z0-9]{24,}`,                             # Stripe live publishable key
    `pk_test_[A-Za-z0-9]{24,}`,                             # Stripe test publishable key

    # ---- OAuth / bearer ----
    `(?i:bearer\s+[A-Za-z0-9._~+/-]+=*)`,                   # Authorization: Bearer <token>
    `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`, # JWT (header.payload.signature)

    # ---- Generic key=value secret patterns ----
    `(?i:(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*\S+)`,
    `(?i:(?:password|passwd|pwd|secret|token|credentials|client[_-]?secret)\s*[:=]\s*\S+)`,

    # ---- Database connection strings ----
    `(?i:(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?|mssql|sqlserver)://[^:\s]+:[^@\s]+@[^/\s]+(?:/\S*)?)`,
    `(?i:jdbc:[a-z0-9]+:[^\s]+)`,
    `(?i:(?:Server|Data Source)\s*=\s*[^;]+;\s*(?:User Id|UID)\s*=\s*[^;]+;\s*(?:Password|PWD)\s*=\s*[^;]+)`,

    # ---- PEM private keys ----
    `-----BEGIN [A-Z ]+PRIVATE KEY-----.+?-----END [A-Z ]+PRIVATE KEY-----`,
])

replacement := "[REDACTED]"

# -----------------------------------------------------------------------------
# Per-field patches — each is added only when this is a Slack tool, the field
# exists, and it contains at least one match. Fields without matches (and
# absent fields) are left untouched in the final args.
# -----------------------------------------------------------------------------

patches[k] := v if {
    k := "text"
    is_slack_tool
    original := object.get(input.payload.args, k, "")
    is_string(original)
    regex.match(sensitive_pattern, original)
    v := regex.replace(original, sensitive_pattern, replacement)
}

patches[k] := v if {
    k := "message"
    is_slack_tool
    original := object.get(input.payload.args, k, "")
    is_string(original)
    regex.match(sensitive_pattern, original)
    v := regex.replace(original, sensitive_pattern, replacement)
}

# Block Kit blocks: serialize → byte-replace → reparse. If the byte-replace
# produces invalid JSON (possible if a pattern chews across boundaries), the
# unmarshal fails and this patch is silently omitted — fail-safe rather than
# emitting malformed args.
patches[k] := v if {
    k := "blocks"
    is_slack_tool
    original := object.get(input.payload.args, k, null)
    original != null
    serialized := json.marshal(original)
    regex.match(sensitive_pattern, serialized)
    v := json.unmarshal(regex.replace(serialized, sensitive_pattern, replacement))
}

# Legacy attachments: same treatment as blocks.
patches[k] := v if {
    k := "attachments"
    is_slack_tool
    original := object.get(input.payload.args, k, null)
    original != null
    serialized := json.marshal(original)
    regex.match(sensitive_pattern, serialized)
    v := json.unmarshal(regex.replace(serialized, sensitive_pattern, replacement))
}

# -----------------------------------------------------------------------------
# Apply the transform only when at least one field needs redaction.
# object.union overwrites only the keys present in `patches`; every other arg
# (channel_id, thread_ts, etc.) passes through unchanged.
# -----------------------------------------------------------------------------

transform := {
    "transformed_payload": object.union(input.payload.args, patches)
} if {
    is_slack_tool
    count(patches) > 0
}
```
