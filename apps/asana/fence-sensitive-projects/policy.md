---
name: Fence Writes to Sensitive Asana Projects
tags:
  - asana
  - fence-sensitive-scopes
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # asana / fence-sensitive-projects

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny writes that target a fenced project GID for callers outside the mapped group, allow otherwise
  **Package:** `asana.ingress.fence_sensitive_projects`

  ## What it does

  Asana is routinely used for HR (hiring, performance, offboarding), legal, M&A, and
  incident work; those project bodies, comments, custom fields, and status updates carry
  PII and confidential material. Sensitivity is a property of the **project GID**, not the
  tool. This policy converts Asana's single-OAuth-token scope into per-team least privilege
  by pinning sensitive project GIDs to the IdP group required to write to them.

  At ingress it inspects the write tools that can push content into — or grant visibility
  on — a project, extracts every project/section GID that appears **directly** in the
  payload, and denies the call when a requested GID is fenced and the caller lacks the
  mapped IdP group. Inspected write tools:

  - **Official V2 batch** `create_tasks` / `update_tasks` — each carries an array of up to
    **50** task objects; the policy iterates every element and reads its `project`,
    `projects[]`, and `section` fields.
  - **Official** `add_comment` and `create_project_status_update` — comment / status-update
    writes that are externally visible to project followers.
  - **Community** (`roychri` / `cristip73`) `asana_create_task` / `asana_update_task`
    (`project_id`, `projects[]`), `asana_create_task_story` (the community comment tool),
    `asana_add_task_to_section` (`section_id`), `asana_add_followers_to_task` (grants a task's
    visibility to new followers), `asana_create_project_status` (the community twin of
    `create_project_status_update`, broadcasts to project followers), and
    `asana_add_project_to_task` (adds a task into a project by project GID — grants project
    membership, i.e. content + visibility, on the fenced project).

  The protected set carries **placeholder** GIDs mapped to placeholder groups
  (`hr`, `legal`, `ma`, `incident`). Pin your tenant's real project GIDs (and group names),
  or empty the list, at import time — a project reached by a GID not on the list is not
  fenced.

  Group membership is read from `input.subject.claims.groups` via `object.get(input.subject,
  "claims", {})` chains and fails closed: a missing, empty, or malformed `groups` claim never
  grants a write to a fenced project — no group means not permitted. Every tool this policy
  does not inspect passes through untouched.

  ## Why ingress and not egress

  These are writes with permanent, often externally-visible side effects: once the call
  reaches Asana the task exists, the comment or status update has notified followers (including
  external guests on shared projects), and follower additions have granted visibility. Egress
  can only mask the response, not undo the write or the notification. Ingress denial is the
  only point at which the write into a fenced project is actually prevented.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identification and protection of confidential information by
    gating agent writes to designated confidential projects to their mapped groups; **P4.1** —
    supports limiting personal-information use to identified purposes by keeping PI-bearing
    projects (HR / M&A) behind role fences on the agent channel.
  - **GDPR Art. 9** — supports special-category protection by fencing writes to projects holding
    health, HR, or other Art. 9 data; **Art. 5(1)(b)** — supports purpose limitation by keeping
    sensitive projects scoped to the team whose purpose they serve; **CPRA §1798.121** — supports
    the right to limit use of sensitive personal information by fencing SPI projects to a minimal
    group.

  (Per the coverage matrix, these rows map to policy family **PF-23** (`fence-sensitive-scopes`).)

  ## Tool name matching

  Tool matching is **suffix-based** and case-insensitive so it covers both the official V2
  bare-verb spellings and the `asana_`-prefixed community spellings behind any gateway
  server-name prefix. A name matches a suffix when it equals it exactly, or ends with the suffix
  preceded by a `-` or `_` separator (e.g. `asana-create_tasks`, `asana_create_tasks`). The two
  divergent spellings are matched by distinct suffixes:

  - official plural batch `create_tasks` / `update_tasks` vs community singular
    `asana_create_task` / `asana_update_task`;
  - official `add_comment` vs community `asana_create_task_story` (same externally-visible action,
    two suffixes).

  The name is read from **both** the PARC field (`input.resource.name`) and the legacy alias
  (`input.payload.name`) via `object.get` chains, coerced to a lowercased, whitespace-trimmed
  string (a missing or non-string value resolves to `""` rather than leaving the match undefined),
  and the two fields are matched **independently** — a malformed value in one cannot suppress a
  real write suffix in the other.

  Asana's tool set evolves (Asana says to use `tools/list` for the current set; `add_comment` was
  absent at V2 launch and added later). Verify the exact names your gateway sends with the
  dump-input debug technique before relying on this in production.

  ## Argument shape

  Asana does **not** publish the V2 per-parameter JSON schema (it is only visible via a live
  `tools/list`), so the GID-bearing argument keys below are **documented field lists, not verified
  schema keys**. The policy scans a fixed set of candidate keys both at the top level and inside
  each batch element:

  - scalar GID keys: `project`, `section`, `project_id`, `section_id`, `parent`;
  - array GID key: `projects[]`.

  `parent` is scanned because Asana's status-update surface
  (`create_project_status_update` / `asana_create_project_status`) carries the target
  project GID under `parent` (the native `POST /status_updates` parameter), not `project`;
  scanning `parent` closes the broadcast-into-a-fenced-project path. `parent` is also the
  subtask-parent key on `create_tasks` / `update_tasks`, where it holds a **task** GID —
  harmless to scan, because a task GID never equals a fenced **project** GID, so no
  false-positive deny is introduced (a subtask created under a task that itself lives in a
  fenced project is the transitive case below, still a documented pass-through).

  Batch arrays for `create_tasks` / `update_tasks` are read under candidate keys `tasks`, `data`,
  `items` (the array-holding key is **unverified** — same caveat as the batch policy). GIDs are
  normalized to a trimmed string, so numeric and string encodings both match. A candidate key that
  is missing or non-scalar is simply skipped.

  ## Examples

  ### Allowed — write to a non-fenced project

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-create_tasks", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "asana-create_tasks",
        "args": { "tasks": [ { "name": "ship it", "project": "1209999999999" } ] }  // not fenced
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — write to a fenced project by a member of the mapped group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-add_comment", "type": "tool" },
      "subject": { "sub": "google-apps|hr@example.com", "claims": { "groups": ["hr"] } },
      "payload": { "name": "asana-add_comment", "args": { "project": "1201111111111", "text": "note" } }
    }
  }
  ```

  `allow = true`.

  ### Denied — write to a fenced project by a caller outside the group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-create_tasks", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "asana-create_tasks",
        "args": { "tasks": [ { "name": "leak", "project": "1201111111111" } ] }  // fenced -> hr
      }
    }
  }
  ```

  `allow = false`, `reason = "Asana project 1201111111111 is fenced as sensitive and requires the 'hr' IdP group to write to it; (...)"`.

  ## Composition

  This policy only fences writes when a protected GID appears **directly** in the payload. It is
  deliberately paired with:

  - **`apps/asana/freeze-destructive-ops`** — freezes `delete_task` and community delete tools; a
    fenced project's tasks can still be *deleted* without this companion.
  - **`apps/asana/cap-batch-mutation`** — caps batch blast radius; the fence bounds *which* projects
    a batch may touch, the cap bounds *how many* records per call.
  - An **egress PII redaction** policy on `get_task` / `search_tasks` / `asana_get_task_stories`
    responses, to cover reads (this policy is write-side only) and mop up regulated values.

  ## Known limitations

  - **Direct-GID matching only (the core limitation).** The rule fires only when a protected
    project/section GID appears directly in the payload. It **cannot** transitively resolve a
    task's project from a bare `parent` / `task_id` reference (e.g. `add_comment`,
    `asana_create_task_story`, `asana_add_followers_to_task`, or an `update_tasks` element that
    names only a task GID). Such a call passes through this policy. This fence must therefore be
    **paired** with the destructive-ops and batch companions above, not relied on alone.
  - **Placeholder configuration.** The GIDs and group names (`hr`, `legal`, `ma`, `incident`) are
    placeholders — replace them with your deployment's real Asana project GIDs and IdP group names,
    or empty the list, at import time. **Group names are placeholders — replace `hr` with your
    IdP's group name at import time.** Confirm your IdP actually emits a `groups` claim (Auth0 and
    most IdPs require explicit configuration); with no `groups` claim the policy fails closed
    (writes to fenced projects are denied for everyone).
  - **`groups` must be an array of strings.** A string-valued or otherwise malformed `groups` claim
    fails closed (fenced writes deny). If your IdP emits groups under a different claim name, update
    `caller_has_group` in the Rego.
  - **Unverified argument keys.** Asana does not publish the V2 per-parameter schema; the GID field
    keys (`project`, `section`, `project_id`, `section_id`, `parent`, `projects[]`) and the batch
    array keys (`tasks`, `data`, `items`) are best-effort candidate lists. `parent` was added after a
    red-team review found that a status-update broadcast (`create_project_status_update` /
    `asana_create_project_status`) names its project GID under `parent`, not `project`, and so slipped
    the fence uninspected. Confirm the real keys via a live `tools/list` and extend the constants. A
    write that names its project GID under a key not in the list is not fenced (same class as the
    direct-GID limitation). Two shapes are known **not** covered and pass through: a GID wrapped in an
    object (`projects: [{"gid": "..."}]`) rather than a bare GID string, and a payload whose `args` is
    a positional array rather than a named-argument object — neither is a shape the MCP tool surface is
    expected to emit, but both are residuals if a nonconforming server does.
  - **Structural community writes into a project are not fenced.** The community `asana_create_section`
    / `asana_create_section_for_project` tools create a section *inside* a project by direct project
    GID. They are deliberately **not** in `write_suffixes`: they add structure, not PII-bearing task
    bodies/comments/status broadcasts, so they are lower leak value and left as a documented residual
    (a pinned allow test locks this pass-through). If your threat model treats section creation inside
    a fenced project as sensitive, add those suffixes to `write_suffixes` — the existing `project` /
    `project_id` scalar keys already cover their GID argument. `asana_update_project` (which modifies a
    fenced project's own settings, including `privacy_setting`) is likewise out of scope here; pair the
    PF `privacy-flip` companion for that surface.
  - **Tool-inventory drift.** Asana's V2 set evolves and community forks add tools; a new write tool
    with a different suffix is not inspected until added to `write_suffixes`. For a hard guarantee
    against unknown tools, compose the PF-28 `default-deny-unknown-tools` allowlist alongside this
    policy.
  - **Suffix matching is portable but broad.** A hypothetical unrelated tool whose name ends in one
    of the matched suffixes preceded by `-`/`_` would also be inspected (and allowed unless it names
    a fenced GID). For a scope fence, over-inspection is the safe direction.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - asana
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package asana.ingress.fence_sensitive_projects

# Deny-by-default. The pass-through allow branch (`not is_write_tool`) neutralizes
# this default for every tool this policy does not inspect, so the default-deny
# bites only on the matched write tools that target a fenced project GID.
default allow := false

# ---------------------------------------------------------------------------
# Fence configuration — PLACEHOLDERS, replace (or empty) at import time.
#
# Asana project sensitivity is a property of the project GID, not the tool.
# HR / legal / M&A / incident projects hold PII and confidential material.
# Each entry pins a sensitive project (or section) GID to the IdP group allowed
# to write to it. The list ships with placeholder GIDs mapped to placeholder
# groups; pin your tenant's real GIDs (and group names), or empty the list, at
# import time. A project whose GID is not on this list is NOT fenced. Group
# names are compared case-insensitively against the caller's `groups` claim.
protected_projects := [
	{"gid": "1201111111111", "group": "hr"}, # e.g. HR / recruiting project
	{"gid": "1202222222222", "group": "legal"}, # e.g. Legal / contracts project
	{"gid": "1203333333333", "group": "ma"}, # e.g. M&A / corp-dev project
	{"gid": "1204444444444", "group": "incident"}, # e.g. Security-incident project
]

# ---------------------------------------------------------------------------
# Identity — groups are read via object.get chains so a missing subject / claims
# / groups fails closed (no group -> no write to a fenced project). The is_array
# guard is load-bearing: a non-array `groups` (string, object, number) must fail
# closed rather than let `some g in groups` iterate an unexpected shape.
caller_has_group(group) if {
	claims := object.get(input.subject, "claims", {})
	groups := object.get(claims, "groups", [])
	is_array(groups)
	some g in groups
	is_string(g)
	lower(g) == lower(group)
}

# ---------------------------------------------------------------------------
# Tool matching (suffix-based, case-insensitive, for portability across gateway
# server-name prefixes). Read the name from BOTH the PARC field and the legacy
# alias; a missing OR non-string value resolves to "" (never leaves the match
# undefined — a fail-OPEN bypass). trim_space strips padding so a trailing space
# or newline cannot slip past the suffix check. The two fields are matched
# independently so a malformed value in one cannot suppress a real suffix in the
# other.
name_of(key) := trim_space(lower(v)) if {
	v := object.get(object.get(input, key, {}), "name", "")
	is_string(v)
}

name_of(key) := "" if {
	v := object.get(object.get(input, key, {}), "name", "")
	not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# A name matches a suffix when it equals it exactly, or ends with the suffix
# preceded by a `-` or `_` separator (tolerates any gateway server-name prefix).
matches_name(name, suffix) if { name == suffix }

matches_name(name, suffix) if { endswith(name, sprintf("-%s", [suffix])) }

matches_name(name, suffix) if { endswith(name, sprintf("_%s", [suffix])) }

tool_matches(suffix) if { matches_name(resource_name, suffix) }

tool_matches(suffix) if { matches_name(payload_name, suffix) }

# Write tools that can push content into — or grant visibility on — a project.
# Official plural batch verbs and community `asana_`-prefixed singular verbs are
# matched by distinct suffixes. Comment writes appear under two suffixes
# (`add_comment` official, `asana_create_task_story` community).
write_suffixes := [
	"create_tasks", # official V2 batch create (up to 50 objects)
	"update_tasks", # official V2 batch update (up to 50 objects)
	"add_comment", # official comment
	"create_project_status_update", # official status update
	"asana_create_task", # community singular create
	"asana_update_task", # community singular update
	"asana_create_task_story", # community comment
	"asana_add_task_to_section", # community add-to-section (section_id)
	"asana_add_followers_to_task", # community follower add (grants visibility)
	"asana_create_project_status", # community status update (twin of create_project_status_update)
	"asana_add_project_to_task", # community add-task-to-project (grants project membership by project GID)
]

is_write_tool if {
	some s in write_suffixes
	tool_matches(s)
}

# ---------------------------------------------------------------------------
# GID extraction — object.get everywhere; GIDs may arrive as numbers or strings,
# so normalize both to a trimmed string. Missing / non-scalar values are skipped.
args := object.get(object.get(input, "payload", {}), "args", {})

# Scalar GID-bearing argument keys, and the candidate batch-array keys for the
# official create_tasks / update_tasks tools (array key is UNVERIFIED — see the
# batch policy). These are documented field lists, not verified schema keys.
scalar_gid_keys := ["project", "section", "project_id", "section_id", "parent"]

batch_keys := ["tasks", "data", "items"]

to_gid(x) := trim_space(x) if is_string(x)

to_gid(x) := sprintf("%v", [x]) if is_number(x)

# Top-level scalar GID fields (community singular tools, add_comment,
# create_project_status_update, asana_add_task_to_section, and any create/update
# call that carries the field flat).
requested_gids contains id if {
	is_write_tool
	some key in scalar_gid_keys
	id := to_gid(object.get(args, key, null))
	id != ""
}

# Top-level projects[] array.
requested_gids contains id if {
	is_write_tool
	some raw in object.get(args, "projects", [])
	id := to_gid(raw)
	id != ""
}

# Batch-array elements (official create_tasks / update_tasks, up to 50 objects):
# each element's scalar GID fields.
requested_gids contains id if {
	is_write_tool
	some bkey in batch_keys
	arr := object.get(args, bkey, null)
	is_array(arr)
	some el in arr
	is_object(el)
	some key in scalar_gid_keys
	id := to_gid(object.get(el, key, null))
	id != ""
}

# Batch-array elements' projects[] arrays.
requested_gids contains id if {
	is_write_tool
	some bkey in batch_keys
	arr := object.get(args, bkey, null)
	is_array(arr)
	some el in arr
	is_object(el)
	some raw in object.get(el, "projects", [])
	id := to_gid(raw)
	id != ""
}

# ---------------------------------------------------------------------------
# Fence check — a requested GID is fenced and the caller lacks the mapped group.
blocked contains entry if {
	is_write_tool
	some entry in protected_projects
	requested_gids[entry.gid]
	not caller_has_group(entry.group)
}

# ---------------------------------------------------------------------------
# Allow rules.
# Any tool this policy does not inspect passes through untouched.
allow if {
	not is_write_tool
}

# An inspected write passes when no fenced GID is targeted away from the caller
# (includes writes to non-fenced projects and writes that name no GID at all).
allow if {
	is_write_tool
	count(blocked) == 0
}

# ---------------------------------------------------------------------------
# Deny reasons — one per fenced GID the caller may not write to.
reasons contains msg if {
	some entry in blocked
	msg := sprintf("Asana project %s is fenced as sensitive and requires the '%s' IdP group to write to it; this call targets it directly. Route the write through a member of the '%s' group, or contact InfoSec if this fence looks wrong.", [entry.gid, entry.group, entry.group])
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
