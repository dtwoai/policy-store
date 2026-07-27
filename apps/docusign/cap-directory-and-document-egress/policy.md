---
name: Cap Docusign Directory and Document Egress
tags:
  - docusign
  - cap-bulk-export
  - pii
  - data-minimisation
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # docusign / cap-directory-and-document-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** deny (allow rules pass everything except ungated document downloads)
  **Package:** `docusign.egress.cap_directory_and_document_egress`

  ## What it does

  Bounds the two largest data-out channels in the Docusign MCP landscape:

  - **Directory truncation** — responses from `*getUsers*` (the official
    server's account-wide user listing: every user's name, email, and account
    details) are truncated to the first **25** users unless the caller's
    `input.subject.claims.groups` include `admin`. A `notice` field is added to
    the truncated JSON so the agent knows the listing is bounded by policy.
    Unbounded directory enumeration is a reconnaissance surface — one call
    hands an agent (or a prompt-injected agent) the full employee email roster.
  - **Document-download gate** — responses from the community server's
    `*download_envelope_document*` tool, which returns entire signed PDFs as
    base64 (`contentBase64`), are **denied** unless the caller's groups include
    `contracts-read`. Per the app landscape research, base64 PDF export is the
    single largest exfiltration channel in the community Docusign server, so it
    is gated to least privilege rather than truncated.

  All other tool responses pass through unchanged. Both group checks fail
  closed: a caller with missing or empty claims gets the truncated directory
  and no document downloads.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by bounding how much directory data and signed-document
    content any single agent call can move out of Docusign.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard with role-based limits: envelopes in healthcare flows routinely
    carry PHI, and signed-PDF retrieval is restricted to the role that needs
    it; directory reads return a bounded page rather than the full roster.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel: names and
    emails of every account user are personal data, and the response is
    minimised before it reaches the agent context. **CCPA 11 CCR §7002** —
    supports proportionality: retrieval stays proportionate to the task
    instead of defaulting to bulk enumeration.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `docusign-getUsers`), and that prefix is not standardised, so the
  policy matches case-insensitively by suffix on all three egress name surfaces
  (`input.resource.name`, `input.tool_metadata.name`, and `input.payload.name` —
  all three carry the same value on `tool_post_invoke`, so checking all three
  keeps the download deny from failing open if a gateway leaves one empty):

  - `*getusers` — the official Docusign MCP server's `getUsers` (verified from
    the developer-docs tool catalog). The suffix match does **not** catch the
    single-user tools `getUser` / `getUserInfo`, by design.
  - `*download_envelope_document` — the community
    `luthersystems/mcp-server-docusign` tool (verified from source). The
    official production server has **no** document-download tool, so this
    branch only fires on community-server deployments.

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Response shape assumptions

  - `*getUsers*` output is expected to be a JSON content block whose top-level
    object carries a `users` array (the documented eSignature `Users:list`
    body the tool maps to). Only blocks that parse as JSON and hold a `users`
    array longer than 25 entries are rewritten; everything else passes through
    unchanged (see Known limitations).
  - The download gate is a deny, so it makes no assumption about the response
    body — the whole response is blocked regardless of shape.

  ## Examples

  ### Allowed — admin reads the full directory

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "docusign-getUsers", "type": "tool" },
      "subject": { "claims": { "groups": ["admin"] } },
      "payload": { "name": "docusign-getUsers", "text": ["{\"users\":[/* 200 users */]}"] }
    }
  }
  ```

  `allow = true`, no transform — the full listing is returned.

  ### Transformed — non-admin directory read is truncated

  Same call with `"groups": ["everyone"]` → `allow = true` and
  `transform.transformed_payload.text` holds the same JSON with `users` cut to
  its first 25 entries plus a `notice` field explaining the truncation.

  ### Denied — document download without the contracts group

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "docusign-mcp-download_envelope_document", "type": "tool" },
      "subject": { "claims": { "groups": ["everyone"] } },
      "payload": { "name": "docusign-mcp-download_envelope_document", "text": ["{\"contentBase64\":\"JVBERi0x...\"}"] }
    }
  }
  ```

  `allow = false`, `reason = "Downloading signed envelope documents through the agent is restricted to members of the contracts-read group. ..."`.

  ## Composition

  This policy is single-purpose (PF-08, egress). Useful companions if present
  in your catalog:

  - An **ingress PF-08 clamp** on Docusign list/search arguments (page-size
    caps, `start_position` limits) — this egress policy bounds each response,
    not cumulative enumeration across paged calls.
  - A **PF-02 egress redaction** policy for SSN/bank patterns in
    `listRecipients` / `getEnvelope` tab values and `getAgreementDetails`
    provisions.
  - A **PF-25 force-draft** ingress policy (`status:"sent"` → `"created"`) on
    envelope creation.

  ## Known limitations

  - **Group names are placeholders — replace `admin` and `contracts-read` with
    your IdP's group names at import time.** The checks expect the `groups`
    claim as an array of strings (a single bare string is also handled). Never
    rely on stripped ContextForge-internal claims (`is_admin`, `teams`,
    `user`) — they are always absent from `input.subject.claims`.
  - **Pagination residual.** Truncation bounds each response to 25 users; a
    caller can still enumerate the directory across repeated paged calls if
    the upstream tool accepts pagination arguments. Pair with an ingress clamp
    (see Composition) if cumulative enumeration matters to you.
  - **Shape fail-open on truncation.** Blocks that are not valid JSON, or
    whose top-level value is not an object (e.g. a bare top-level JSON array of
    user objects), or whose top-level object has no `users` array (e.g. a
    nested or renamed key such as `{"result":{"users":[…]}}`), pass through
    untruncated. Likewise, if the gateway delivers the response body as a
    single scalar string rather than the documented `payload.text` **array**
    of content blocks, the `is_array` guard is not met and nothing is
    truncated. The official-server field list comes from the mapped REST
    reference (`Users:list`), not an MCP schema dump — verify the live response
    shape (both the JSON body and the `payload.text` content-block array) with
    the dump-input technique. The download gate is unaffected (it denies
    regardless of body shape).
  - **Per-block truncation — cross-block split residual.** The cap counts
    users **within each content block independently**. A response that spreads
    its user roster across several content blocks, each holding 25 or fewer
    users, is passed through in full because no single block exceeds the cap
    (red-team verified). A conformant `getUsers` response returns one
    `Users:list` body in one block, so this only bites servers that chunk the
    roster across blocks; if that is a concern in your deployment, pair with
    the ingress page-size clamp (see Composition) rather than relying on this
    egress cap alone.
  - **Truncation edits the payload.** The rewritten block gains a `notice`
    field and its `users` array no longer matches sibling counters such as
    `resultSetSize` / `endPosition`; agents that reconcile those counters will
    notice the mismatch.
  - **Download matching is community-server-specific.** Only the verified
    `*download_envelope_document` suffix is gated. Other community servers
    exposing document content under different tool names (or the CData
    `run_query` SQL surface) are not matched — add their suffixes before
    deploying against them.
  - **`getUsers` on other servers.** The CData server can reach the same user
    table through `{servername}_run_query`; this policy does not parse SQL and
    will not truncate that path.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - docusign
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package docusign.egress.cap_directory_and_document_egress

