---
name: "JIRA: Redact Secrets from Ticket Writes"
tags:
  - jira
  - atlassian
  - secrets
  - redaction
  - ingress
publishedAt: 2026-10-11
description: |
  # jira / redact-secrets-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only, never denies)
  **Package:** `jira.ingress.redact_secrets_writes`

  ## What it does

  Engineers paste logs, stack traces, and config snippets into tickets all the time, and an
  agent filing a bug from an incident does the same. This policy masks credentials in
  everything the agent writes to Jira before it's saved, so a token never lands in a ticket
  that half the company can read. The ticket is still created; only the secret is replaced.

  It covers creating and editing issues, adding or editing comments, worklogs, and the fields
  and comments sent with a transition. Every string in the request is scanned, including the
  `description`, `summary`, `additional_fields`, and the text inside Atlassian Document Format
  (ADF) bodies. IDs and keys pass through unchanged.

  ## What gets masked

  Each match is replaced with `[REDACTED-SECRET]`: `password=` / `token:` / `api_key=` style
  pairs, AWS access keys and secret keys, GitHub and GitLab tokens, Slack tokens, Stripe live
  keys, Google API keys, OpenAI-style keys, JWTs, `Bearer` tokens, PEM private keys, and the
  password part of connection strings (`postgres://app:[REDACTED-SECRET]@db`). Email
  addresses and names are left alone, so assignees, reporters, and mentions still work.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.7** — keeps credentials from being copied into a widely shared system.

  ## Why redact instead of block

  A blocked ticket write stops the agent mid-task and usually gets retried by hand, secret
  included. Masking the secret lets the ticket through and removes the one thing that
  shouldn't be in it.

  ## Tool name matching

  Tools are matched by suffix, so the policy works whatever name your gateway gives the
  Atlassian server. Hosted server (Rovo): `createJiraIssue`, `editJiraIssue`,
  `addCommentToJiraIssue`, `addWorklogToJiraIssue`, `transitionJiraIssue`. Community
  `mcp-atlassian`: `jira_create_issue`, `jira_update_issue`, `jira_add_comment`,
  `jira_add_worklog`, `jira_transition_issue`.

  ## Examples

  ### Masked

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createJiraIssue", "type": "tool" },
      "payload": { "args": { "cloudId": "acme", "projectKey": "PLAT", "issueTypeName": "Bug",
        "summary": "Checkout 500s", "description": "Repro with token=abc123def456 against prod" } }
    }
  }
  ```

  `transform.transformed_payload.description` = `"Repro with [REDACTED-SECRET] against prod"`.

  ## Composition

  Pair with [`jira/redact-secrets-egress`](../redact-secrets-egress/policy.md), which masks
  secrets already sitting in tickets when the agent reads them.

  ## Known limitations

  - **Known shapes only.** Secrets that don't match a listed shape pass through.
  - **Confluence writes are not covered.** Use [`confluence/block-secrets`](../../confluence/block-secrets/policy.md)
    for pages and comments.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
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
package jira.ingress.redact_secrets_writes

# Transform-only policy — never denies. Masks credentials in the text an agent
# is about to write, keeping the rest of the arguments as they are.
default allow := true

secret_marker := "[REDACTED-SECRET]"

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
    out := regex.replace(r13, conn_string_pattern, concat("", ["${1}", secret_marker, "@"]))
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

_tool := lower(object.get(input.resource, "name", ""))

# Hosted Atlassian MCP server (Rovo) names, plus the community mcp-atlassian names.
_write_suffixes := {
    "createjiraissue", "editjiraissue", "addcommenttojiraissue",
    "addworklogtojiraissue", "transitionjiraissue",
    "jira_create_issue", "jira_update_issue", "jira_add_comment",
    "jira_add_worklog", "jira_transition_issue",
}

_is_write_tool if {
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
