---
name: Cap Google Drive Search & Listing Page Sizes
tags:
  - google-drive
  - cap-bulk-export
  - data-minimization
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # google-drive / cap-bulk-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `google_drive.ingress.cap_bulk_export`

  ## What it does

  Clamps the page size of Google Drive search and listing calls to a
  documented cap (25 results per call). When an agent asks a Drive
  enumeration tool for more than 25 results in one page, the policy rewrites
  the page-size argument down to 25 before the call reaches the MCP server.
  Requests with no page-size argument, or with a page size at or under the
  cap, pass through untouched (the server's own defaults apply). The call is
  never denied.

  Why this matters: search is the recon step of a Drive exfiltration.
  Drive's full query syntax (`fullText contains`, `'folderId' in parents`)
  lets an agent enumerate sensitive material fast, and repeated large pages
  are the amplifier that turns `read_file_content` /
  `download_file_content` sweeps into bulk exfiltration. Capping page size
  slows mass enumeration and forces breadth to show up as many calls in the
  audit log instead of a few large ones.

  No identity gating: the cap applies to every caller, for
  minimum-necessary/data-minimisation alignment — no subject needs 100-row
  recon pages by default.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information by bounding how much Drive content inventory an agent can
    pull per call over the MCP path.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard: an agent working in a Drive that holds PHI gets result pages
    sized for the task at hand, not bulk sweeps.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent
    channel; **CCPA 11 CCR §7002** — supports proportionality of collection
    relative to purpose.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `gdrive-mcp-gdrive_search`), so the policy matches
  case-insensitively by suffix:

  - `*gdrive_search` — isaacphi/mcp-gdrive (its `pageSize` argument is
    verified from source)
  - `*search_files`, `*list_recent_files` — Google official Drive MCP
    server (parameter names **unverified** — see Known limitations)
  - `*-search`, `*listfolder` — piotr-agier/google-drive-mcp `search` /
    `listFolder` (tool names verified; page-size parameter name unverified)
  - `*google_drive_search` — legacy claude.ai built-in Drive integration
    (tool name **unverified** — reported from published system prompts,
    effectively dead but may still appear in older Claude traffic)

  The `-search` suffix assumes the gateway's `<server-name>-<tool-name>`
  prefixing. Verify the exact names your gateway sends with the dump-input
  debug technique before relying on this in production.

  ## Argument shape

  The policy checks a candidate set of page-size-style argument keys on
  matched tools — `pageSize`, `page_size`, `pagesize`, `limit`,
  `maxResults`, `max_results` — each read with `object.get`, so missing
  keys are simply skipped. Values may be numbers or numeric strings
  (`"100"`, including ones with surrounding whitespace like `" 100"`, which
  are trimmed before parsing); both are clamped to the numeric cap `25`.
  Non-numeric values and requests without any candidate key pass through
  unchanged. Key matching is **case-sensitive** (`object.get` exact match) —
  see Known limitations.

  ## Examples

  ### Transformed (page size over the cap)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gdrive-mcp-gdrive_search", "type": "tool" },
      "payload": {
        "name": "gdrive-mcp-gdrive_search",
        "args": { "query": "fullText contains 'salary'", "pageSize": 100 }
      }
    }
  }
  ```

  `allow = true`, transform rewrites args to
  `{ "query": "fullText contains 'salary'", "pageSize": 25 }`.

  ### Untouched (no page-size argument)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gdrive-mcp-gdrive_search", "type": "tool" },
      "payload": {
        "name": "gdrive-mcp-gdrive_search",
        "args": { "query": "name contains 'roadmap'" }
      }
    }
  }
  ```

  `allow = true`, no transform — the server's default page size applies.

  ## Composition

  This policy is single-purpose. Useful companions:

  - [`redact-pii-egress`](../redact-pii-egress/policy.md) — sanitizes
    whatever content the capped pages still return.
  - [`guard-acl-recon`](../guard-acl-recon/policy.md) — closes the parallel
    recon channel through `get_file_permissions`.

  ## Known limitations

  - **Cannot bound call count.** The cap limits results *per call*, not
    calls per minute — an agent can still paginate through everything with
    `pageToken`, just slower and more visibly. Rate limiting is a platform
    property, not a policy job. Treat this as friction plus audit
    amplification, not a hard exfiltration stop.
  - **Unverified parameter names.** Only isaacphi's `gdrive_search`
    `pageSize` is verified from source. The Google official server does not
    publish per-tool parameter schemas, and piotr-agier's page-size
    parameter name is undocumented — verify via `tools/list` through your
    gateway before relying on the clamp there. A server whose page-size
    parameter is named outside the candidate set is not clamped.
  - **Case-sensitive argument keys.** Tool *names* are matched
    case-insensitively, but the candidate page-size *keys* are matched
    exactly (`object.get`). A server that accepts a case-variant key —
    `PageSize`, `LIMIT`, `MaxResults` — would not be clamped. All known
    Drive servers use the documented casing (`pageSize`, `maxResults`,
    `limit`, `page_size`), so this is a residual only for a
    case-insensitive server; add the variant to `page_size_keys` if yours
    is.
  - **Server coercion outstrips the parser.** The clamp fires only when
    OPA's `to_number` can read the value (after whitespace trimming). A
    value OPA cannot parse but a lenient server still coerces to a large
    integer — e.g. an exotic numeric literal, a locale-formatted string
    (`"1,000"`), or a nested/typed wrapper — is skipped and passes
    uncapped. This is the residual behind the "friction, not a hard stop"
    framing: the clamp is only as tight as the parser.
  - **Non-positive page sizes pass through.** The clamp fires only on
    values *strictly greater than* the cap, so `0`, `-1`, or any
    non-positive number is left untouched (`numeric(v) > page_size_cap` is
    false). The known Drive servers reject non-positive page sizes (Google's
    API range is 1–1000), but a lenient or non-standard server that reads
    `0`/`-1` as "unbounded / return everything" would not be clamped. This is
    another facet of the "friction, not a hard stop" posture; if your server
    treats non-positive as unbounded, pair this policy with a server-side
    request-validation rule.
  - **Type rewrite on numeric strings.** A numeric-string page size
    (`"100"`) is replaced with the number `25`. Servers that strictly
    require a string type for that parameter may reject the rewritten call.
  - **Generic-verb collision.** The `-search` suffix can match search tools
    of *other* MCP servers if this policy is attached to a mixed pipeline.
    The effect is only a page-size clamp (never a deny), but scope the
    attachment to Drive pipelines if that matters.
  - **Cap is a tuning point.** `25` is a conservative default; adjust
    `page_size_cap` in `policy.md` to your environment's needs.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - google-drive
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_drive.ingress.cap_bulk_export

