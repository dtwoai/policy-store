---
name: Exclude Personal Drives from Agent Reads
tags:
  - google-drive
  - exclude-personal-drives
  - egress
  - drive
  - scoping
  - confidentiality
  - data-minimization
publishedAt: 2026-08-28
description: |
  # google-drive / exclude-personal-drives

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only for listings; denies personal-file
  metadata lookups and unparseable governed responses)
  **Package:** `google_drive.egress.exclude_personal_drives`

  ## What it does

  Keeps the personal Drive of anyone at the company out of agent reach,
  leaving shared-drive material readable. Agents searching or browsing
  Drive through the gateway see only material held in shared drives:
  anything sitting in an individual's own Drive is removed from search and
  recent-file listings, and a direct metadata lookup on such a file is
  refused outright. Anything withheld from a listing is marked with a
  `notice`, so the agent can tell files were held back by policy rather
  than absent from Drive.

  **Ownership is the signal.** Files held in a shared drive come back with
  no `owner` field; files in someone's personal Drive carry one. The policy
  withholds any file whose owner is at a listed domain, which covers every
  colleague's personal Drive as well as the operator's own, at any folder
  depth, with no maintenance as people join. This holds for a colleague's
  file shared into the caller's Drive too — that file still lives in the
  colleague's personal Drive.

  **The `personal_owner_domains` entry (`example.com`) is a placeholder** —
  replace it with your own workspace domain(s) at import time.

  ## Tool name matching

  Only the Drive tools whose responses identify the file they describe are
  governed, matched case-insensitively by suffix on `input.resource.name`
  in both naming styles:

  - `*-search-files`, `*-list-recent-files`, `*-get-file-metadata` —
    Google official Drive MCP server (kebab-case tool names).
  - `*-search_files`, `*-list_recent_files`, `*-get_file_metadata` —
    snake_case variant.

  The content tools (`read-file-content`, `download-file-content`) are
  deliberately absent: their responses carry only file content, with
  nothing identifying whose Drive the file sits in, so this policy has
  nothing to test them against (see Known limitations).

  ## Response shape

  - **search-files / list-recent-files:** a top-level `files` array —
    excluded entries are dropped, the rest returned, and the `notice`
    added. Unchanged blocks pass through byte-identical.
  - **get-file-metadata:** one flat file object rather than a list. There
    is nothing to filter a single record down to, so an excluded file is
    denied outright with a reason.

  A governed response that carries content but where no block parses as
  JSON is denied rather than returned unfiltered (the signature of an
  upstream schema change).

  ## Examples

  With `personal_owner_domains := {"example.com"}`, a search returning a
  board deck owned by `alice@example.com` alongside a shared-drive handbook
  comes back with only the handbook plus the notice; `get-file-metadata` on
  the board deck is refused. The `@` is part of the compared suffix, so a
  lookalike domain such as `notexample.com` does not match.

  ## Composition

  - `apps/google-drive/cap-bulk-export` — volume control on the same
    listing surface.
  - `apps/google-drive/redact-pii-egress` — content-level redaction for
    the read path this policy deliberately leaves open.
  - `apps/google-drive/fence-restricted-folders` — ID-based ingress
    fencing for specific files/folders, complementary to this ownership
    rule.

  ## Known limitations

  - **Content reads are not governed.** An agent already holding a file's
    ID can still read its contents — content responses carry no owner for
    the policy to test. Pair with an ingress fence (or gate content tools
    by ID) if that path matters in your environment.
  - **The owner field is the entire signal.** A Drive surface that returns
    owner data under a different key, or omits it for personal files,
    defeats the test — verify with the dump-input technique.
  - **Domain-suffix matching is exact.** Secondary workspace domains must
    each be listed.
  - **Validation status.** Validated live against the Google official
    Drive MCP server (kebab-case names) behind a DTwo gateway; the
    snake_case variants come from documentation and have not been exercised
    against a live server.
direction: egress
apps:
  - google-drive
industries: []
bundles: []
experimental: false
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_drive.egress.exclude_personal_drives

# Withholds Drive results that live in a listed domain's personal Drives,
# leaving shared-drive material readable.

