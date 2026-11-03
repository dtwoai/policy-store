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

  - **No time range given** → `earliest=-24h` is added. The main search and every subsearch
    are checked separately, because Splunk gives each one its own time range: a bounded
    subsearch doesn't bound the main search, and the other way round.
  - **A relative range longer than 7 days** (`earliest=-30d`, `earliest=-1y@y`) → replaced with
    `earliest=-7d`. Snapping counts: `@y`, `@q`, `@mon`, or `-1d@w` can reach back further than
    the number in front of it, so the policy assumes the furthest it could go.
  - **All time or an old epoch** (`earliest=0`, `earliest=1`, an epoch more than 7 days ago) →
    replaced with `earliest=-7d`.
  - **A relative expression it can't read** (an unknown unit, chained offsets) → replaced with
    `earliest=-7d`, so it is always bounded.
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
  subsearches, is checked on its own.

  The main search and each subsearch (`[ ... ]`, nested or not) is a separate scope. Brackets
  inside double-quoted strings, like a `rex` character class, are not subsearches. A scope with
  no `earliest=` of its own gets `earliest=-24h` right after its leading `search` keyword, or
  at its start. Subsearches that start with a generating command (`[| inputlookup …]`) are
  skipped. When the tool has an `earliest_time` argument, it sets the range for the whole job,
  so nothing is added to the SPL.

  Relative units understood: seconds, minutes, hours, days, weeks, months (30 days), quarters
  (90 days), and years (365 days), in Splunk's short and long spellings. A relative time is
  read as `[offset][@snap][offset]` (`-1d@d`, `@y`, `@d-3h`). Its lookback is the offset back,
  plus the most a snap can add (a full unit: up to 31 days for `@mon`, 92 for `@q`, 366 for
  `@y`, 7 for `@w0`–`@w7`), plus any offset back after the snap. So `-7d@d` counts as 8 days
  and is trimmed, and `-6d@d` is left alone.

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
  - **Snaps are counted at their widest.** The policy doesn't know the time of day or your
    Splunk timezone, so `-7d@d` (at most 8 days) is trimmed to `-7d` even when it would have
    reached back only a few hours past 7 days.
  - **Unbalanced brackets.** If the unquoted `[` and `]` in a query don't pair up, the whole
    query is treated as one search, as before.
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

# Most a snap to the start of a unit can reach back. Calendar units use their
# longest length; a week snap (@w, @w0–@w7) reaches back at most 7 days.
_snap_seconds(u) := 2678400 if _unit_seconds[u] == 2592000 # month: 31 days

_snap_seconds(u) := 7948800 if _unit_seconds[u] == 7776000 # quarter: 92 days

_snap_seconds(u) := 31622400 if _unit_seconds[u] == 31536000 # year: 366 days

_snap_seconds(u) := secs if {
    secs := _unit_seconds[u]
    not secs in {2592000, 7776000, 31536000}
}

# A relative time: [offset][@snap[digit]][offset], e.g. -30d, -1y@y, @mon, @d-3h, -1d@w0.
_relative_pattern := `^(?:([+-])(\d*)([a-z]+))?(?:@([a-z]+?)(\d?))?(?:([+-])(\d*)([a-z]+))?$`

_amount(n) := 1 if n == ""

_amount(n) := to_number(n) if n != ""

# Seconds an offset moves back in time. Forward offsets (+) count as zero.
_back("", _, _) := 0

_back("+", _, u) := 0 if _unit_seconds[u]

_back("-", n, u) := _amount(n) * _unit_seconds[u]

_snap_back("") := 0

_snap_back(u) := _snap_seconds(u) if u != ""

# Furthest a relative time can reach back, in seconds. Undefined when the value
# isn't a relative time this policy can read (an unknown unit, chained offsets).
_lookback(v) := pre + snap + post if {
    m := regex.find_all_string_submatch_n(_relative_pattern, lower(v), 1)
    count(m) == 1
    g := m[0]
    concat("", [g[1], g[4]]) != "" # needs an offset or a snap
    pre := _back(g[1], g[2], g[3])
    snap := _snap_back(g[4])
    post := _back(g[6], g[7], g[8])
}

