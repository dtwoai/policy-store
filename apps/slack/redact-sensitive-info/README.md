# slack / redact-sensitive-info

**Direction:** ingress (`tool_pre_invoke`) · **Package:** `slack.ingress.redact_sensitive_info`

Redacts secrets and PII from outgoing Slack message arguments before the call reaches Slack. Transform-only — it never denies, it only rewrites matching content to `[REDACTED]`.

## What it does

The policy is `default allow := true` and applies to any tool whose first hyphen-separated name segment starts with `slack`. It inspects four argument fields and rewrites only those that contain a match:

- `text` and `message` — string bodies, redacted in place.
- `blocks` (Block Kit) and `attachments` (legacy) — serialized to JSON, byte-replaced, then reparsed; if the result would be invalid JSON, that field is left untouched (fail-safe).

Clean fields, absent fields, and all other arguments (`channel`, `thread_ts`, etc.) pass through unchanged.

## What gets redacted

PII (SSN, credit card, email, US phone); vendor-prefixed cloud/SaaS keys (AWS, Google, GitHub, GitLab, Slack, Stripe); OAuth bearer tokens and JWTs; generic `api_key`/`password`/`secret`/`token` assignments; database connection strings (URI/JDBC/ADO); and PEM private-key blocks. The pattern set is shared with the JIRA `redact-sensitive-info` egress policy.

## When to use it

Use this when you want secret/PII leaks into Slack to be silently scrubbed rather than blocked, so legitimate messages still go through with the sensitive substring removed. If you would rather reject the whole message, use [`block-secrets`](../block-secrets/policy.md) instead.

## Assumptions

- Matching is regex over text — expect general-purpose false positives and false negatives. Tune `sensitive_pattern` for your environment.
- Only `text`, `message`, `blocks`, and `attachments` are inspected. Add a patch rule if your Slack MCP server carries body content under another argument. Confirm exact tool/argument names with the dump-input debug technique.

## Tests

See [`tests/`](./tests/):

- [`redact.json`](./tests/redact.json) — a message body containing a secret is rewritten.
- [`passthrough.json`](./tests/passthrough.json) — a clean message passes through unchanged.

## Composition

Part of the [`slack`](../../../bundles/slack/README.md) bundle. Transform-only and `default allow := true`, so it composes cleanly with deny policies on the same ingress pipeline such as [`deny-direct-messages`](../deny-direct-messages/policy.md). Note it overlaps with [`block-secrets`](../block-secrets/policy.md) (block vs. redact) — pick one posture or order them deliberately.
