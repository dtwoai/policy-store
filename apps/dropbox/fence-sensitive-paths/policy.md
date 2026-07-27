---
name: Fence Sensitive Dropbox Paths by Team
tags:
  - dropbox
  - fence-sensitive-scopes
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # dropbox / fence-sensitive-paths

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny fenced targets for callers outside the mapped team, allow otherwise
  **Package:** `dropbox.ingress.fence_sensitive_paths`

  ## What it does

  Fences protected Dropbox subtrees by **path prefix**. Dropbox addresses files
  and folders by a root-relative path (`/Finance/2026/payroll.xlsx`), so the
  policy carries a placeholder `fenced_prefixes` map that pairs a top-level path
  prefix with the IdP team group required to touch anything under it — `/HR/` →
  `hr`, `/Finance/` → `finance`, `/Legal/` → `legal`, `/Customers/` →
  `customers`. At ingress it gates **every path-addressed Dropbox tool** and
  denies, for callers who lack the mapped group:

  - **Reads, listings, moves, copies, writes, and deletes** — `ListFolder`,
    `GetFileMetadata`, `GetFileContent`, `CreateFile`, `Copy`, `Move`, `Delete`
    (official server) and their community synonyms (`list_files`,
    `get_file_metadata`, `get_file_content`, `download_file`, `upload_file`,
    `copy_item`, `move_item`, `safe_delete_item` on `dbx-mcp-server`;
    `dropbox_list`, `dropbox_get_metadata`, `dropbox_download`, `dropbox_upload`,
    `dropbox_copy`, `dropbox_move`, `dropbox_delete` on `ngs`) — when **any**
    path-bearing argument falls under a fenced prefix.
  - **Search** — `Search` (official), `search_file_db` (dbx), `dropbox_search`
    (ngs). A search **scoped** to a `path` (or `options.path`) under a fenced
    prefix is denied for callers lacking that group. Because a search that
    supplies **no** path can surface names of files in any fenced tree (the same
    enumeration risk as `ListFolder`), the fail-closed rule below denies it as
    well — an agent cannot enumerate restricted filenames through `ListFolder`
    or `Search`.

  A caller may touch a protected prefix only when their
  `input.subject.claims.groups` include the matching team group; everyone else
  is denied. Group membership is read from `input.subject.claims.groups` via
  `object.get` chains and **fails closed**: a missing, empty, or non-array
  `groups` claim never grants access to a fenced target.

  The policy **fails closed on the path too**: a protected tool whose `path`
  argument is missing, empty, or not a string (an evasion attempt) is treated as
  **unauthorised** rather than allowed — the fence cannot verify a target it
  cannot read, so the request is denied. The prefix check runs
  **case-insensitively on a normalised path**: the path is lowercased, trimmed,
  given a single leading slash, and has runs of `/` collapsed to one (so
  `//finance/x` cannot dodge the `/finance/` prefix) before comparison, and
  matching is prefix-aware — `/finance` fences `/finance` and `/finance/...` but
  not the sibling `/finance-public`. All tools this policy does not inspect pass
  through untouched.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identification and protection of confidential
    information by gating agent access to designated confidential Dropbox trees
    to their mapped groups; **P4.1** — supports limiting personal-information use
    to identified purposes by keeping PI-bearing folders behind team fences on
    the agent channel.
  - **HIPAA §164.308(a)(4)** — supports information access management: access to
    PHI-bearing Dropbox folders is authorized by IdP group on the MCP path;
    **§164.502(b) / §164.514(d)** — supports the minimum-necessary standard by
    fencing PHI folders to the minimal team that needs them.
  - **GDPR Art. 9** — supports special-category protection by fencing folders
    holding health, HR, or other Art. 9 data; **CPRA §1798.121** — supports the
    right to limit use of sensitive personal information by fencing SPI paths to
    a minimal group; **Art. 5(1)(b)** — supports purpose limitation by keeping
    each protected tree accessible only to its owning team.

  ## Tool name matching

  Tool names are matched case-insensitively as an exact name or by `-`/`_`-
  separated suffix, so the policy tolerates any gateway server-name prefix (e.g.
  `dropbox-GetFileContent`):

  - **Official (`mcp.dropbox.com`):** `listfolder`, `getfilemetadata`,
    `getfilecontent`, `createfile`, `copy`, `move`, `delete`, `search`.
  - **Community (`dbx-mcp-server`):** `list_files`, `get_file_metadata`,
    `get_file_content`, `download_file`, `upload_file`, `copy_item`,
    `move_item`, `safe_delete_item`, `search_file_db`.
  - **Community (`ngs`):** `dropbox_list`, `dropbox_get_metadata`,
    `dropbox_download`, `dropbox_upload`, `dropbox_copy`, `dropbox_move`,
    `dropbox_delete`, `dropbox_search`.

  Share-link and external-URL tools are intentionally **not** matched here — gate
  those with [`guard-share-links-external`](../guard-share-links-external/policy.md).
  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  Dropbox does not publish MCP JSON schemas, so the argument names are
  **unverified** and follow the Dropbox API v2 (`files/*`, `files/search_v2`) and
  the community server READMEs — see Known limitations. The policy reads the path
  **defensively from the likely keys**: `path`, `from_path`, `to_path`, `src`,
  `dest`, `source`, `destination`, and the search scope from `path` /
  `options.path`. Before shipping a policy pack, capture a live `tools/list`
  through the gateway and **pin the real argument key(s)** — if the live tool
  names the path under a key not in this list, that fence silently does not fire
  (though a present-but-non-string path still fails closed). Dropbox `id:...`
  handles are **not** resolvable to a path statelessly and are not fenced (see
  Known limitations).

  ## Examples

  ### Allowed — unfenced path

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-GetFileContent", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "dropbox-GetFileContent",
        "args": { "path": "/Projects/roadmap.pdf" }   // not under a fenced prefix
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — fenced path, caller lacks the team group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-GetFileContent", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "dropbox-GetFileContent",
        "args": { "path": "/Finance/2026/payroll.xlsx" }   // under /Finance/ -> finance
      }
    }
  }
  ```

  `allow = false`, `reason = "Dropbox path '/Finance/2026/payroll.xlsx' is inside the protected '/finance/' folder, which is restricted to the 'finance' group. (...)"`.

  ### Denied — protected tool with no readable path (fail closed)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-Search", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "dropbox-Search",
        "args": { "query": "salary" }   // no path scope -> cannot verify -> deny
      }
    }
  }
  ```

  `allow = false`, `reason = "This Dropbox call is a protected file operation but supplied no readable path (...)"`.

  ## Composition

  This policy is single-purpose: it fences every path-addressed read, listing,
  move, copy, write, delete, and search of pinned sensitive path prefixes by
  team. Useful companions:

  - [`guard-share-links-external`](../guard-share-links-external/policy.md) — so
    fenced content that an authorized caller reads cannot be re-shared outward
    via a public link or file request.
  - An egress PII/PHI redaction policy on `GetFileContent` / `download_file` and
    `Search` responses — it also mops up filenames returned by an allowed listing
    of an unfenced ancestor (see Known limitations).
  - A destructive-op gate for `RestoreFolder` / `RestoreFileRevision`, which this
    policy does not cover.

  ## Known limitations

  - **Prefix matching only — no path canonicalization or ID resolution.** The
    policy matches the literal (lowercased, leading-slash-normalized, repeated
    slashes collapsed) path against its prefixes. It does **not** resolve Dropbox
    file `id:...` handles, `ns:<namespace_id>/...` namespace-relative paths,
    shared-link URLs, or `..`/`.` traversal tricks (Dropbox itself does not
    resolve `..`/`.`, so those literal forms do not reach the real file, but a
    file legitimately addressed by its `id:` or `ns:` form **is not** fenced).
    Pin the sensitive subtree's path prefixes at import time and, where your
    workflow uses `id:`/`ns:` addressing, pair with an egress redaction policy.
  - **Fail-closed on missing/unparseable path denies pathless calls.** A
    protected tool with no readable string path — a `Search` with only a query,
    a `ListFolder` of the root, or a path supplied under an unrecognized key —
    is denied rather than allowed. This is deliberate: it is what stops an agent
    from enumerating fenced filenames through an unscoped `ListFolder`/`Search`,
    but it means legitimate whole-drive searches must be re-scoped to a path the
    caller may access.
  - **Broad operations on an unfenced ancestor can still surface fenced
    descendants.** A recursive `ListFolder` of an unfenced parent (e.g.
    `/Projects`) that happens to contain a fenced subtree enumerates items inside
    it. Mitigate by pinning the sensitive **root** prefixes (so listing the root
    itself is caught) and pairing with an egress redaction policy.
  - **Argument names are unverified.** Path and search-scope keys follow the
    Dropbox API v2 and the community server READMEs; Dropbox publishes no MCP
    schemas. If a live tool names the path differently, that fence silently does
    not fire — confirm against a live `tools/list` and pin the real key(s). A
    present-but-non-string path fails closed, so the safe failure mode holds for
    the keys that are checked.
  - **Both source and destination paths are checked on move/copy.** Moving a file
    *out of* a fenced tree (fenced `from_path`/`src`) and moving one *into* a
    fenced tree (fenced `to_path`/`dest`) both require the mapped group. This is
    deliberately conservative; a non-group caller relocating unrelated files into
    a fenced path is denied.
  - **Placeholder configuration.** Path prefixes and group names are
    placeholders — replace `/hr`, `/finance`, `/legal`, `/customers` and the
    group names with your real Dropbox paths and IdP `groups` values at import
    time. Group names are placeholders — replace `finance` with your IdP's group
    name at import time.
  - **`groups` claim must be an array of strings.** A string-valued or otherwise
    malformed claim fails closed (fenced targets deny). If your IdP emits groups
    under a different claim name, update `caller_groups` in the Rego.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - dropbox
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
package dropbox.ingress.fence_sensitive_paths

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# Fence configuration — PLACEHOLDERS, replace at import time.
#
# Dropbox path prefix (lowercase, leading slash, NO trailing slash) -> IdP team
# group required to read/list/move/copy/write/delete/search inside it. A prefix
# fences itself and everything under it (`/finance` fences `/finance` and
# `/finance/...`, but not the sibling `/finance-public`). Groups are compared
# case-insensitively.
fenced_prefixes := {
	"/hr": "hr",
	"/finance": "finance",
	"/legal": "legal",
	"/customers": "customers",
}