# Relative (offset and/or snap) and reaching back further than the cap.
_too_wide(v) if _lookback(v) > _max_seconds

# Looks relative but can't be read: bound it rather than let it through.
_too_wide(v) if {
    regex.match(`^[-+@]`, v)
    not _lookback(v)
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

# --- Search scopes: the main search and each [subsearch] ---

_chars := split(_spl, "")

_n := count(_chars)

# Double quotes that open or close a string (not escaped with a backslash).
_quotes := [i | some i, c in _chars; c == "\""; not _escaped(i)]

_escaped(i) if {
    i > 0
    _chars[i - 1] == "\\"
}

_in_quotes(i) if count([q | some q in _quotes; q < i]) % 2 == 1

# Unquoted brackets, in position order. Brackets inside a quoted string (a rex
# character class, say) are not subsearches.
_brackets := sort([[i, c] |
    some i, c in _chars
    c in {"[", "]"}
    not _in_quotes(i)
])

# Subsearch depth just before position i.
_depth_before(i) := count([1 | some b in _brackets; b[0] < i; b[1] == "["]) - count([1 | some b in _brackets; b[0] < i; b[1] == "]"])

_balanced if {
    _depth_before(_n) == 0
    every b in _brackets {
        _depth_before(b[0] + 1) >= 0
    }
}

# [content start, content end, depth] for each subsearch.
_subsearches contains [s, e, d] if {
    _balanced
    some b in _brackets
    b[1] == "["
    d := _depth_before(b[0]) + 1
    closes := [c[0] | some c in _brackets; c[1] == "]"; c[0] > b[0]; _depth_before(c[0]) == d]
    count(closes) > 0
    e := min(closes)
    s := b[0] + 1
}

_scopes := array.concat([[0, _n, 0]], [sc | some sc in _subsearches])

# A scope's own text, with nested subsearches left out.
_own_text(sc) := _spl if {
    sc[2] == 0
    not _balanced
}

_own_text(sc) := concat("", [_chars[k] | some k in numbers.range(sc[0], sc[1] - 1); _depth_before(k) == sc[2]]) if {
    _balanced
    sc[1] > sc[0]
}

_own_text(sc) := "" if {
    _balanced
    sc[1] <= sc[0]
}

_needs_default(own) if {
    t := trim_space(own)
    t != ""
    not startswith(t, "|")
    not startswith(lower(t), "@spl2")
    not regex.match(`(?i)\bearliest\s*=`, own)
}

# Where earliest= goes in a scope: after a leading "search" keyword, or at the
# first non-space character.
_insert_offset(content) := count(m[0][0]) if {
    m := regex.find_all_string_submatch_n(`(?i)^\s*search\s+`, content, 1)
    count(m) == 1
}

_insert_offset(content) := count(content) - count(trim_left(content, " \t\r\n")) if {
    not regex.match(`(?i)^\s*search\s+`, content)
}

_default_positions := sort([p |
    not _has_earliest_arg
    some sc in _scopes
    _needs_default(_own_text(sc))
    p := sc[0] + _insert_offset(substring(_spl, sc[0], sc[1] - sc[0]))
])

_insert_text := sprintf("earliest=%s ", [default_earliest])

_with_defaults := _spl if count(_default_positions) == 0

_with_defaults := concat(_insert_text, parts) if {
    ps := _default_positions
    count(ps) > 0
    starts := array.concat([0], ps)
    ends := array.concat(ps, [_n])
    parts := [substring(_spl, starts[i], ends[i] - starts[i]) | some i in numbers.range(0, count(ps))]
}

_spl_changed if count(_wide_tokens) > 0

_spl_changed if count(_default_positions) > 0

_new_spl := strings.replace_n(_wide_tokens, _with_defaults) if {
    not _skip_spl
    _spl_changed
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