# Deny-by-default: the allow rules below pass everything except signed-document
# downloads by callers outside the contracts-read group. Directory truncation
# is handled by the transform rule and never denies.
default allow := false

# Bounded page size for user-directory responses returned to non-admin callers.
max_users := 25

# -----------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP server
# name (e.g. `docusign-getUsers`), and the prefix is not standardised, so match
# by suffix, case-insensitively. On egress the tool name is available on both
# input.resource.name and input.tool_metadata.name — check both surfaces.
# -----------------------------------------------------------------------------

tool_name_is(suffix) if {
    res := object.get(input, "resource", {})
    is_object(res)
    endswith(lower(object.get(res, "name", "")), suffix)
}

tool_name_is(suffix) if {
    meta := object.get(input, "tool_metadata", {})
    is_object(meta)
    endswith(lower(object.get(meta, "name", "")), suffix)
}

tool_name_is(suffix) if {
    # payload.name is also populated on egress (ingress-canonical, but carries the
    # same value on tool_post_invoke). Checked so the download deny cannot fail
    # open on a gateway that leaves resource.name / tool_metadata.name empty.
    pl := object.get(input, "payload", {})
    is_object(pl)
    endswith(lower(object.get(pl, "name", "")), suffix)
}

# Official server: getUsers enumerates every user in the account (names,
# emails). Suffix match deliberately does not catch getUser / getUserInfo.
is_get_users_tool if {
    tool_name_is("getusers")
}

# Community luthersystems server: returns the whole signed PDF as base64.
# Verified from source; the official production catalog has no download tool.
is_download_tool if {
    tool_name_is("download_envelope_document")
}

# -----------------------------------------------------------------------------
# Identity. Placeholder groups — replace `admin` and `contracts-read` with your
# IdP's group names at import time. The object.get chain means a caller with
# missing subject/claims/groups is never treated as a member: both grants fail
# closed (truncated directory, no downloads).
# -----------------------------------------------------------------------------

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

has_group(name) if {
    some g in caller_groups
    lower(g) == name
}

has_group(name) if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) == name
}

# -----------------------------------------------------------------------------
# Allow rules. Everything except the download tool passes; the download tool
# passes only for the contracts-read group.
# -----------------------------------------------------------------------------

allow if {
    not is_download_tool
}

allow if {
    is_download_tool
    has_group("contracts-read")
}

reasons contains "Downloading signed envelope documents through the agent is restricted to members of the contracts-read group. Review the document in the Docusign web app instead, or ask your Docusign administrator for access. Contact your InfoSec team if you believe this is a false positive." if {
    is_download_tool
    not has_group("contracts-read")
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}

# -----------------------------------------------------------------------------
# Directory truncation. Rewrites each JSON content block whose top-level
# `users` array exceeds max_users, keeping the first page and adding a notice
# so the agent knows the listing is policy-bounded. Blocks that don't parse or
# don't match the documented Users:list shape pass through unchanged (see
# Known limitations).
# -----------------------------------------------------------------------------

truncation_notice := sprintf(
    "Truncated to the first %d users by gateway policy. Ask your Docusign administrator for admin access if you need the full directory.",
    [max_users],
)

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

truncated_users_block(b) := out if {
    is_string(b)
    parsed := json.unmarshal(b)
    is_object(parsed)
    users := object.get(parsed, "users", [])
    is_array(users)
    count(users) > max_users
    out := json.marshal(object.union(parsed, {
        "users": array.slice(users, 0, max_users),
        "notice": truncation_notice,
    }))
}

capped_block(b) := truncated_users_block(b)

capped_block(b) := b if {
    not truncated_users_block(b)
}

capped_blocks := [out |
    some block in text_blocks
    out := capped_block(block)
]

# Emitted only on egress, for non-admin callers, when at least one block
# actually changed. Otherwise the rule is undefined and the aggregator skips
# this policy, returning the response byte-identical.
transform := {
    "transformed_payload": object.union(response_payload, {"text": capped_blocks}),
} if {
    input.mode == "output"
    is_get_users_tool
    not has_group("admin")
    is_array(text_blocks)
    capped_blocks != text_blocks
}
```