# ---------------------------------------------------------------------------
# Identity — read groups via object.get chains so a missing subject/claims/
# groups fails closed (no group -> no access to fenced targets).

caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# True when the caller's groups claim (an array of strings) contains `group`.
# A malformed (non-array) claim makes the iteration fail -> fail closed.
caller_has_group(group) if {
	some g in caller_groups
	lower(g) == lower(group)
}

# ---------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP server
# name (separator not standardized), so match the exact name or a `-`/`_`-
# separated suffix, case-insensitively.

tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

tool_matches(suffix) if tool_name == suffix

tool_matches(suffix) if endswith(tool_name, sprintf("-%s", [suffix]))

tool_matches(suffix) if endswith(tool_name, sprintf("_%s", [suffix]))

# Every path-addressed Dropbox tool this policy gates, across all three
# dialects: reads, listings, moves, copies, writes, deletes, and search.
protected_tool_suffixes := [
	# official (PascalCase, lowercased here)
	"listfolder", "getfilemetadata", "getfilecontent", "createfile",
	"createfolder", "copy", "move", "delete", "search",
	"listfilerevisions",
	# dbx-mcp-server (snake_case)
	"list_files", "get_file_metadata", "get_file_content", "download_file",
	"upload_file", "create_folder", "copy_item", "move_item",
	"safe_delete_item", "search_file_db",
	# ngs (dropbox_ prefix)
	"dropbox_list", "dropbox_get_metadata", "dropbox_download",
	"dropbox_upload", "dropbox_create_folder", "dropbox_copy",
	"dropbox_move", "dropbox_delete", "dropbox_search",
	"dropbox_get_revisions",
]

