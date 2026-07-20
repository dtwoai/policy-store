---
name: "GitHub: Redact Secrets from Read Responses"
tags:
  - github
  - redact-secrets
  - secrets
  - dlp
  - redaction
  - egress
  - soc2
publishedAt: 2026-07-12
description: |
  # github / redact-secrets-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `github.egress.redact_secrets`

  ## What it does

  Scans the responses of GitHub's crown-jewel read tools and masks known
  credential shapes with a fixed `[REDACTED-SECRET]` marker before the text
  enters agent context. Source code, CI logs, and diffs routinely contain keys
  that were committed to a repo; this policy keeps those keys from being
  surfaced verbatim to the model on the main exfiltration channel into agent
  context.

  It is **transform-only** (`default allow := true`): it never blocks the read
  and never changes any field other than the returned text. A matched substring
  is replaced in place; everything around it — file paths, line context, diff
  hunks, log lines — is preserved so the response stays useful. Responses with
  no matches (and every out-of-scope tool) pass through byte-identical.

  The credential regex family is the **same set applied by the ingress secret
  block** (`apps/github/block-secrets-commits`): AWS access-key IDs and
  secret-access-keys, GitHub personal-access tokens (classic + fine-grained),
  Slack tokens, Stripe live secret keys, Google API keys, OpenAI API keys, PEM
  private-key headers, and generic `key: value` / `key=value` secrets. Ingress
  stops a caller from *committing* a secret; this egress policy stops the agent
  from *reading back* a secret that was already committed before the gateway was
  in place (or through a path the gateway does not front).

  | Class | Detection | Marker |
  |---|---|---|
  | Generic `key: value` secret | `password`/`token`/`api_key`/`secret_key`/`client_secret` etc. in `key: value` or `key=value` form (case-insensitive) | `[REDACTED-SECRET]` |
  | AWS access key ID | `AKIA` + 16 upper-alphanumeric | `[REDACTED-SECRET]` |
  | AWS secret access key | `aws`-anchored 40-char base64-ish run | `[REDACTED-SECRET]` |
  | GitHub PAT (classic) | `ghp_` + 36 | `[REDACTED-SECRET]` |
  | GitHub PAT (fine-grained) | `github_pat_` + 82 | `[REDACTED-SECRET]` |
  | Slack token | `xoxb-`/`xoxp-`/`xoxa-`/`xoxr-`/`xoxs-` | `[REDACTED-SECRET]` |
  | Stripe live secret key | `sk_live_` + 24+ | `[REDACTED-SECRET]` |
  | Google API key | `AIza` + 35 | `[REDACTED-SECRET]` |
  | OpenAI API key | `sk-` + 20+ | `[REDACTED-SECRET]` |
  | PEM private-key header | `-----BEGIN … PRIVATE KEY-----` | `[REDACTED-SECRET]` |

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking credentials in GitHub content as it
    leaves the gateway toward the agent (the read-surface counterpart to the
    ingress `block-secrets-commits` control).
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the read path: committed credentials are confidential and are
    masked before they reach agent context.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing: keeping
    authentication secrets (which can unlock systems holding personal data) out
    of agent context reduces the blast radius of a prompt-injection or a leaked
    transcript.

  This is a data-masking / security-of-processing control on the main
  exfiltration channel into agent context.

  ## Why egress

  The secret already lives in the repo, the CI log, or the diff — there is
  nothing to block at ingress, and denying the read outright would make source
  code unusable to the agent. The leak happens when file-derived text is
  returned to the MCP client, so the response path is the only place to catch it
  while keeping the content useful. (The ingress `block-secrets-commits` policy
  handles the write direction — stopping *new* secrets from being committed.)

  ## Tool name matching

  Applies on the output path — scoped when `input.mode == "output"`,
  `input.action == "tool_post_invoke"`, or the legacy `input.kind ==
  "tool_post_invoke"` holds, so redaction still fires on a gateway build that
  populates only one of the three (keying on `mode` alone — or on `action` alone
  where an older build emits only the legacy `kind` — would fail open if that
  field were unset). Tools are matched case-insensitively **by
  suffix**, so it works regardless of the MCP server-name prefix the gateway
  adds (`github-mcp-…`, `gh-prod-…`, etc.). The tool name is read from all three
  egress surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a suffix hit on **any** of them puts the call in
  scope, so a gateway that populates a different surface can't slip content past
  the scanner.

  Official server (`github/github-mcp-server`, names verified from the landscape
  research) crown-jewel read surfaces:

  - `get_file_contents` — file bodies across every repo the grant reaches.
  - `search_code` — returns matched code snippets.
  - `get_job_logs` — CI/Actions logs (a frequent home for echoed secrets).
  - `pull_request_read` — the consolidated PR reader whose `get_diff` / `get_files`
    methods return code.
  - `get_commit` — the single-commit reader returns the commit's file patches
    (added/removed lines), the same committed-secret content an agent would
    otherwise read through `get_file_contents`. Included so the file-read scan
    can't be sidestepped by fetching the commit instead. Shared verbatim by the
    community server.

  Archived community server (`@modelcontextprotocol/server-github`) equivalents,
  matched by their granular names: `get_file_contents` and `search_code` are
  shared verbatim; `get_pull_request_files` is the community counterpart to the
  official `pull_request_read(get_files)` surface.

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and add suffixes for any other
  content-returning read tools your deployment exposes.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each string block. Non-string
  blocks (structured/JSON content) pass through unmodified. When at least one
  block changes, the policy emits `transform.transformed_payload` containing the
  original payload with the rewritten `text` array (all other payload keys
  preserved). When nothing matches, the `transform` rule is undefined and the
  aggregator returns the response unchanged.

  ## Examples

  ### Redacted (file read containing a committed AWS key)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "github-mcp-get_file_contents", "type": "tool" },
      "payload": {
        "name": "github-mcp-get_file_contents",
        "text": ["const key = 'AKIAIOSFODNN7EXAMPLE';"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["const key = '[REDACTED-SECRET]';"]`.

  ### Passed through (no secret in the response)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "github-mcp-search_code", "type": "tool" },
      "payload": {
        "name": "github-mcp-search_code",
        "text": ["function add(a, b) { return a + b; }"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the response is returned byte-identical.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny policies on the same egress pipeline and with the ingress secret
  block. Recommended companions in `apps/github`:

  - **block-secrets-commits** (ingress) — the write-direction counterpart:
    stops the agent from committing new secrets in the first place.
  - **fence-scopes-org-allowlist** (ingress) — keeps agents out of third-party
    and personal repos, shrinking the surface this policy has to scan.
  - A deny policy on `list_secret_scanning_alerts` / `get_secret_scanning_alert`
    (ingress) — those tools return the *locations* of live leaked credentials
    and are best gated to a `security` group, not merely masked.

  ## Known limitations

  - **Regex over returned text — high-signal masking, not complete DLP.** Only
    values matching a known shape are caught. Base64-embedded secrets,
    custom-format or rotating short-lived tokens, secrets split across lines, and
    keys stored in structured JSON *keys* (the generic pattern matches plain-text
    `token: value`, not a `"token":"value"` JSON field) all pass through. Treat
    this as a strong first line of defense on the read path, not a guarantee that
    no credential reaches the model.
  - **`pull_request_read` method is not visible on egress.** The spec targets the
    `get_diff` / `get_files` methods, but the method is an ingress argument — on
    the response path only the tool name is available. This policy therefore
    scans **all** `pull_request_read` responses (a harmless superset: masking a
    secret echoed in a status or review-comment method is fine).
  - **Over-redaction is possible.** The AWS secret-access-key and generic
    `key=value` patterns are broad; a 40-char base64 string near the word `aws`,
    or any `token:`-prefixed value, will be masked even if it is not a live
    secret. Because the response is preserved except for the matched substring,
    the cost is a `[REDACTED-SECRET]` marker in otherwise-usable output. Tune
    `secret_patterns` for your environment.
  - **Byte-level replacement.** `transformed_payload` is computed in Rego by
    chained `regex.replace`, so the masked text is well-formed, but the transform
    replaces the response payload wholesale — verify the rewrite against your
    gateway version with the dump-input technique and mind attachment order if
    other egress transforms run on the same pipeline.
  - **No identity exemption.** All callers get the same masking; this policy has
    no group carve-out by design (redacting a secret is never harmful). If you
    need a break-glass reader, add a separate `allow`/exemption branch keyed on
    `input.subject.claims.groups`.
  - **Other content-returning reads remain out of scope by design.** The scope is
    the crown-jewel code/log/diff surfaces (`get_file_contents`, `search_code`,
    `get_job_logs`, `pull_request_read`, `get_commit`, community
    `get_pull_request_files`). A secret echoed in a *commit message* or *metadata*
    read — `list_commits`, `search_commits`, `get_repository_tree` — or in issue /
    PR-comment / discussion / gist bodies (`issue_read`, `get_gist`,
    `get_discussion_comments`, …) is **not** scanned and passes through verbatim.
    These are lower-signal secret channels than raw file/diff content, but if your
    repos routinely carry credentials in commit messages or issue bodies, add the
    relevant suffixes to `read_tool_suffixes`. The cost of adding one is only
    possible over-redaction, never a denied read.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - github
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package github.egress.redact_secrets

# Transform-only egress policy: masks known credential shapes in the responses
# of GitHub's crown-jewel read tools with a fixed [REDACTED-SECRET] marker before
# the text enters agent context. Never denies; only rewrites matched substrings.
default allow := true

redaction_marker := "[REDACTED-SECRET]"

# -----------------------------------------------------------------------------
# Credential patterns — the SAME family the ingress secret block
# (apps/github/block-secrets-commits) uses, applied here on the read path.
# Anchored to common shapes (key=value pairs and provider-specific prefixes) to
# limit false positives.
# -----------------------------------------------------------------------------
secret_patterns := [
    # Generic password / token / api_key / secret_key in `key: value` or `key=value` form
    `(?i)(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+`,
    # AWS access key IDs
    `AKIA[0-9A-Z]{16}`,
    # AWS secret access keys (40-char base64-ish, anchored near the word "aws")
    `(?i)aws(.{0,20})?(secret|access)?.{0,20}[\s:=]+[A-Za-z0-9/+=]{40}`,
    # GitHub classic personal access tokens
    `ghp_[A-Za-z0-9]{36}`,
    # GitHub fine-grained personal access tokens
    `github_pat_[A-Za-z0-9_]{82}`,
    # Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
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

# -----------------------------------------------------------------------------
# Scope: GitHub crown-jewel read tools whose responses carry code / logs / diffs.
# Suffix matching keeps the policy portable across gateway server-name prefixes
# and covers both the official consolidated names and the archived community
# server's granular names. Verified against the GitHub landscape research.
# -----------------------------------------------------------------------------
read_tool_suffixes := {
    # Official server (github/github-mcp-server)
    "get_file_contents",       # file bodies (also shared verbatim by the community server)
    "search_code",             # matched code snippets (also shared by the community server)
    "get_job_logs",            # CI/Actions logs
    "pull_request_read",       # consolidated PR reader (get_diff / get_files methods return code)
    "get_commit",              # commit view returns file patches/diffs — the same committed-secret exfil channel as get_file_contents (shared by the community server)
    # Archived community server granular PR-files counterpart
    "get_pull_request_files",
}

# Egress scope: match the post-invoke/output path on mode, the PARC action, OR
# the legacy `kind` alias. If we keyed on input.mode alone and a gateway build
# left it unset, is_read_tool would silently fail and redaction would no-op (fail
# open, leaking content). action and kind carry the same value on current builds,
# but older gateways populate only the legacy `kind`; matching all three closes
# the fail-open surface either alias being unset would open. Ingress
# (tool_pre_invoke / mode "input") satisfies none of the branches, so it stays out.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

is_egress if { input.kind == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a read-tool suffix — matching only a subset would let a gateway that
# populates a different surface slip file content past the scanner.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

is_read_tool if {
    is_egress
    some suffix in read_tool_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Redaction — apply every secret pattern in turn. regex.replace is total over
# strings (returns the input unchanged when the pattern does not match), so the
# chain is safe and order-independent for these disjoint shapes. Rego forbids
# recursion, so the fold is written out as an explicit chain.
# -----------------------------------------------------------------------------
redact_all(t) := out if {
    r0 := regex.replace(t, secret_patterns[0], redaction_marker)
    r1 := regex.replace(r0, secret_patterns[1], redaction_marker)
    r2 := regex.replace(r1, secret_patterns[2], redaction_marker)
    r3 := regex.replace(r2, secret_patterns[3], redaction_marker)
    r4 := regex.replace(r3, secret_patterns[4], redaction_marker)
    r5 := regex.replace(r4, secret_patterns[5], redaction_marker)
    r6 := regex.replace(r5, secret_patterns[6], redaction_marker)
    r7 := regex.replace(r6, secret_patterns[7], redaction_marker)
    r8 := regex.replace(r7, secret_patterns[8], redaction_marker)
    out := regex.replace(r8, secret_patterns[9], redaction_marker)
}

# String blocks are scanned; non-string (structured/JSON) blocks pass through.
redact_block(b) := redact_all(b) if { is_string(b) }

redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope and at least one block actually changed.
# Otherwise the rule is undefined and the aggregator skips this policy, returning
# the response byte-identical.
# -----------------------------------------------------------------------------
text_blocks := object.get(object.get(input, "payload", {}), "text", [])

redacted_blocks := [out |
    some block in text_blocks
    out := redact_block(block)
]

transform := {
    "transformed_payload": object.union(object.get(input, "payload", {}), {"text": redacted_blocks}),
} if {
    is_read_tool
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
