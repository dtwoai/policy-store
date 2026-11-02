---
name: Block SPL Commands That Write or Send Data
tags:
  - splunk
  - observability
  - access-control
  - exfiltration
  - ingress
publishedAt: 2026-10-11
description: |
  # splunk / block-write-commands

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `splunk.ingress.block_write_commands`

  ## What it does

  Most people assume a Splunk search can only read. In SPL it can do a lot more: delete
  events, write to indexes and lookups, email results out, call external scripts, or run SQL
  against a connected database. This policy lets the agent run searches while blocking the SPL
  commands that change data or send it somewhere else.

  A search is denied when any piped command (including inside a subsearch or `map`) is one of:

  | Command | What it does |
  |---|---|
  | `delete` | Hides events from search permanently |
  | `collect`, `tscollect`, `mcollect`, `meventcollect` | Writes results into an index |
  | `outputlookup`, `outputcsv`, `outputtext` | Writes results to a lookup or file |
  | `sendemail`, `sendalert` | Sends results out of Splunk |
  | `script`, `run` | Runs an external script |
  | `dbxquery`, `dbxoutput` | Runs SQL against, or writes to, a DB Connect database |

  Every other search passes through.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.7** — the agent channel gets read access only, and can't move data out
    of Splunk by email or into other systems.
  - **SOC 2 CC7.2** — protects the integrity of the log data used for monitoring and
    investigations (no `delete`, no polluted indexes).

  ## Why ingress

  These commands take effect while the search runs. The SPL text is in the request, so
  ingress stops the search before Splunk starts it.

  ## How it matches

  Scope is tools whose lowercased name starts with `splunk` (the MCP server name on the
  gateway). The policy scans the `query`, `search`, and `spl` arguments — `splunk_run_query`
  on Splunk's official MCP Server app uses `query` — for a `|` followed by one of the
  commands above as a whole word, case-insensitive. Splunk's MCP Server may also refuse some
  "unsafe" commands on its own; this policy makes the list explicit and enforces it no matter
  how the server is configured.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "splunk-splunk_run_query", "type": "tool" },
      "payload": { "args": { "query": "search index=payments error earliest=-1h | stats count by host" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "splunk-splunk_run_query", "type": "tool" },
      "payload": { "args": { "query": "search index=payments user=* | table user email | outputlookup users.csv" } }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: this Splunk search uses a command that writes, deletes, or sends data (outputlookup). Agents can run read-only searches here. Ask a Splunk admin if you need data changed or exported."`.

  ## Composition

  Pairs with [`splunk/cap-search`](../cap-search/policy.md) (bounded time windows) and
  [`splunk/redact-secrets-egress`](../redact-secrets-egress/policy.md) (egress redaction).

  ## Known limitations

  - **Saved searches are opaque.** `splunk_run_saved_search` runs a search by name; the policy
    can't see its SPL. If your saved searches use any of these commands, restrict which saved
    searches the agent can run, or block that tool.
  - **SPL2 is not parsed.** Queries prefixed with `@spl2` use a different command set; the
    policy only checks the classic SPL commands listed above.
  - **Server name prefix.** Scope is tools whose name starts with `splunk`. Change
    `_is_splunk` if your server is registered under another name.
  - **Literal text.** A search that contains, for example, the quoted phrase `"| collect"` as a
    search term is also denied. That's rare and errs on the safe side.

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
package splunk.ingress.block_write_commands

# Allow by default; deny Splunk searches that pipe into a write/send command.
default allow := true

# SPL commands that change data in Splunk or move it out.
blocked_commands := {
    "delete",
    "collect", "tscollect", "mcollect", "meventcollect",
    "outputlookup", "outputcsv", "outputtext",
    "sendemail", "sendalert",
    "script", "run",
    "dbxquery", "dbxoutput",
}

_tool := lower(object.get(input.resource, "name", ""))

_args := object.get(object.get(input, "payload", {}), "args", {})

_is_splunk if startswith(_tool, "splunk")

# Arguments that carry SPL across the official and community Splunk servers.
_spl_arg_names := {"query", "search", "spl"}

_spl_texts contains t if {
    some k in _spl_arg_names
    t := object.get(_args, k, "")
    is_string(t)
    t != ""
}

# Every command name that directly follows a pipe.
_piped_commands contains lower(m[1]) if {
    some t in _spl_texts
    some m in regex.find_all_string_submatch_n(`\|\s*([A-Za-z_]+)\b`, t, -1)
}

_found := sort([c | some c in _piped_commands; blocked_commands[c]])

_has_blocked if {
    _is_splunk
    count(_found) > 0
}

allow := false if _has_blocked

reason := sprintf("Blocked: this Splunk search uses a command that writes, deletes, or sends data (%s). Agents can run read-only searches here. Ask a Splunk admin if you need data changed or exported.", [concat(", ", _found)]) if _has_blocked
```