# Transform-only policy — never denies, only clamps oversized page sizes.
default allow := true

# Maximum results per page on Drive search/listing calls. Tune per environment.
page_size_cap := 25

# Candidate argument keys that carry a page-size value across known Drive MCP
# servers. `pageSize` is verified for isaacphi/mcp-gdrive's gdrive_search; the
# rest are defensive candidates for the Google official and piotr-agier
# servers, whose parameter names are unverified (confirm via tools/list).
page_size_keys := ["pageSize", "page_size", "pagesize", "limit", "maxResults", "max_results"]

# --- Tool matching --------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name
# (e.g. `gdrive-mcp-gdrive_search`), so match case-insensitively by suffix.

# isaacphi/mcp-gdrive search (pageSize argument verified from source)
is_enumeration_tool if {
    endswith(lower(input.resource.name), "gdrive_search")
}

# Legacy claude.ai built-in Drive integration `google_drive_search`
# (reported from published system prompts — tool name UNVERIFIED, effectively
# dead but may still appear in older Claude traffic). Full suffix, so it does
# not collide with isaacphi's `gdrive_search`.
is_enumeration_tool if {
    endswith(lower(input.resource.name), "google_drive_search")
}

# Google official Drive MCP server (parameter names unverified)
is_enumeration_tool if {
    endswith(lower(input.resource.name), "search_files")
}

is_enumeration_tool if {
    endswith(lower(input.resource.name), "list_recent_files")
}

# piotr-agier/google-drive-mcp `search` — generic verb, so anchor on the
# gateway's `-` server-name separator to avoid matching `gdrive_search` or
# `search_files` twice or unrelated `*_search` tools by substring.
is_enumeration_tool if {
    endswith(lower(input.resource.name), "-search")
}

# piotr-agier/google-drive-mcp `listFolder`
is_enumeration_tool if {
    endswith(lower(input.resource.name), "listfolder")
}

# --- Page-size clamping ----------------------------------------------------

# Tool arguments, defaulting to {} so missing payloads mean "nothing to clamp".
call_args := object.get(object.get(input, "payload", {}), "args", {})

# Interpret a page-size value: numbers pass through, numeric strings are
# parsed (leading/trailing whitespace trimmed first, since a lenient server
# would coerce `" 100"` to 100 and we must clamp what it would honor);
# anything else is undefined and the key is skipped.
numeric(v) := v if is_number(v)

numeric(v) := to_number(trim_space(v)) if is_string(v)

# Every candidate key present on the call whose value exceeds the cap,
# mapped to the cap. Empty when nothing needs clamping.
capped_overrides := {k: page_size_cap |
    some k in page_size_keys
    v := object.get(call_args, k, null)
    numeric(v) > page_size_cap
}

# Rewrite the oversized page-size argument(s) down to the cap; all other
# arguments are preserved as-is.
transform := {"transformed_payload": object.union(call_args, capped_overrides)} if {
    input.action == "tool_pre_invoke"
    is_enumeration_tool
    count(capped_overrides) > 0
}
```
