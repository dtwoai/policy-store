---
name: "JIRA: Redact Secrets from Ticket Reads"
tags:
  - jira
  - atlassian
  - secrets
  - redaction
  - egress
publishedAt: 2026-10-11
description: |
  # jira / redact-secrets-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only, never denies)
  **Package:** `jira.egress.redact_secrets`

  ## What it does

  Old tickets are full of pasted credentials: a `.env` dump in a bug report, a connection
  string in a comment, a token in a stack trace. This policy masks them in Jira responses
  before the agent sees them, so they don't end up in the model's context, a chat
  transcript, or the next thing the agent writes.

  It applies to every Jira tool on the server (issue views, JQL search, comments, worklogs,
  remote links) and to the hosted server's generic `fetch` and `search` tools. JSON responses
  keep their structure: only string values are rewritten. If nothing matches, the response is
  returned byte for byte.

  ## What gets masked

  Each match is replaced with `[REDACTED-SECRET]`: `password=` / `token:` / `api_key=` style
  pairs, AWS access keys and secret keys, GitHub and GitLab tokens, Slack tokens, Stripe live
  keys, Google API keys, OpenAI-style keys, JWTs, `Bearer` tokens, PEM private keys, and the
  password part of connection strings (`postgres://app:[REDACTED-SECRET]@db`). Email
  addresses and names are left alone, so assignees, reporters, and mentions still work.

  **Quoted values and credential fields.** `key="value"` and `key: 'value'` pairs are masked
  the same as unquoted ones, including JSON-style `"password": "..."` inside a log line or
  comment. In JSON responses, a string under a credential-named field (`password`,
  `apiKey`, `client_secret`, `accessToken`, `db.password`, …) is masked whatever its value
  looks like. Pagination cursors such as `nextPageToken` are left alone.

  ## Compliance alignment

  - **SOC 2 CC6.7** — restricts movement of credentials into a new system (the agent's
    context).

  ## Why egress

  The secrets are already in Jira; the only place to stop them is on the way back to the
  agent. Jira itself is untouched.

  ## Examples

  ### Masked

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "atlassian-getJiraIssue", "type": "tool" },
      "payload": { "text": [ "{\"key\":\"PLAT-412\",\"fields\":{\"description\":\"DB is postgres://app:hunter2@db:5432\"}}" ] }
    }
  }
  ```

  The description comes back as `"DB is postgres://app:[REDACTED-SECRET]@db:5432"`.

  ## Composition

  Pair with [`jira/redact-secrets-writes`](../redact-secrets-writes/policy.md). For personal
  data (emails, phone numbers, SSNs) as well as credentials, use
  [`jira/redact-sensitive-info`](../redact-sensitive-info/policy.md) instead.

  ## Known limitations

  - **Known shapes only.** Secrets that don't match a listed shape pass through.
  - **Re-serialized JSON.** When a JSON response is changed, it's returned minified with keys
    sorted. The content is the same.
  - **Confluence content via fetch/search.** Rovo's generic `fetch` and `search` also return
    Confluence pages; secrets there are masked too.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - jira
industries: []
bundles:
  - engineering-stack-jira
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.egress.redact_secrets

# Transform-only egress policy — never denies. Masks credentials in responses
# before they enter agent context. JSON responses keep their structure: only
# string values are rewritten.
default allow := true

secret_marker := "[REDACTED-SECRET]"

# Credential shapes, applied in order. JWT and Bearer come before the generic
# key=value pair so a token is masked whole. The generic pair takes a quoted
# value ("..." or '...', on one line) or an unquoted one that stops at quotes,
# commas, and semicolons so it never eats into neighbouring text. The key may be
# quoted and carry a prefix (`"db_password": "x"`, `client.secret='x'`).
secret_patterns := [
    # JSON Web Tokens
    `eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
    # Bearer tokens
    `(?i)bearer\s+[A-Za-z0-9._~+/-]{16,}=*`,
    # Generic password / token / api_key / secret in `key: value` or `key=value` form,
    # quoted or not
    `(?i)["']?[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"'<>,;]+)`,
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
    out := regex.replace(r13, conn_string_pattern, concat("", ["${1}", secret_marker, "@"]))
}

# --- Redaction of every string inside a JSON value, keeping its structure ---

_is_container(x) if is_object(x)

_is_container(x) if is_array(x)

_escape_segment(seg) := replace(replace(sprintf("%v", [seg]), "~", "~0"), "/", "~1")

_pointer(path) := concat("", [concat("", ["/", _escape_segment(seg)]) | some seg in path])

# Field names that hold credentials. Compared lowercased with `_`, `-` and `.`
# removed, so apiKey, api_key, client-secret, db.password and accessToken all
# match. Pagination and sync cursors (nextPageToken, cursor_token) are not
# credentials and are left alone.
_credential_field_suffixes := {
    "password", "passwd", "passphrase", "secret", "token", "apikey",
    "accesskey", "secretkey", "privatekey", "credential", "credentials",
}

_cursor_words := {"page", "cursor", "next", "sync", "continuation"}

_credential_field(k) if {
    is_string(k)
    n := replace(replace(replace(lower(k), "_", ""), "-", ""), ".", "")
    some s in _credential_field_suffixes
    endswith(n, s)
    not _is_cursor_field(n)
}

_is_cursor_field(n) if {
    some w in _cursor_words
    contains(n, w)
}

# A non-empty string under a credential-named field is masked whole, whatever
# its value looks like. Any other string goes through the shape patterns.
_redact_at(path, v) := secret_marker if {
    count(path) > 0
    _credential_field(path[count(path) - 1])
    v != ""
} else := _redact(v)

_patches_for(doc) := [{"op": "replace", "path": _pointer(path), "value": r} |
    walk(doc, [path, v])
    is_string(v)
    r := _redact_at(path, v)
    r != v
]

# --- Scope ---

_is_egress if input.mode == "output"

_is_egress if input.action == "tool_post_invoke"

_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

# Jira tools on the hosted Atlassian server (and community servers) carry "jira"
# in the name. Rovo's generic fetch and search tools return Jira (and Confluence)
# content too.
_in_scope if {
    some n in _names
    contains(n, "jira")
}

_in_scope if {
    some n in _names
    startswith(n, "atlassian")
    some s in {"fetch", "search"}
    endswith(n, s)
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
