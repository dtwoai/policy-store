---
name: Bound the Time Range of Splunk Searches
tags:
  - splunk
  - observability
  - data-minimization
  - cost-control
  - ingress
publishedAt: 2026-10-11
description: |
  # splunk / cap-search

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only, never denies)
  **Package:** `splunk.ingress.cap_search`

  ## What it does

  Makes sure every Splunk search the agent runs has a bounded time range. A search with no
  `earliest=` runs over all time, which is slow, expensive, and pulls far more data than an
  investigation needs. This policy rewrites the SPL before it reaches Splunk:

  - **No time range given** → `earliest=-24h` is added.
  - **A relative range longer than 7 days** (`earliest=-30d`, `earliest=-1y@y`) → replaced with
    `earliest=-7d`.
  - **All time or an old epoch** (`earliest=0`, `earliest=1`, an epoch more than 7 days ago) →
    replaced with `earliest=-7d`.
  - Ranges of 7 days or less are left alone.

  If the tool takes a separate `earliest_time` argument (custom Splunk tools and community
  servers do), that argument is bounded the same way instead of editing the SPL.

  ## Compliance alignment

  - **GDPR Art. 5(1)(c)** — data minimisation: each agent search reads a bounded slice of
    log data.
  - **SOC 2 CC6.1** — limits the volume of data the agent channel can pull per call.

  ## Why ingress

  The time range is part of the request. Bounding it before the search runs is the only way
  to keep Splunk from scanning all time.

  ## How it matches

  Scope is tools whose lowercased name starts with `splunk`. The policy edits the first of the
  `query`, `search`, or `spl` arguments that is present (`splunk_run_query` on Splunk's
  official MCP Server app uses `query`). Each `earliest=` in the SPL, including inside
  subsearches, is checked on its own. When none is present, `earliest=-24h` goes right after a
  leading `search` keyword, or at the very start of the query.

  Relative units understood: seconds, minutes, hours, days, weeks, months (30 days), quarters
  (90 days), and years (365 days), in Splunk's short and long spellings, with an optional
  `@` snap.

  ## Configuration

  `default_earliest` (the range added when none is given) and `max_lookback_days` at the top of
  the policy.

  ## Examples

  ### Range added

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "splunk-splunk_run_query", "type": "tool" },
      "payload": { "args": { "query": "search index=payments timeout | stats count by host" } }
    }
  }
  ```

  `transform.transformed_payload.query` = `"search earliest=-24h index=payments timeout | stats count by host"`.

  ### Range trimmed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "splunk-splunk_run_query", "type": "tool" },
      "payload": { "args": { "query": "index=payments earliest=-90d timeout" } }
    }
  }
  ```

  `transform.transformed_payload.query` = `"index=payments earliest=-7d timeout"`.

  ## Composition

  Pairs with [`splunk/block-write-commands`](../block-write-commands/policy.md) and
  [`splunk/redact-secrets-egress`](../redact-secrets-egress/policy.md).

  ## Known limitations

  - **Generating commands and SPL2 are skipped.** Queries that start with `|` (`| tstats`,
    `| inputlookup`, `| rest`) or `@spl2` are not rewritten, because adding `earliest=` at the
    front would break them. `tstats` searches are usually cheap; add `earliest=` inside its
    `where` clause yourself if needed.
  - **Absolute dates pass.** `earliest=10/01/2026:00:00:00` and other formatted dates are not
    parsed and are left as written.
  - **`latest=` is not checked.** A search like `earliest=-7d latest=-6d` is narrower, not
    wider, so only `earliest` matters for the cap.
  - **Server name prefix.** Scope is tools whose name starts with `splunk`. Change
    `_is_splunk` if your server is registered under another name.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - splunk
industries: []
bundles:
  - engineering-stack-jira
  - engineering-stack-linear
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package splunk.ingress.cap_search

# Transform-only policy — never denies, only bounds the search time range.
default allow := true

