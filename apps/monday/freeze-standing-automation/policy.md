---
name: Freeze Standing Automation & AI Agents in monday
tags:
  - monday
  - constrain-aggregator
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # monday / freeze-standing-automation

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny the persistence tools, allow everything else
  **Package:** `monday.ingress.freeze_standing_automation`

  ## What it does

  Denies the monday tools that install side effects which outlive the governed
  MCP session. Two classes of tool are blocked:

  - **Standing automations / workflows** — `create_automation`,
    `manage_automations`, `create_workflow`, `update_workflow`, `plan_workflow`,
    `publish_workflow`. These create rule-based automations and workflows that
    keep firing on monday's servers after the agent's session is over.
  - **Autonomous monday AI agents** — `manage_agent`, `manage_agent_triggers`,
    `manage_agent_skills`, `manage_agent_knowledge`. These create and configure
    monday's own AI agents, their triggers, their skills, and the knowledge they
    act on — agents that keep acting on their own after this session ends.

  Per the monday landscape note, both classes are a **persistence mechanism that
  is invisible to per-call governance**: once installed, they act on their own,
  and no subsequent tool call passes through the gateway for the gateway to
  inspect. A prompt-injected agent that can install an automation or an
  autonomous agent has effectively escaped the session boundary. So this policy
  freezes that self-expanding surface at ingress — neither an agent nor an
  injected prompt can create one.

  A designated **platform-admin IdP group** may optionally be allow-listed as the
  legitimate automation author: callers in that group are permitted to use these
  tools. The allow-list is read from `input.subject.claims.groups` and **fails
  closed** — if the claim is missing, empty, or malformed, the caller is treated
  as not privileged and the persistence tools are denied. Every tool this policy
  does not target passes through untouched.

  ## Compliance alignment

  - **SOC 2 CC6.6** — supports boundary protection against external threats: a
    self-expanding surface (agent-installed automations, autonomous AI agents)
    that would let the agent channel keep acting outside the gateway's per-call
    boundary is frozen, so a prompt-injection or a runaway agent cannot plant a
    persistent foothold.
  - **SOC 2 CC6.8** — supports the prevention of unauthorized software: an
    autonomous monday AI agent or a standing automation is, in effect, new
    software running in the account; the agent path may not install it without an
    explicit platform-admin allow-list entry.
  - **SOC 2 CC9.2** — supports vendor / business-partner risk management: the
    monday automations and AI agents installed over the agent channel become part
    of the account's ongoing processing surface; freezing them keeps that surface
    to what a human deliberately created.

  ## Tool name matching

  monday's official server exposes these tools **unprefixed** and in bare
  snake_case: `create_automation`, `manage_automations`, `create_workflow`,
  `update_workflow`, `plan_workflow`, `publish_workflow`, `manage_agent`,
  `manage_agent_triggers`, `manage_agent_skills`, `manage_agent_knowledge`.

  Behind the DTwo gateway a tool appears as `<configured-server-name><sep><tool>`
  and the server-name prefix is not standardized across deployments. The policy
  therefore matches case-insensitively on `lower(input.resource.name)` as either
  the **exact** bare name or a **`-` / `_`-separated suffix**, so it tolerates any
  gateway prefix joined to the tool by a `-` or `_` (`monday-mcp-create_automation`,
  `monday_mcp_create_automation`) — the two separators DTwo actually emits. A prefix
  joined by some other character (`.`, `:`, `/`) is **not** matched and passes
  through; see Known limitations. Requiring a separator before the suffix avoids
  gluing false positives — the
  real write tool `link_board_items_workflow` ends in `_workflow` but does **not**
  end in `-create_workflow` / `_plan_workflow` / any targeted suffix, so it is not
  denied.

  These persistence/agent tools are part of the **official** monday MCP registry;
  the community `sakce/mcp-server-monday` does not expose them. Verify the exact
  names your gateway sends with the dump-input debug technique before relying on
  this in production.

  ## Argument shape

  This policy inspects only the tool **name** (`input.resource.name`) and the
  caller's `groups` claim. It reads no tool arguments, so it is insensitive to
  argument-shape differences and to the fact that several of these tools' exact
  argument schemas were not verified against source (see Known limitations). A
  missing `resource`/`resource.name` resolves to `""` via `object.get` and
  matches nothing; a non-string name is coerced to `""` rather than handed to
  `lower()` (which would raise a built-in type error).

  ## Identity

  The optional allow-list is keyed on the caller's IdP group claim:

  - `input.subject.claims.groups` is read via `object.get` chains, defaulting to
    `[]` — a missing `subject`, `claims`, or `groups` yields no groups.
  - The placeholder admin group is `platform-admin`. Group names are compared
    case-insensitively.
  - A missing or malformed (non-array) `groups` claim never grants the exemption:
    the caller is not privileged and the persistence tools are denied
    (fail closed).

  ## Examples

  ### Allowed — a non-persistence tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp-get_board_items_page", "type": "tool" },
      "payload": {
        "name": "monday-mcp-get_board_items_page",
        "args": { "boardId": 12345 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — a platform-admin creating an automation

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp-create_automation", "type": "tool" },
      "subject": { "sub": "google-apps|ops@example.com", "claims": { "groups": ["platform-admin"] } },
      "payload": { "name": "monday-mcp-create_automation", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — an agent installing a standing automation

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp-create_automation", "type": "tool" },
      "subject": { "sub": "google-apps|bot@example.com", "claims": { "groups": ["engineering"] } },
      "payload": { "name": "monday-mcp-create_automation", "args": {} }
    }
  }
  ```

  `allow = false`, automation reason.

  ### Denied — configuring an autonomous AI agent

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "monday-mcp-manage_agent", "type": "tool" },
      "payload": { "name": "monday-mcp-manage_agent", "args": {} }
    }
  }
  ```

  `allow = false`, agent reason (no `groups` claim → fails closed).

  ## Composition

  This policy is single-purpose: it freezes the persistence/agent surface.
  Useful companions:

  - **`apps/monday/default-deny-unknown-tools`** — the outer allowlist gate. If a
    tenant runs default-deny, these tools are already off the allowlist; keep this
    policy attached so that even if a write tool is later allowlisted, the
    persistence tools stay frozen for non-admin callers.
  - **`apps/monday/fence-sensitive-boards`** — board/workspace IdP-group fencing
    for the reads and reversible writes this policy leaves untouched.
  - An **escape-hatch deny** for `all_monday_api` / `all_api_write` / `manage_tools`
    — without it, an automation could be installed via one raw GraphQL `query`
    string that this name-based policy never sees (see Known limitations).

  ## Known limitations

  - **GraphQL escape hatch bypasses this policy.** `all_monday_api` /
    `all_api_write` reduce every mutation — including installing an automation or
    an agent — to one opaque GraphQL string with no tool name this policy targets.
    Attach the escape-hatch deny companion, or the freeze is defeatable.
  - **Name-based, argument-agnostic.** The policy trusts the tool *name*, not the
    behavior behind it. A tool renamed upstream to something not on the suffix
    list, or a new persistence tool, is not covered until added; pair with
    `default-deny-unknown-tools` so unaudited names fail closed instead. The exact
    argument schemas of several of these tools were not verified against source —
    the policy does not depend on them, but a companion that inspects arguments
    should confirm shapes with dump-input first.
  - **`endswith` trusts the suffix with a required separator.** Matching accepts
    the exact bare name or a `-`/`_`-separated suffix. A tool literally named
    `<prefix>-create_automation` (any prefix glued with a separator) matches — the
    intended portability behavior. A tool that glued a targeted suffix on with no
    separator would not match; no monday tool does this. **Only `-` and `_` count as
    separators.** If a gateway ever joined the server-name prefix to the tool with a
    different character (e.g. `monday.mcp.create_automation`, `monday:create_automation`,
    `monday/create_automation`), the suffix branch would not fire and the call would
    pass through — a residual, not a block. DTwo emits `-`/`_` (verified against the
    model deployments), so this only bites an unusual custom naming scheme; confirm
    your gateway's actual separator with dump-input before relying on the freeze. A
    bare, unprefixed name is always caught by the exact-match branch.
  - **`groups` claim must be an array of strings** under
    `input.subject.claims.groups`. Any other shape fails closed: a string-valued
    claim, an object/map claim (even one whose *values* spell `platform-admin`,
    e.g. `{"role":"platform-admin"}`), or an array containing no matching string
    element all leave the caller not-admin, so the persistence tools deny. The
    `caller_is_admin` rule guards with `is_array` before iterating and
    `is_string` on each element, so a non-string array element is skipped rather
    than raising a type error. If your IdP emits groups under a different claim
    name (e.g. a namespaced custom claim), update `admin_groups` and
    `caller_groups` in the Rego.
  - **Placeholder group name.** `platform-admin` is a placeholder — replace it with
    your IdP's actual automation-author group name at import time. If you want *no*
    exemption at all (freeze for everyone including admins), remove the
    `caller_is_admin` allow branch.
  - **Exact upstream suffixes unverified for your gateway.** The bare names are
    verified from `mondaycom/mcp` source, but the string your gateway sends depends
    on the configured server name. Confirm with dump-input before relying on it.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - monday
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package monday.ingress.freeze_standing_automation

# Deny-by-default: the persistence/agent tools below are blocked unless the
# caller is in an allow-listed platform-admin group. Every tool this policy does
# not target is explicitly allowed through.
default allow := false

# ---------------------------------------------------------------------------
# Targeted tools.
#
# Standing automations / workflows — install rule-based side effects that keep
# firing on monday after this session ends.
automation_suffixes := [
    "create_automation",
    "manage_automations",
    "create_workflow",
    "update_workflow",
    "plan_workflow",
    "publish_workflow",
]

# Autonomous monday AI agents — created/configured here, then act on their own
# after this session ends. manage_agent is listed alongside its sub-tools; the
# separator-suffix match keeps them distinct (manage_agent does not match
# manage_agent_triggers and vice versa).
agent_suffixes := [
    "manage_agent",
    "manage_agent_triggers",
    "manage_agent_skills",
    "manage_agent_knowledge",
]

# ---------------------------------------------------------------------------
# Identity — placeholder platform-admin group, replace at import time. Read via
# object.get chains so a missing subject/claims/groups fails closed (not admin).

# Lowercased allow-listed group names (compared case-insensitively).
admin_groups := {"platform-admin"}

caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# True when the caller holds an allow-listed group. Fails closed on any
# malformed groups claim: the claim must be an *array* (an object would let
# `some g in ...` iterate its values and spoof admin via a value like
# {"role":"platform-admin"}), and each element must be a string before it is
# lowercased and checked. A string/object/number groups claim, or an array with
# no matching string element, yields not-admin -> deny.
caller_is_admin if {
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    admin_groups[lower(g)]
}

# ---------------------------------------------------------------------------
# Tool matching. The gateway prefixes tool names with the configured MCP server
# name (separator not standardized), so match the exact name or a `-`/`_`-
# separated suffix, case-insensitively. A non-string name is coerced to "" so
# lower() is never handed a non-string (which would raise a type error and leave
# allow/reason undefined).

raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

tool_name := lower(raw_tool_name) if is_string(raw_tool_name)

tool_name := "" if not is_string(raw_tool_name)

tool_matches(suffix) if {
    tool_name == suffix
}

tool_matches(suffix) if {
    endswith(tool_name, sprintf("-%s", [suffix]))
}

tool_matches(suffix) if {
    endswith(tool_name, sprintf("_%s", [suffix]))
}

is_automation_tool if {
    some suffix in automation_suffixes
    tool_matches(suffix)
}

is_agent_tool if {
    some suffix in agent_suffixes
    tool_matches(suffix)
}

is_persistence_tool if is_automation_tool

is_persistence_tool if is_agent_tool

# ---------------------------------------------------------------------------
# Allow rules.

# Any tool this policy does not target passes through untouched.
allow if {
    not is_persistence_tool
}

# A platform-admin (allow-listed group) may create automations / agents.
allow if {
    is_persistence_tool
    caller_is_admin
}

# ---------------------------------------------------------------------------
# Deny reasons.

reasons contains "This monday tool installs a standing automation or workflow that keeps running after this session ends, which per-call governance cannot see or stop, so the gateway blocks agent and prompt-driven callers from creating one. Have a human set up the automation directly in the monday UI instead. If you are a designated automation author, ask your admin to add your IdP group to this policy's allow-list." if {
    is_automation_tool
    not caller_is_admin
}

reasons contains "This monday tool manages an autonomous monday AI agent that keeps acting after this session ends, which per-call governance cannot see or stop, so the gateway blocks agent and prompt-driven callers from creating or configuring one. Have a human set up the agent directly in the monday UI instead. If you are a designated automation author, ask your admin to add your IdP group to this policy's allow-list." if {
    is_agent_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
