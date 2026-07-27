---
name: Block Secrets in Confluence Pages and Comments
tags:
  - confluence
  - secrets
  - dlp
  - ingress
  - soc2
  - atlassian
publishedAt: 2026-07-12
description: |
  # confluence / block-secrets

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `confluence.ingress.block_secrets`

  ## What it does

  Blocks Confluence write calls whose body looks like it contains a live
  credential — an API key, password, token, or PEM-formatted private key —
  before the content is ever published. All other tool calls pass through
  unchanged.

  The check runs at ingress, before the call reaches the Atlassian MCP server.
  It inspects:

  - the `body` argument of **create-page** / **update-page** tools, and
  - the `commentBody` argument of the **footer-comment** / **inline-comment**
    tools.

  A created or updated Confluence page is visible org-wide the moment it is
  written (`status: "current"`), and blog posts broadcast to the whole
  organization. There is no draft buffer between the tool call and org-wide
  visibility, so **ingress denial is the only way to prevent the leak** — an
  egress redaction policy could mask the response returned to the agent, but it
  cannot un-publish a page that already exists in Confluence, its search index,
  watchers' notifications, and email digests.

  All callers are subject to the same check; there is no identity exemption.

  ## Compliance alignment

  - **SOC 2 CC6.6** — supports boundary protection against external threats by
    keeping live credentials out of a third-party workspace an attacker could
    read; **CC6.7** — supports the restriction on transmission/movement of
    confidential information by stopping credentials from moving into Confluence
    over the agent write path.
  - **PCI DSS 8.6.2** — supports the prohibition on hard-coded / embedded
    credentials by blocking passwords, keys, and tokens from being written into
    Confluence pages and comments.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing:
    authentication secrets that could be used to reach systems holding personal
    data never land in a Confluence page or comment history.

  ## Why ingress and not egress

  Creating or updating a Confluence page is a write with immediate, org-wide
  side effects. Once the call reaches Confluence the page exists at
  `status: "current"`, is indexed for search, and fires watcher/space
  notifications and email digests; a blog post broadcasts to the whole
  organization. Pages are versioned (an admin can restore a prior version), but
  the secret has already been distributed by the time anyone notices. Egress
  redaction would only mask what the agent reads back, not the published
  artifact. Ingress denial is the only control that actually prevents the leak.

  ## Patterns matched

  The policy reuses the conservative, provider-prefixed regex set from the Slack
  `block-secrets` model. Adding too many patterns sharply increases false
  positives, so the list is intentionally focused on high-confidence shapes:

  - `password:`, `token:`, `api_key:`, `client_secret:`, etc. in `key: value` or
    `key=value` form (case-insensitive)
  - AWS access key IDs (`AKIA…`) and likely secret access keys
  - GitHub personal access tokens (`ghp_…`, `github_pat_…`)
  - Slack bot/user/admin tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`)
  - Stripe live secret keys (`sk_live_…`)
  - Google API keys (`AIza…`)
  - OpenAI API keys (`sk-…`)
  - PEM private key headers (`-----BEGIN … PRIVATE KEY-----`)

  Tune this list for your environment. If your team uses other providers
  (Twilio, SendGrid, Datadog, etc.), add their token shapes to `secret_patterns`
  in `policy.md`.

  ## Tool name matching

  The Atlassian Rovo (official) MCP server names its Confluence write tools in
  camelCase — `createConfluencePage`, `updateConfluencePage`,
  `createConfluenceFooterComment`, `createConfluenceInlineComment`. The Claude
  connector surfaces them lowercased with an `atlassian-` prefix
  (`atlassian-createconfluencepage`). The community `sooperset/mcp-atlassian`
  server uses snake_case product-prefixed names — `confluence_create_page`,
  `confluence_update_page`, `confluence_update_page_section`, and (for comments)
  `confluence_add_comment` / `confluence_reply_to_comment`.

  Because the DTwo gateway prefixes tool names with the configured MCP server
  name (which is not standardized), the policy matches on the **suffix**,
  case-insensitively, across both naming schemes:

  - `*createconfluencepage`, `*updateconfluencepage`
  - `*createconfluencefootercomment`, `*createconfluenceinlinecomment`
  - `*confluence_create_page`, `*confluence_update_page`,
    `*confluence_update_page_section`
  - `*confluence_add_comment`, `*confluence_reply_to_comment`

  Verify the exact tool name your gateway sends with the
  [dump-input debug technique](https://docs.dtwo.ai) before relying on this in
  production, and add any additional write-tool suffix to
  `write_tool_suffixes` in `policy.md`.

  ## Argument shape

  - **Pages** (`createConfluencePage` / `updateConfluencePage` and their
    community equivalents) carry the content under `body`. The official
    connector accepts `body` as an html/markdown/ADF value — it may be a plain
    string or a structured ADF/JSON object (e.g.
    `{ "representation": "storage", "value": "…" }`). The policy scans the
    string form directly and, for structured bodies, JSON-serializes the object
    so an embedded credential still matches.
  - **Comments** (`createConfluenceFooterComment` /
    `createConfluenceInlineComment`) carry the content under `commentBody`.
  - Community comment tools are inspected under `body` and `comment` as well.
    Their exact per-field schemas are **not independently verified** (see the
    Atlassian landscape note) — if your gateway exposes the comment body under a
    different key, add it to the `body_arg_keys` set in `policy.md`.

  If the tool is a write tool but no inspectable body/comment argument is present
  (an empty or metadata-only write), the call is allowed — there is nothing to
  leak.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createconfluencepage", "type": "tool" },
      "payload": {
        "name": "atlassian-createconfluencepage",
        "args": {
          "spaceId": "1234",
          "title": "Sprint retro notes",
          "body": "We shipped the ingress policies and closed 12 issues."
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (page body)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createconfluencepage", "type": "tool" },
      "payload": {
        "name": "atlassian-createconfluencepage",
        "args": {
          "spaceId": "1234",
          "title": "Deploy runbook",
          "body": "Export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE before running."
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Confluence write looks like it contains a secret ..."`.

  ### Denied (comment)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createconfluencefootercomment", "type": "tool" },
      "payload": {
        "name": "atlassian-createconfluencefootercomment",
        "args": {
          "pageId": "5678",
          "commentBody": "here's the token: ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        }
      }
    }
  }
  ```

  `allow = false`, deny reason returned.

  ## Composition

  This policy is single-purpose. Useful companions:

  - `apps/confluence/deny-public-publication` (PF-27 `deny-public-exposure`) —
    deny blog posts and writes into public/anonymous-access spaces, so content
    that is not a secret but is still sensitive does not broadcast org-wide.
  - An egress PII redaction policy on Confluence read tools
    (`getConfluencePage`, `searchConfluenceUsingCql`) so credentials that were
    published through the web UI or native API — outside the gateway's reach —
    are masked when an agent reads them back.

  See the [`bundles/atlassian`](../../../bundles/atlassian/README.md) bundle for
  the curated set.

  ## Known limitations

  - **Regex over text.** Secrets that do not match a known shape (rotating
    short-lived tokens, custom-format keys) will not be caught. Treat this as a
    high-signal first line of defense, not a complete DLP solution.
  - **Only `body` / `commentBody` are inspected.** A page `title`, macro
    parameters, or attachments are not scanned. A caller determined to smuggle a
    credential could place it in the title. Extend the `body_arg_keys` set or add
    a `title` rule if that is a concern in your environment.
  - **Not every community write tool carries an inspectable body.** The
    community server also exposes `confluence_add_label` (its content lives under
    a short `name` keyword field, not a body), `confluence_upload_attachment`
    (binary file content), and `confluence_move_page` (page relocation — carries
    no content body, only a target parent/position). These are **not** inspected
    — a determined caller could stage a credential as a label value or inside an
    uploaded file. Because the gate keys off the tool-name **suffix first**, even
    a text metadata field one of these tools carries (e.g. an attachment version
    `comment`, which is otherwise a scanned key in `body_arg_keys`) is left
    unscanned — the tool is never recognized as an inspected write, so no body
    extraction runs at all. Attachment scanning belongs in an upstream DLP
    scanner; if labels or attachment metadata are a concern, add the tool suffix
    (e.g. `confluence_add_label` / `confluence_upload_attachment`) to
    `write_tool_suffixes` and the relevant key (`name`) to `body_arg_keys`
    (accepting that many legitimate labels/comments are then scanned).
  - **Structured-body coverage is best-effort — provider-shaped tokens only.**
    Structured ADF bodies are JSON-serialized before scanning. Provider-shaped
    tokens (AWS `AKIA…`, `ghp_…`, `sk_live_…`, PEM headers, etc.) are reliably
    caught when they appear as a string leaf value anywhere in the object or
    array, because the regex matches the token substring regardless of the
    surrounding JSON. A **generic `key: value` credential expressed as a JSON
    field**, however, is **not** caught: a body of `{ "password": "hunter2" }`
    marshals to `{"password":"hunter2"}`, and the generic
    `password:`/`token:`-style regex expects the keyword immediately followed by
    `:`/`=` and the value — the interposed JSON punctuation (`"password":"…"`)
    defeats it, and the bare value `hunter2` has no provider shape to match on
    its own. The same holds for base64/hex-encoded or character-split payloads.
    Treat structured-body scanning as reliable for provider-prefixed secrets
    only; catch generic field-name credentials with an upstream DLP scanner.
  - **Community comment schemas unverified.** The `confluence_add_comment` /
    `confluence_reply_to_comment` body argument names are inferred from the
    community server's docs, not verified against a live schema. Confirm the key
    on your gateway before relying on comment coverage there.
  - **No identity-based exemptions.** All callers are subject to the same check.
    If you need an InfoSec break-glass user that can post anything, gate it with
    `input.subject.claims` as a separate `allow if` branch.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - confluence
industries: []
bundles:
  - atlassian
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package confluence.ingress.block_secrets

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Patterns that look like secrets in plain text. Anchored to common shapes
# (key=value pairs and provider-specific prefixes) to limit false positives.
# Reused verbatim from the slack/block-secrets model.
secret_patterns := [
    # Generic password / token / api_key / secret_key in `key: value` or `key=value` form
    `(?i)(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+`,
    # AWS access key IDs
    `AKIA[0-9A-Z]{16}`,
    # AWS secret access keys (40-char base64-ish)
    `(?i)aws(.{0,20})?(secret|access)?.{0,20}[\s:=]+[A-Za-z0-9/+=]{40}`,
    # GitHub fine-grained / classic personal access tokens
    `ghp_[A-Za-z0-9]{36}`,
    `github_pat_[A-Za-z0-9_]{82}`,
    # Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-)
    `xox[baprs]-[A-Za-z0-9-]{10,}`,
    # Stripe live secret keys
    `sk_live_[A-Za-z0-9]{24,}`,
    # Google API keys
    `AIza[0-9A-Za-z\-_]{35}`,
    # OpenAI API keys
    `sk-[A-Za-z0-9]{20,}`,
    # Generic private key headers
    `-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`,
]

# Confluence write tools whose content we inspect. The gateway prefixes tool
# names with the configured MCP server name, so we match on the suffix
# (case-insensitive) to stay portable across the official (camelCase, surfaced
# lowercased) and community (snake_case) naming schemes.
write_tool_suffixes := {
    "createconfluencepage",
    "updateconfluencepage",
    "createconfluencefootercomment",
    "createconfluenceinlinecomment",
    "confluence_create_page",
    "confluence_update_page",
    "confluence_update_page_section",
    "confluence_add_comment",
    "confluence_reply_to_comment",
}

# Argument keys that may carry inspectable body/comment text across the official
# and community servers.
body_arg_keys := {"body", "commentbody", "comment"}

args := object.get(input.payload, "args", {})

is_confluence_write_tool if {
    name := lower(input.resource.name)
    some suffix in write_tool_suffixes
    endswith(name, suffix)
}

# All argument keys, lowercased, so matching is case-insensitive against the
# body/comment key set regardless of the exact casing the MCP server uses.
scanned_text contains text if {
    some key, value in args
    body_arg_keys[lower(key)]
    is_string(value)
    value != ""
    text := value
}

# Structured (ADF/JSON object or array) body — serialize so a credential
# embedded as a string leaf value still matches the regexes.
scanned_text contains text if {
    some key, value in args
    body_arg_keys[lower(key)]
    not is_string(value)
    value != null
    text := json.marshal(value)
}

# Detect a secret pattern in any inspected body/comment string.
body_contains_secret if {
    some text in scanned_text
    some pattern in secret_patterns
    regex.match(pattern, text)
}

# Allow any tool that isn't a Confluence write we inspect.
allow if {
    not is_confluence_write_tool
}

# Allow Confluence writes only when no secret pattern matches the body/comment.
allow if {
    is_confluence_write_tool
    not body_contains_secret
}

reasons contains "This Confluence write looks like it contains a secret (API key, password, token, or private key). A created or updated page or comment is visible org-wide immediately and cannot be un-published, so it is blocked before it reaches Confluence. Store credentials in your secret manager and reference them instead. Contact your InfoSec team if this was a false positive." if {
    is_confluence_write_tool
    body_contains_secret
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
