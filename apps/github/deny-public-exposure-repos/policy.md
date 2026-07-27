---
name: Prevent Public Exposure of GitHub Repos, Gists & Forks
tags:
  - github
  - deny-public-exposure
  - anti-exfil
  - ingress
  - soc2
  - finserv-comms
  - eu-ai-act
publishedAt: 2026-07-12
description: |
  # github / deny-public-exposure-repos

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise (with a force-private transform on repo creation)
  **Package:** `github.ingress.deny_public_exposure_repos`

  ## What it does

  Stops the agent from exposing private code to the public across three GitHub
  write tools, at ingress — before the call reaches the GitHub MCP server, so a
  blocked publish never happens and a rewritten repo is created private:

  - **`create_gist` — deny when it would be public.** A gist whose `public`
    flag is set (`public: true`, or a `"public"` visibility value) is denied.
    Only an explicitly private/secret gist (`public: false`, `"false"`,
    `"private"`, or `"secret"`) is allowed; a gist with **no** `public` flag is
    allowed (GitHub defaults gists to secret). The check **fails closed on
    ambiguous visibility**: an unrecognised `public` value (e.g. `"yes"`, `1`,
    `null`, an object) is treated as public and denied.
  - **`fork_repository` — deny personal-namespace forks.** A fork with no
    `organization` argument lands in the caller's personal namespace, escaping
    org controls and copying private code out of the sanctioned boundary. The
    policy denies `fork_repository` unless `organization` is present and a
    non-empty string. An absent, empty, or non-string `organization` fails
    closed and is denied.
  - **`create_repository` — force `private: true`.** Regardless of the
    requested `private` value, the policy rewrites the call so the repository is
    created private — whether the agent set `private: false`, `private: true`,
    or omitted the field. This is a transform applied on ingress, not a denial:
    the repo is still created, just never public.

  All three tools are matched by suffix; **every other call passes through
  unchanged**. This is a security-hardening, anti-exfiltration control that
  complements the org-scope fence (`fence-scopes-org-allowlist`) and the
  secret-hygiene policies.

  ## Compliance alignment

  Per the Phase-3 coverage matrix, the `deny-public-exposure` family (PF-27)
  maps to the following controls on the MCP path. This policy is a
  boundary / anti-exfiltration deny control, so it belongs to the `soc2`
  bundle; its FINRA and EU AI Act alignments are cited below as well, though
  those frameworks have no curated bundle in the current set.

  - **SOC 2 CC6.6** — supports boundary protection against external exposure by
    stopping the agent from publishing private code to a public GitHub surface
    (a public gist, a public repository, or a personal-namespace fork);
    **CC6.7** — supports the restriction on the movement/removal of
    confidential information by forcing new repositories private and denying
    public gists and personal forks, so source code cannot leave the sanctioned
    org boundary over the agent channel.
  - **FINRA Rule 2210(b)(1)** (principal pre-approval of retail communications)
    — supports keeping an agent from *publishing to the public* without human
    sign-off: a public gist or public repository authored by the agent is an
    unreviewed public communication, and this policy forces it private or blocks
    it so a human retains the publish decision.
  - **EU AI Act Art. 50(4)** (disclosure for AI-generated content made public)
    — supports the human-review marker on published output by preventing the
    agent from pushing content to a public GitHub surface (public repo/gist/
    personal-namespace fork) on its own.

  ## Why ingress and not egress

  Publishing a public gist, creating a public repository, and forking private
  code into a personal namespace are writes with permanent, externally visible
  side effects — once the call reaches GitHub the content is public and may
  already be cloned, cached, or indexed. Egress redaction could only mask the
  response returned to the agent, not un-publish the code. Ingress denial (and
  the ingress force-private transform) is the only way to actually prevent the
  exposure.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `github-mcp-create_gist`), and that prefix is not standardized. The policy
  therefore matches on the **suffix**, case-insensitively, on both the PARC
  `resource.name` and the legacy `payload.name` alias (so a call missing one of
  the two cannot slip past):

  - `*create_gist` — official server's gist-creation tool.
  - `*fork_repository` — same name on both the official
    (`github/github-mcp-server`) and archived
    (`@modelcontextprotocol/server-github`) servers, so one suffix covers both.
  - `*create_repository` — same name on both servers.

  All three names are verified in the GitHub landscape note. Verify the exact
  names your gateway sends with the dump-input debug technique before relying on
  this in production.

  ## Argument shape

  Read from `input.payload.args`:

  - `create_gist.public` — the gist visibility flag. Handled as boolean
    (`true`/`false`) or string (`"public"`/`"private"`/`"secret"`/`"false"`),
    compared after `trim_space` + `lower`. Any present value that is not a
    recognised private value is treated as public (fail closed).
  - `fork_repository.organization` — the destination org login. Must be a
    present, non-empty string for the fork to be allowed.
  - `create_repository.private` — the requested visibility. Ignored for the
    decision; the transform sets `private: true` and preserves every other
    argument (`name`, `description`, `organization`, `autoInit`) via
    `object.union`.

  The `create_gist` and `create_repository` argument schemas were **not
  verified from source** in the landscape pass (only `create_repository`'s field
  list is documented, and `fork_repository`'s `organization` is documented) — so
  confirm the live `tools/list` before pinning field names. If your server names
  the gist visibility field `visibility` rather than `public`, extend the
  accessor (see Known limitations).

  ## Examples

  ### Allowed — secret gist

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-create_gist", "type": "tool" },
      "payload": {
        "name": "github-mcp-create_gist",
        "args": { "description": "scratch", "public": false, "files": {} }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — public gist

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-create_gist", "type": "tool" },
      "payload": {
        "name": "github-mcp-create_gist",
        "args": { "description": "leak", "public": true, "files": {} }
      }
    }
  }
  ```

  `allow = false`, reason tells the agent to create a secret gist instead.

  ### Denied — personal-namespace fork

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-fork_repository", "type": "tool" },
      "payload": {
        "name": "github-mcp-fork_repository",
        "args": { "owner": "acme-inc", "repo": "billing" }
      }
    }
  }
  ```

  `allow = false`, reason asks for an `organization` inside a sanctioned org.

  ### Transformed — repo forced private

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-create_repository", "type": "tool" },
      "payload": {
        "name": "github-mcp-create_repository",
        "args": { "name": "new-service", "private": false, "autoInit": true }
      }
    }
  }
  ```

  `allow = true`; transform rewrites `private` to `true` and preserves `name`
  and `autoInit` — the repository is created private.

  ## Composition

  This policy is single-purpose (three related public-exposure surfaces).
  Recommended companions (see the GitHub landscape note's candidate list):

  - **`fence-scopes-org-allowlist`** (PF-23) — fences the `owner` argument to the
    company org, closing the `push_files` / `create_or_update_file` write-exfil
    path this policy does not touch.
  - **`role-gate-writes`** (PF-12) — restrict all write tools to an
    `engineering` IdP group so non-engineers get read-only GitHub.
  - An egress **secret-hygiene / IP-redaction** policy on `get_file_contents`,
    `search_code`, and `pull_request_read` responses.

  ## Known limitations

  - **Only the `create_gist`, `fork_repository`, and `create_repository`
    surfaces are covered.** Other public-exposure paths — pushing to a public
    repo the OAuth grant can reach, transferring a repo, or toggling an existing
    repo public via a settings tool — are out of scope. Pair with the org-scope
    fence and role-gate policies.
  - **Gist visibility field name is assumed.** The policy inspects the `public`
    argument. `create_gist`'s exact MCP schema was **not verified from source**
    in the landscape pass; if your server exposes visibility under a different
    key (e.g. `visibility`), a public gist could slip through. Confirm with the
    live `tools/list` and extend the `gist_public_value` accessor.
  - **`create_repository` transform is top-level only.** It pins the top-level
    `private` field. If a server nests the repo definition under another key,
    the nested visibility is not rewritten. The documented official/archived
    servers take `private` at the top level.
  - **Malformed non-object `args` on `create_repository` pass through
    un-rewritten.** `object.union` is undefined on a non-object, so no transform
    fires; such a call carries no valid repository definition and fails at the
    GitHub server (documented residual, covered in tests). It cannot create a
    public repo.
  - **Suffix matching misses a trailing segment after the tool name.** A tool
    named e.g. `...create_gist-v2` would not match `create_gist` and would pass
    through. The gateway only *prepends* the configured server name, so this
    does not affect the real servers; confirm exact names with dump-input and
    extend the suffix set if your server differs.
  - **Fork destination org is presence-checked, not allowlisted.**
    `fork_repository` is allowed whenever `organization` is any non-empty
    string. The policy cannot distinguish a sanctioned company org from an
    attacker-created free org, so a fork into an arbitrary org the caller
    controls is permitted (covered in tests). The deny reason says "a sanctioned
    company org" as user guidance, but sanctioning is **not** enforced here. To
    fence the destination to specific orgs, pair with an org-allowlist policy
    (PF-23 `fence-scopes-org-allowlist`) or add an allowlist-membership check to
    `fork_has_org` (`allowed_orgs[lower(trim_space(org))]` against a per-tenant
    set constant).
  - **No identity-based exemption.** Every caller is subject to the same
    controls. If you need a break-glass identity that may create public repos or
    gists, add an `allow if` branch keyed on `input.subject.claims.groups` with
    a documented placeholder group name (replace it with your IdP's group name
    at import time).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - github
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package github.ingress.deny_public_exposure_repos

# Deny-by-default: a call is permitted only by an explicit allow rule below.
# `create_repository` is always allowed (never denied) and force-rewritten to
# private by the transform; the gist and fork surfaces deny on public exposure.
default allow := false

# --- Shared accessors --------------------------------------------------------

# Tool name from the PARC resource.name and the legacy payload.name alias, each
# lower-cased. Both are read (matched separately below) so a call that arrives
# with one of the two absent cannot slip past the suffix match.
resource_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

payload_name := lower(object.get(object.get(input, "payload", {}), "name", ""))

# Tool arguments; {} when absent so downstream object.get never errors.
args := object.get(object.get(input, "payload", {}), "args", {})

# --- Tool matching (suffix, case-insensitive, portable across server prefixes) ---

is_create_gist if endswith(resource_name, "create_gist")

is_create_gist if endswith(payload_name, "create_gist")

is_fork if endswith(resource_name, "fork_repository")

is_fork if endswith(payload_name, "fork_repository")

is_create_repo if endswith(resource_name, "create_repository")

is_create_repo if endswith(payload_name, "create_repository")

# --- create_gist: deny public / ambiguous visibility -------------------------

# Recognised private/secret visibility strings. Anything else present is treated
# as public (fail closed).
recognized_private_strings := {"false", "private", "secret"}

# The gist's `public` argument value; undefined when the key is absent (or when
# args is not an object). Separated from the presence check because the value
# may legitimately be the boolean `false`.
gist_public_value := args.public

# The `public` key is present (even if its value is `false` or `null`).
gist_public_present if {
    _ = args.public
}

# The gist is explicitly marked private/secret -> safe, allowed.
gist_marked_private if {
    gist_public_value == false
}

gist_marked_private if {
    is_string(gist_public_value)
    recognized_private_strings[lower(trim_space(gist_public_value))]
}

# Public exposure: a create_gist whose `public` flag is present but is NOT a
# recognised private value. Covers public:true, "public", and any unrecognised
# value (fail closed). A create_gist with no `public` flag is not an exposure.
gist_public_exposure if {
    is_create_gist
    gist_public_present
    not gist_marked_private
}

# --- fork_repository: deny personal-namespace forks --------------------------

# The fork targets an organization when `organization` is a present, non-empty
# string. Absent, empty, or non-string organization fails closed (denied).
fork_has_org if {
    org := object.get(args, "organization", "")
    is_string(org)
    trim_space(org) != ""
}

fork_personal_namespace if {
    is_fork
    not fork_has_org
}

# --- Allow rules -------------------------------------------------------------

# A call is permitted unless it is a public-gist exposure or a personal-namespace
# fork. Expressed as the negation of the two deny conditions (not one allow
# branch per governed tool) so a call whose resource.name and payload.name carry
# DIFFERENT governed suffixes cannot use a never-denied create_repository arm to
# override a gist/fork denial. Non-governed tools and create_repository trip
# neither condition and pass through; create_repository is force-rewritten to
# private by the transform below.
allow if {
    not gist_public_exposure
    not fork_personal_namespace
}

# --- Transform: force create_repository private ------------------------------

# Regardless of the requested `private` value, pin private:true and preserve
# every other argument. Guarded on is_object so a malformed non-object args
# passes through unmodified (documented residual — it fails at the server).
transform := {"transformed_payload": object.union(args, {"private": true})} if {
    is_create_repo
    is_object(args)
}

# --- Deny reasons ------------------------------------------------------------

reasons contains "Creating a public gist is blocked to prevent private code from being exposed publicly. Create a secret gist instead (set public: false), or share the snippet through a repository inside your company org. Contact your InfoSec team if this gist genuinely needs to be public." if {
    gist_public_exposure
}

reasons contains "Forking into a personal namespace is blocked because it copies repository content outside your organization's controls. Re-run the fork with an organization set to a sanctioned company org so the fork stays inside the org boundary. Contact your InfoSec team if you need a personal fork for a legitimate reason." if {
    fork_personal_namespace
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