default_earliest := "-24h"

max_lookback_days := 7

_cap := sprintf("-%dd", [max_lookback_days])

_max_seconds := max_lookback_days * 86400

# Seconds per Splunk relative-time unit.
_unit_seconds := {
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
    "w": 604800, "week": 604800, "weeks": 604800,
    "mon": 2592000, "month": 2592000, "months": 2592000,
    "q": 7776000, "qtr": 7776000, "qtrs": 7776000, "quarter": 7776000, "quarters": 7776000,
    "y": 31536000, "yr": 31536000, "yrs": 31536000, "year": 31536000, "years": 31536000,
}

_tool := lower(object.get(input.resource, "name", ""))

_args := object.get(object.get(input, "payload", {}), "args", {})

_is_splunk if startswith(_tool, "splunk")

# The SPL argument to edit: the first of query / search / spl that is a non-empty string.
_spl_keys := [k |
    some k in ["query", "search", "spl"]
    v := object.get(_args, k, null)
    is_string(v)
    trim_space(v) != ""
]

_spl_key := _spl_keys[0] if count(_spl_keys) > 0

_spl := object.get(_args, _spl_key, "")

# --- Is an earliest value too wide? ---

# Relative, e.g. -30d or -1y@y.
_too_wide(v) if {
    m := regex.find_all_string_submatch_n(`^-(\d+)([a-z]+)(@.*)?$`, lower(v), 1)
    count(m) == 1
    secs := _unit_seconds[m[0][2]]
    to_number(m[0][1]) * secs > _max_seconds
}

# All time, or an epoch more than the cap in the past.
_too_wide(v) if {
    regex.match(`^\d+(\.\d+)?$`, v)
    (time.now_ns() / 1000000000) - to_number(v) > _max_seconds
}

_too_wide(v) if v == ""

# --- SPL edits ---

_skip_spl if startswith(trim_space(_spl), "|")

_skip_spl if startswith(lower(trim_space(_spl)), "@spl2")

# Each earliest=<value> token in the SPL (value optionally quoted).
_earliest_tokens contains [m[0], m[1]] if {
    some m in regex.find_all_string_submatch_n(`(?i)\bearliest\s*=\s*"?([^\s"\]|]*)"?`, _spl, -1)
}

_wide_tokens := {tok[0]: sprintf("earliest=%s", [_cap]) |
    some tok in _earliest_tokens
    _too_wide(tok[1])
}

_has_earliest_arg if is_string(object.get(_args, "earliest_time", null))

_new_spl := strings.replace_n(_wide_tokens, _spl) if {
    not _skip_spl
    count(_earliest_tokens) > 0
    count(_wide_tokens) > 0
}

_new_spl := spl if {
    not _skip_spl
    not _has_earliest_arg
    count(_earliest_tokens) == 0
    m := regex.find_all_string_submatch_n(`(?i)^(\s*search\s+)(.*)$`, _spl, 1)
    count(m) == 1
    spl := sprintf("%searliest=%s %s", [m[0][1], default_earliest, m[0][2]])
}

_new_spl := spl if {
    not _skip_spl
    not _has_earliest_arg
    count(_earliest_tokens) == 0
    not regex.match(`(?i)^\s*search\s+`, _spl)
    spl := sprintf("earliest=%s %s", [default_earliest, trim_left(_spl, " \t\n")])
}

# --- earliest_time argument (custom / community tools) ---

_new_earliest_arg := _cap if {
    _has_earliest_arg
    _too_wide(trim_space(object.get(_args, "earliest_time", "")))
}

# --- Transform ---

_patch[_spl_key] := _new_spl if _is_splunk

_patch["earliest_time"] := _new_earliest_arg if _is_splunk

transform := {"transformed_payload": object.union(_args, _patch)} if {
    input.action == "tool_pre_invoke"
    count(_patch) > 0
}
```
