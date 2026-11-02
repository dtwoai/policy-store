---
name: "Datadog: Redact Secrets and Emails from Responses"
tags:
  - datadog
  - observability
  - secrets
  - pii
  - redaction
  - egress
publishedAt: 2026-10-11
description: |
  # datadog / redact-secrets-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only, never denies)
  **Package:** `datadog.egress.redact_secrets`

  ## What it does

  Logs are where secrets actually leak: a debug line that prints a request header, a stack
  trace with a connection string, a config dump at startup. This policy masks credentials and
  email addresses in every Datadog response before the text reaches the agent, so they never
  end up in the model's context, a chat transcript, or a ticket the agent writes.

  - **Credentials** are replaced with `[REDACTED-SECRET]`: `password=` / `token:` /
    `api_key=` style pairs, AWS access keys and secret keys, GitHub and GitLab tokens, Slack
    tokens, Stripe live keys, Google API keys, OpenAI-style keys, PEM private keys, JWTs,
    `Bearer` tokens, and the password part of connection strings
    (`postgres://app:[REDACTED-SECRET]@db`).
  - **Email addresses** are replaced with `[REDACTED-EMAIL]`.
  - Everything else in the response is returned unchanged. JSON responses keep their
    structure: only string values are rewritten, and a match never runs past the end of the
    value it's in. If nothing matches, the response is passed through byte for byte.

  Applies to every tool on the Datadog server — logs, spans, events, RUM, incidents,
  notebooks — since any of them can carry log text.

  ## Compliance alignment

  - **SOC 2 CC6.7** — restricts movement of confidential information (credentials) into a new
    system (the agent's context).
  - **GDPR Art. 5(1)(c), Art. 32** — data minimisation and security of processing for personal
    data (email addresses) found in logs.

  ## Why egress

  The secrets are already in Datadog; the only place to stop them is on the way back to the
  agent. Only the response is rewritten — the data in Datadog is untouched.

  ## Examples

  ### Redacted

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "datadog-search_datadog_logs", "type": "tool" },
      "payload": { "text": [ "ERROR auth failed for jane@acme.com token=abc123def456" ] }
    }
  }
  ```

  `transform.transformed_payload.text` = `["ERROR auth failed for [REDACTED-EMAIL] [REDACTED-SECRET]"]`.

  ## Composition

  Pairs with [`datadog/read-only-except-notebooks`](../read-only-except-notebooks/policy.md)
  and [`datadog/cap-search-window`](../cap-search-window/policy.md). The same pattern set is used by
  [`splunk/redact-secrets-egress`](../../splunk/redact-secrets-egress/policy.md) and, for
  credentials, [`github/redact-secrets-egress`](../../github/redact-secrets-egress/policy.md).

  ## Known limitations

  - **Server name prefix.** Scope is tools whose name starts with `datadog`. Change
    `_is_datadog` if your server is registered under another name.
  - **Known shapes only.** Secrets that don't match a listed shape (custom tokens, short
    hex keys) pass through. Add your providers' formats to `secret_patterns`.
  - **Re-serialized JSON.** When a JSON response is changed, it's returned minified with keys
    sorted. The content is the same.
  - **Emails are always masked.** If your investigations need email addresses (for example,
    tracing one user's session), drop the email pattern or scope the policy more narrowly.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - datadog
industries: []
bundles:
  - engineering-stack-jira
  - engineering-stack-linear
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package datadog.egress.redact_secrets

# Transform-only egress policy — never denies. Masks credentials and email
# addresses in responses before they enter agent context. JSON responses keep their structure: only
# string values are rewritten.
default allow := true

secret_marker := "[REDACTED-SECRET]"

email_marker := "[REDACTED-EMAIL]"

email_pattern := `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`

# Credential shapes, applied in order. JWT and Bearer come before the generic
# key=value pair so a token is masked whole. The generic value stops at quotes,
# commas, and semicolons so it never eats into neighbouring text.
secret_patterns := [
    # JSON Web Tokens
    `eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
    # Bearer tokens
    `(?i)bearer\s+[A-Za-z0-9._~+/-]{16,}=*`,
    # Generic password / token / api_key / secret in `key: value` or `key=value` form
    `(?i)(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s"'<>,;]+`,
    # AWS access key IDs (long-term and temporary)
    `(?:AKIA|ASIA)[0-9A-Z]{16}`,
    # AWS secret access keys (40-char base64-ish, anchored near the word "aws")
    `(?i)aws(.{0,20})?(secret|access)?.{0,20}[\s:=]+[A-Za-z0-9/+=]{40}`,
    # GitHub tokens (personal, OAuth, user, server, refresh) and fine-grained PATs
    `gh[pousr]_[A-Za-z0-9]{36}`,
    `github_pat_[A-Za-z0-9_]{82}`,
    # GitLab personal access tokens
    `glpat-[A-Za-z0-9_-]{20}`,
    # Slack tokens
    `xox[baprs]-[A-Za-z0-9-]{10,}`,
    # Stripe live secret and restricted keys
    `(?:sk|rk)_live_[A-Za-z0-9]{24,}`,
    # Google API keys
    `AIza[0-9A-Za-z\-_]{35}`,
    # OpenAI-style API keys
    `sk-[A-Za-z0-9_-]{20,}`,
    # PEM private key blocks, then any stray header
    `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
    `-----BEGIN [A-Z ]*PRIVATE KEY-----`,
]

# Passwords embedded in connection strings (postgres://user:pass@host): keep the
# scheme and user, mask the password.
conn_string_pattern := `(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@"']+:)[^\s@/"']+@`

# --- Redaction of one string (Rego has no recursion, so the fold is a chain) ---

_redact(t) := out if {
    r0 := regex.replace(t, secret_patterns[0], secret_marker)
    r1 := regex.replace(r0, secret_patterns[1], secret_marker)
    r2 := regex.replace(r1, secret_patterns[2], secret_marker)
    r3 := regex.replace(r2, secret_patterns[3], secret_marker)
    r4 := regex.replace(r3, secret_patterns[4], secret_marker)
    r5 := regex.replace(r4, secret_patterns[5], secret_marker)
    r6 := regex.replace(r5, secret_patterns[6], secret_marker)
    r7 := regex.replace(r6, secret_patterns[7], secret_marker)
    r8 := regex.replace(r7, secret_patterns[8], secret_marker)
    r9 := regex.replace(r8, secret_patterns[9], secret_marker)
    r10 := regex.replace(r9, secret_patterns[10], secret_marker)
    r11 := regex.replace(r10, secret_patterns[11], secret_marker)
    r12 := regex.replace(r11, secret_patterns[12], secret_marker)
    r13 := regex.replace(r12, secret_patterns[13], secret_marker)
    r14 := regex.replace(r13, conn_string_pattern, concat("", ["${1}", secret_marker, "@"]))
    out := regex.replace(r14, email_pattern, email_marker)
}

# --- Redaction of every string inside a JSON value, keeping its structure ---

_is_container(x) if is_object(x)

_is_container(x) if is_array(x)

_escape_segment(seg) := replace(replace(sprintf("%v", [seg]), "~", "~0"), "/", "~1")

_pointer(path) := concat("", [concat("", ["/", _escape_segment(seg)]) | some seg in path])

_patches_for(doc) := [{"op": "replace", "path": _pointer(path), "value": r} |
    walk(doc, [path, v])
    is_string(v)
    r := _redact(v)
    r != v
]

# --- Scope ---

_is_egress if input.mode == "output"

_is_egress if input.action == "tool_post_invoke"

_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

_in_scope if {
    some n in _names
    startswith(n, "datadog")
}

# --- Response blocks ---

_json_container(b) := doc if {
    is_string(b)
    json.is_valid(b)
    doc := json.unmarshal(b)
    _is_container(doc)
}

# JSON text with secrets: rewrite the string values, re-serialize.
_redact_block(b) := json.marshal(json.patch(doc, ps)) if {
    doc := _json_container(b)
    ps := _patches_for(doc)
    count(ps) > 0
}

# JSON text without secrets: unchanged.
_redact_block(b) := b if {
    doc := _json_container(b)
    count(_patches_for(doc)) == 0
}

# Plain text.
_redact_block(b) := _redact(b) if {
    is_string(b)
    not _json_container(b)
}

# Structured (non-string) blocks.
_redact_block(b) := json.patch(b, _patches_for(b)) if _is_container(b)

_redact_block(b) := b if {
    not is_string(b)
    not _is_container(b)
}

_text := object.get(object.get(input, "payload", {}), "text", [])

_redacted := [out | some b in _text; out := _redact_block(b)]

transform := {
    "transformed_payload": object.union(object.get(input, "payload", {}), {"text": _redacted}),
} if {
    _is_egress
    _in_scope
    is_array(_text)
    _redacted != _text
}
```