# --- Configuration -----------------------------------------------------------
# Domains whose members' personal Drives are off limits. Placeholder — replace
# with your workspace domain(s) at import time; add entries to cover secondary
# domains.

personal_owner_domains := {"example.com"}

default allow := true

filter_notice := "Files in a personal Drive were removed by gateway policy."

# --- Scope ---------------------------------------------------------------------
# Only the Drive tools whose responses identify the file they describe are
# governed. Matched case-insensitively as a suffix including the separator:
# the gateway prefixes tool names with the MCP server's configured name
# (drive, gdrive, ...), and the leading hyphen stops an unrelated tool whose
# name merely ends in these characters from matching. Both kebab-case and
# snake_case vocabularies are covered.
#
# The content tools are deliberately absent: their responses carry only file
# content, with no owner, so this policy has nothing to test them against.

drive_located_suffixes := {
  "-search-files",
  "-search_files",
  "-list-recent-files",
  "-list_recent_files",
  "-get-file-metadata",
  "-get_file_metadata",
}

metadata_suffixes := {
  "-get-file-metadata",
  "-get_file_metadata",
}

tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

is_governed if {
  some suffix in drive_located_suffixes
  endswith(tool_name, suffix)
}

is_metadata_tool if {
  some suffix in metadata_suffixes
  endswith(tool_name, suffix)
}

# --- Exclusion test ---------------------------------------------------------------
# An `owner` field means the file sits in that person's personal Drive: files
# held in a shared drive come back with no owner at all. Matching on the domain
# rather than a list of addresses covers every person at the company, including
# ones who join later, and reaches any depth of folder without enumerating one.
#
# This holds for a colleague's file shared into the caller's Drive as well —
# such a file still lives in the colleague's personal Drive, so it is withheld
# too.
#
# The "@" is part of the compared suffix so that a lookalike domain such as
# notexample.com does not match.

is_excluded(f) if {
  raw := object.get(f, "owner", "")
  is_string(raw)
  addr := lower(raw)
  some domain in personal_owner_domains
  endswith(addr, concat("", ["@", lower(domain)]))
}

# --- Response payload ------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

# --- Per-block filtering -----------------------------------------------------------
# search-files / list-recent-files shape: files[]. Excluded entries are dropped
# and the rest returned. Defined only when something actually changes, so an
# unaffected block passes through byte-identical via kept_block below.

filtered_block(b) := out if {
  is_governed
  is_string(b)
  parsed := json.unmarshal(b)
  is_object(parsed)
  files_in := object.get(parsed, "files", [])
  is_array(files_in)
  count(files_in) > 0
  kept := [f |
    some f in files_in
    not is_excluded(f)
  ]
  count(kept) < count(files_in)
  out := json.marshal(object.union(parsed, {
    "files": kept,
    "notice": filter_notice,
  }))
}

kept_block(b) := filtered_block(b)

kept_block(b) := b if {
  not filtered_block(b)
}

kept_blocks := [out |
  some block in text_blocks
  out := kept_block(block)
]

transform := {
  "transformed_payload": object.union(response_payload, {"text": kept_blocks}),
} if {
  input.mode == "output"
  is_governed
  is_array(text_blocks)
  kept_blocks != text_blocks
}

# --- Deny path -------------------------------------------------------------------
# get-file-metadata returns one flat file object rather than a files[] list.
# There is nothing to filter down to, so an excluded file is denied outright.

metadata_is_excluded if {
  is_metadata_tool
  some b in text_blocks
  is_string(b)
  parsed := json.unmarshal(b)
  is_object(parsed)
  count(object.get(parsed, "files", [])) == 0
  is_excluded(parsed)
}

allow := false if {
  metadata_is_excluded
}

# A governed response that carries content but where nothing parses cannot be
# filtered at all. That is the signature of an upstream schema change, so it is
# denied rather than returned unfiltered.

parseable_count := count([b |
  is_governed
  some b in text_blocks
  is_string(b)
  obj := json.unmarshal(b)
  is_object(obj)
])

allow := false if {
  is_governed
  count(text_blocks) > 0
  parseable_count == 0
}

reason := "Blocked: this Drive result is in a personal Drive, or could not be inspected to determine whose Drive it is in." if not allow
```
