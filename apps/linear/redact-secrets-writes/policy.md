---
name: "Linear: Redact Secrets from Ticket Writes"
tags:
  - linear
  - secrets
  - redaction
  - ingress
publishedAt: 2026-10-11
description: |
  # linear / redact-secrets-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only, never denies)
  **Package:** `linear.ingress.redact_secrets_writes`

  ## What it does

  Engineers paste logs, stack traces, and config snippets into issues all the time, and an
  agent filing a bug from an incident does the same. This policy masks credentials in
  everything the agent writes to Linear before it's saved, so a token never lands in an issue
  the whole workspace can read. The issue is still created; only the secret is replaced.

  It covers Linear's hosted MCP server write tools: `save_issue` (which replaced
  `create_issue` and `update_issue`), `save_project`, and `save_comment`, plus the older
  `create_*` / `update_*` names for servers that still expose them. Every string in the
  request is scanned (title, description, comment body, project summary); IDs pass through
  unchanged.

  ## What gets masked

  Each match is replaced with `[REDACTED-SECRET]`: `password=` / `token:` / `api_key=` style
  pairs, AWS access keys and secret keys, GitHub and GitLab tokens, Slack tokens, Stripe live
  keys, Google API keys, OpenAI-style keys, JWTs, `Bearer` tokens, PEM private keys, and the
  password part of connection strings (`postgres://app:[REDACTED-SECRET]@db`). Email
  addresses and names are left alone, so assignees, reporters, and mentions still work.

  **Quoted values and credential fields.** `key="value"` and `key: 'value'` pairs are masked
  the same as unquoted ones, including JSON-style `"password": "..."` inside a log line or
  comment. In JSON arguments the agent sends, a string under a credential-named field (`password`,
  `apiKey`, `client_secret`, `accessToken`, `db.password`, …) is masked whatever its value
  looks like. Pagination cursors such as `nextPageToken` are left alone.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.7** — keeps credentials from being copied into a widely shared system.

  ## Why redact instead of block

  A blocked issue write stops the agent mid-task and usually gets retried by hand, secret
  included. Masking the secret lets the issue through and removes the one thing that
  shouldn't be in it.

  ## Tool name matching

  Scope is tools on a server whose gateway name starts with `linear`, with one of the write
  suffixes above (`_` or `-` separators). The prefix check matters: GitHub's server also has a
  `create_issue` tool. Change the prefix if your Linear server is registered under another
  name.

  ## Examples

  ### Masked

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear-save_issue", "type": "tool" },
      "payload": { "args": { "team": "Platform", "title": "Checkout 500s",
        "description": "Failing call used Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0" } }
    }
  }
  ```

  `transform.transformed_payload.description` = `"Failing call used Authorization: [REDACTED-SECRET]"`.

  ## Composition

  Pair with [`linear/redact-secrets-egress`](../redact-secrets-egress/policy.md), which masks
  secrets already sitting in issues when the agent reads them.

  ## Known limitations

  - **Known shapes only.** Secrets that don't match a listed shape pass through.
  - **Community servers.** `tacticlaunch/mcp-linear` names (`linear_createIssue`, …) are not
    matched.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - linear
industries: []
bundles:
  - engineering-stack-linear
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package linear.ingress.redact_secrets_writes

# Transform-only policy — never denies. Masks credentials in the text an agent
# is about to write, keeping the rest of the arguments as they are.
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

# Normalize separators so create_issue and create-issue match alike.
_tool := replace(lower(object.get(input.resource, "name", "")), "-", "_")

# Official hosted Linear MCP server (mcp.linear.app) write tools. Linear merged
# create/update into save_* tools; the older names are kept for servers that
# still expose them.
_write_suffixes := {
    "save_issue", "save_project", "save_comment",
    "create_issue", "update_issue", "create_comment", "create_project", "update_project",
}

# Scope to the Linear server: GitHub has a create_issue tool too.
_is_write_tool if {
    startswith(_tool, "linear")
    some s in _write_suffixes
    endswith(_tool, s)
}

_args := object.get(object.get(input, "payload", {}), "args", {})

_patches := _patches_for(_args) if is_object(_args)

transform := {"transformed_payload": json.patch(_args, _patches)} if {
    input.action == "tool_pre_invoke"
    _is_write_tool
    count(_patches) > 0
}
```