is_protected_tool if {
	some s in protected_tool_suffixes
	tool_matches(s)
}

# ---------------------------------------------------------------------------
# Argument extraction — object.get everywhere. Read the path defensively from
# the likely keys plus the search scope nested under `options.path`.

args := object.get(object.get(input, "payload", {}), "args", {})

path_keys := ["path", "from_path", "to_path", "src", "dest", "source", "destination"]

# Non-empty string paths supplied on the call.
requested_paths contains p if {
	some k in path_keys
	v := object.get(args, k, "")
	is_string(v)
	v != ""
	p := v
}

requested_paths contains p if {
	v := object.get(object.get(args, "options", {}), "path", "")
	is_string(v)
	v != ""
	p := v
}

# A path-like argument present but not a string (an evasion of the string
# match) — fail closed.
path_malformed if {
	some k in path_keys
	v := object.get(args, k, null)
	v != null
	not is_string(v)
}

path_malformed if {
	v := object.get(object.get(args, "options", {}), "path", null)
	v != null
	not is_string(v)
}

# ---------------------------------------------------------------------------
# Path normalization + prefix test. Case-insensitive, single leading slash.

# Collapse runs of `/` to a single slash so `//finance/x` cannot slip past the
# `/finance/` prefix test. RE2 pattern `/+` -> `/`.
normalized_path(p) := out if {
	t := regex.replace(lower(trim_space(p)), `/+`, "/")
	startswith(t, "/")
	out := t
}

