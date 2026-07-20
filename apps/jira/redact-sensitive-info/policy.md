---
name: "JIRA: Redact Sensitive Information from Issue Views"
tags:
  - jira
  - atlassian
  - pii
  - secrets
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
  - iso27001-nist
publishedAt: 2026-06-15
description: |
  # jira / redact-sensitive-info

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `jira.egress.redact_sensitive_info`

  ## What it does

  Redacts sensitive content from the responses of JIRA issue-view tools before
  they reach the caller. The goal is durable: prevent PII, credentials, and
  secrets from leaking out through JIRA issue bodies, comments, worklogs, and
  linked-issue content.

  It is a transform-only egress policy — it never denies a call, it only rewrites
  matching content in the response to `[REDACTED]`. Any tool that is not a JIRA
  issue-view tool passes through untouched.

  ## Compliance alignment

  This policy instantiates egress PII/secrets redaction (family PF-02, with a
  card-number masking slice of family PF-01) and supports alignment with:

  - **SOC 2 CC6.7, P6.1** — restricts the transmission/movement of confidential
    and personal information out of Jira issue content, and reduces
    personal-information disclosure in agent-visible responses.
  - **HIPAA §164.514(d), §164.514(a)–(b)** — minimum-necessary support: masks
    identifiers (SSN, email, phone) on the egress path; partial support for
    de-identification of identifier classes in issue text.
  - **PCI DSS 3.4.1** — masks card-number-shaped values in displayed responses
    (pattern-based, not Luhn-validated — see Known limitations).
  - **GDPR Art. 5(1)(c), Art. 9; CPRA §1798.121, §1798.150** — data
    minimisation, sensitive-personal-information limitation, and reduced
    nonredacted-PI breach exposure on the agent channel.
  - **ISO 27001 A.8.11, A.8.12** — data masking and data-leakage prevention on
    tool responses.

  ## Why egress and not ingress

  The risk here is *reading* secrets that already live inside JIRA issues
  (pasted into a description, a comment, or a worklog). Those values exist
  regardless of this gateway, so there is nothing to block at ingress — the
  leak happens when the content is returned to an MCP client. Masking on the
  egress (response) path is the only place to catch it.

  ## Scope / tool matching

  The policy applies only to JIRA tools that surface issue-body content, matched
  by tool-name **suffix** so it stays portable regardless of the MCP server name
  prefix the gateway adds (`atlassian-`, `atlassian-jira-mcp-`, etc.):

  - `*-getjiraissue`
  - `*-searchjiraissuesusingjql`
  - `*-getcommentsforjiraissue`
  - `*-getjiraissuecomments`
  - `*-getworklogsforjiraissue`
  - `*-getjiraissueworklog`
  - `*-getjiraissueremoteissuelinks`

  The tool name is read from both `input.resource.name` and
  `input.tool_metadata.name`, so the policy matches regardless of which surface
  the gateway populates first. Confirm the exact tool names your gateway sends
  using the dump-input debug technique before relying on this in production; if
  your JIRA MCP server exposes other issue-view tools, add their suffixes to
  `view_tool_suffixes`.

  ## What gets redacted

  Redaction works two ways. **By pattern** in any string value:

  - PII — US SSN, credit card numbers, email addresses, US phone numbers
  - Cloud / SaaS keys (vendor-prefixed shapes) — AWS access keys (`AKIA…`,
    `ASIA…`), Google API keys (`AIza…`) and OAuth tokens (`ya29.…`), GitHub
    tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), GitLab PATs (`glpat-…`),
    Slack tokens (`xox[abprs]-…`), Stripe keys (`sk_live_`, `sk_test_`,
    `pk_live_`, `pk_test_`)
  - OAuth / bearer — `Authorization: Bearer …` headers and JWTs
  - Generic `key: value` / `key=value` secret assignments (api_key, password,
    secret, token, client_secret, credentials, …)
  - Database connection strings with embedded credentials (postgres, mysql,
    mongodb, redis, amqp, mssql/sqlserver URIs; JDBC strings; ADO.NET-style
    `Server=…;User Id=…;Password=…`)
  - PEM private-key blocks (`-----BEGIN … PRIVATE KEY----- … -----END …-----`)

  And **by field name** — any response field whose key is one of `password`,
  `passwd`, `pwd`, `secret`, `api_key`, `apikey`, `token`, `access_token`,
  `refresh_token`, `id_token`, `client_secret`, `private_key`,
  `connection_string`, or `credentials`.

  Matches are replaced with `[REDACTED]`.

  ## Examples

  ### Redacted (JIRA issue view)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "resource": { "name": "atlassian-jira-mcp-getjiraissue", "type": "tool" },
      "tool_metadata": { "name": "atlassian-jira-mcp-getjiraissue" }
    }
  }
  ```

  `allow = true`, with a `transform` that supplies the redaction patterns,
  field names, and `replacement = "[REDACTED]"` for the gateway to apply to the
  response body.

  ### Passed through (any non-issue-view tool)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "resource": { "name": "atlassian-jira-mcp-getjiraproject", "type": "tool" },
      "tool_metadata": { "name": "atlassian-jira-mcp-getjiraproject" }
    }
  }
  ```

  `allow = true`, no `transform` — the response is returned unchanged.

  ## Composition

  This policy is single-purpose and transform-only, so it composes cleanly with
  access-control policies on the same egress pipeline. Useful companions:

  - An ingress policy that blocks *writing* secrets into JIRA in the first place
    (so new issues don't accumulate credentials).
  - Equivalent egress redaction policies for other Atlassian apps (Confluence,
    Bitbucket). See the [`bundles/atlassian`](../../../bundles/atlassian/README.md)
    bundle for the curated Atlassian set.

  ## Known limitations

  - **Regex over plain text.** Detection is pattern-based, so novel or
    non-standard token formats, short-lived rotating tokens, and custom-shaped
    secrets may not be caught. Treat this as a high-signal layer, not a complete
    DLP solution.
  - **Scope is issue-view tools only.** Other JIRA tools that might surface
    issue content (e.g. bulk export or attachment-download endpoints) are not
    inspected unless you add their suffixes to `view_tool_suffixes`.
  - **No identity-based exemptions.** All callers get the same redaction. Add an
    `input.subject.claims`-gated branch if a break-glass role needs raw values.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - jira
industries: []
bundles:
  - atlassian
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.egress.redact_sensitive_info

# Transform-only policy — never denies, only redacts sensitive content.
# Scoped to JIRA tools that return issue-body content. Other tools (including
# non-JIRA egress) pass through this policy untouched.
default allow := true

# -----------------------------------------------------------------------------
# Scope: JIRA tools that surface issue content (summary, description, comments,
# worklog, custom fields, linked issues). Suffix matching makes this work
# regardless of the MCP server name (atlassian-, atlassian-jira-mcp-, etc.).
# -----------------------------------------------------------------------------
view_tool_suffixes := {
    "-getjiraissue",
    "-searchjiraissuesusingjql",
    "-getcommentsforjiraissue",
    "-getjiraissuecomments",
    "-getworklogsforjiraissue",
    "-getjiraissueworklog",
    "-getjiraissueremoteissuelinks",
}

is_jira_issue_view if {
    some suffix in view_tool_suffixes
    name := lower(input.resource.name)
    endswith(name, suffix)
}

is_jira_issue_view if {
    # Egress hooks also expose the tool name under tool_metadata.name — check
    # both so we match regardless of which surface the gateway populates first.
    some suffix in view_tool_suffixes
    name := lower(object.get(input.tool_metadata, "name", ""))
    endswith(name, suffix)
}

# -----------------------------------------------------------------------------
# Redaction transform
# -----------------------------------------------------------------------------
transform := {
    "redact_patterns": [
        # ---- PII ----
        `\d{3}-\d{2}-\d{4}`,                                                          # US SSN
        `\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}`,                                        # Credit card
        `[\w.-]+@[\w.-]+\.[\w.-]+`,                                                   # Email
        `\+?1?[- .]?\(?\d{3}\)?[- .]?\d{3}[- .]?\d{4}`,                               # US phone

        # ---- Cloud / SaaS API keys (vendor-prefixed shapes) ----
        `AKIA[0-9A-Z]{16}`,                                                           # AWS access key ID
        `ASIA[0-9A-Z]{16}`,                                                           # AWS temporary (STS) access key
        `AIza[0-9A-Za-z_-]{35}`,                                                      # Google API key
        `ya29\.[0-9A-Za-z_-]+`,                                                       # Google OAuth access token
        `ghp_[A-Za-z0-9]{36}`,                                                        # GitHub personal access token
        `gho_[A-Za-z0-9]{36}`,                                                        # GitHub OAuth token
        `ghu_[A-Za-z0-9]{36}`,                                                        # GitHub user-to-server token
        `ghs_[A-Za-z0-9]{36}`,                                                        # GitHub server-to-server token
        `ghr_[A-Za-z0-9]{36}`,                                                        # GitHub refresh token
        `glpat-[A-Za-z0-9_-]{20}`,                                                    # GitLab personal access token
        `xox[abprs]-[A-Za-z0-9-]+`,                                                   # Slack tokens (bot/app/user/refresh/etc.)
        `sk_live_[A-Za-z0-9]{24,}`,                                                   # Stripe live secret key
        `sk_test_[A-Za-z0-9]{24,}`,                                                   # Stripe test secret key
        `pk_live_[A-Za-z0-9]{24,}`,                                                   # Stripe live publishable key
        `pk_test_[A-Za-z0-9]{24,}`,                                                   # Stripe test publishable key

        # ---- OAuth / bearer ----
        `(?i)bearer\s+[A-Za-z0-9._~+/-]+=*`,                                          # Authorization: Bearer <token>
        `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`,                       # JWT (header.payload.signature, base64url)

        # ---- Generic key/value secret patterns ----
        `(?i)(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*\S+`,                     # api_key=..., api-key: ...
        `(?i)(?:password|passwd|pwd|secret|token|credentials|client[_-]?secret)\s*[:=]\s*\S+`,

        # ---- Database connection strings ----
        # URI form with embedded user:password (postgres, mysql, mongo, redis, amqp, mssql)
        `(?i)(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?|mssql|sqlserver)://[^:\s]+:[^@\s]+@[^/\s]+(?:/\S*)?`,
        `(?i)jdbc:[a-z0-9]+:[^\s]+`,                                                  # JDBC strings
        `(?i)(?:Server|Data Source)\s*=\s*[^;]+;\s*(?:User Id|UID)\s*=\s*[^;]+;\s*(?:Password|PWD)\s*=\s*[^;]+`,

        # ---- PEM private keys (multi-line, lazy match between BEGIN/END markers) ----
        `-----BEGIN [A-Z ]+PRIVATE KEY-----.+?-----END [A-Z ]+PRIVATE KEY-----`,
    ],
    "redact_fields": [
        "password",
        "passwd",
        "pwd",
        "secret",
        "api_key",
        "apikey",
        "token",
        "access_token",
        "refresh_token",
        "id_token",
        "client_secret",
        "private_key",
        "connection_string",
        "credentials",
    ],
    "replacement": "[REDACTED]",
} if {
    is_jira_issue_view
}
```