normalized_path(p) := out if {
	t := regex.replace(lower(trim_space(p)), `/+`, "/")
	not startswith(t, "/")
	out := concat("", ["/", t])
}

# True when path `p` is at or under fenced prefix `prefix`.
path_under(p, prefix) if normalized_path(p) == prefix

path_under(p, prefix) if startswith(normalized_path(p), concat("", [prefix, "/"]))

# True when some requested path falls under a fenced prefix whose group the
# caller does not hold.
blocked_by_fence if {
	some p in requested_paths
	some prefix, group in fenced_prefixes
	path_under(p, prefix)
	not caller_has_group(group)
}

# ---------------------------------------------------------------------------
# Allow rules.

# Any tool this policy does not inspect passes through untouched.
allow if not is_protected_tool

# Protected tools: allowed only when a readable string path is present (fail
# closed on missing/unparseable path), no path argument is malformed, and no
# requested path is fenced-without-group.
allow if {
	is_protected_tool
	not path_malformed
	count(requested_paths) > 0
	not blocked_by_fence
}

# ---------------------------------------------------------------------------
# Deny reasons.

# Fenced target the caller may not touch — names the folder rule and the group.
reasons contains msg if {
	is_protected_tool
	some p in requested_paths
	some prefix, group in fenced_prefixes
	path_under(p, prefix)
	not caller_has_group(group)
	msg := sprintf("Dropbox path '%s' is inside the protected '%s/' folder, which is restricted to the '%s' group. Ask your Dropbox administrator to grant you the '%s' group, or contact InfoSec if this fence looks wrong.", [p, prefix, group, group])
}

# Fail closed: a protected tool with no readable string path cannot be verified.
reasons contains "This Dropbox call is a protected file operation but supplied no readable path, so the sensitive-path fence cannot verify it and the request fails closed. Re-issue with an explicit string path (for example the `path` argument scoped to a folder you may access)." if {
	is_protected_tool
	not path_malformed
	count(requested_paths) == 0
}

# Fail closed: a path argument that is present but not a string.
reasons contains "This Dropbox call carries a malformed path argument (not a string), so the sensitive-path fence cannot evaluate it and the request fails closed. Re-issue with a string path." if {
	is_protected_tool
	path_malformed
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
