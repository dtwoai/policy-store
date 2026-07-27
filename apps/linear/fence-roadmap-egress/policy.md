---
name: Fence Roadmap and Initiative Reads (Egress)
tags:
  - linear
  - fence-sensitive-scopes
  - roadmap
  - egress
  - soc2
publishedAt: 2026-07-12
description: |
  # linear / fence-roadmap-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** deny (withhold the response) on a guarded read by an un-privileged caller; allow otherwise
  **Package:** `linear.egress.fence_roadmap`

  ## What it does

  Fences the **responses** of Linear's roadmap, initiative, and strategy **read** tools. When one of these tools returns and the caller is **not** in the `product` or `exec` IdP group, the entire response is withheld (denied) before it reaches the agent. Every other tool response — and the same reads for a privileged caller — passes through unchanged.

  The guarded reads return unreleased product plans, launch timing, initiative/project narratives, and draft documents. That content is the exact material pre-announcement-leak and MNPI (material non-public information) controls care about, so exposure is gated on IdP-group membership:

  - `linear_getRoadmaps`
  - `linear_getInitiatives`
  - `linear_getInitiativeUpdates`
  - initiative / project-update reads (e.g. `linear_getProjectUpdates`, and the Feb-2026 official equivalents)
  - `linear_getMilestones` — project-milestone reads carry launch/target dates (launch timing)
  - `linear_getDocuments` (PRDs/specs), `linear_searchDocuments` (same document content, reached by search), and Linear's document reads (`get_document` / `list_documents`)
  - `linear_getDocumentContentHistory` — leaks *edited-out* draft content, so it is guarded even though its current text may look benign

  ## Why egress and not ingress

  The sensitivity lives in the **returned** unreleased-plan content, not in the request arguments — a call to `linear_getRoadmaps` looks identical whether the workspace has one benign roadmap or a quarter of unannounced launches. There is nothing in the request to key an ingress rule on beyond the tool name, and blocking at ingress would also be correct but coarser. This policy blocks at egress so it sits on the actual data path and composes cleanly with an ingress role-gate (defense in depth). Because the whole response is unreleased-plan content, the protective action is to withhold the **entire** response rather than field-redact it — a partially redacted roadmap is still a roadmap.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identifying and protecting confidential information by keeping unreleased roadmap/initiative content off the agent channel for callers outside the entitled groups (PF-23 sensitive-scope fencing).
  - **SOC 2 CC6.7 / P6.1** — supports restricting the transmission and disclosure of confidential and personal information to the agent by withholding roadmap/initiative/strategy responses from callers outside `product`/`exec` (coverage-matrix §2.1).

  All alignment is on the MCP path only (see the compliance note below).

  ## Tool name matching

  Linear has **three naming schemes** for the same actions — official bare snake_case (`get_roadmaps`), tacticlaunch `linear_` + camelCase (`linear_getRoadmaps`), and community fully-snake (`linear_get_roadmaps`) — and the gateway further prefixes every tool with the configured MCP server name. The policy therefore:

  1. collects the tool name from all three egress surfaces that carry it — `input.resource.name` (PARC), `input.tool_metadata.name` (legacy), and `input.payload.name` (tool-hook canonical) — lowercased, so a gateway that populates a different surface can't slip a guarded read past the fence (this is a deny policy, so an unrecognized name would otherwise fail **open**),
  2. strips `_` from each so one suffix matches all three spellings, then
  3. matches by **suffix** (`endswith`): a response is guarded if **any** surface ends in one of these normalized read-tool suffixes:

  `getroadmaps`, `getroadmap`, `listroadmaps`, `getinitiatives`, `getinitiative`, `listinitiatives`, `getinitiativeupdates`, `getinitiativeupdate`, `listinitiativeupdates`, `getprojectupdates`, `getprojectupdate`, `listprojectupdates`, `getmilestones`, `getmilestone`, `listmilestones`, `getdocuments`, `getdocument`, `listdocuments`, `searchdocuments`, `getdocumentcontenthistory`.

  Additionally, tacticlaunch exposes by-id reads as `get<Noun>ById` (verified pattern: `linear_getIssueById`). Each surface name is therefore also matched with a trailing `byid` trimmed, so `getRoadmapById` / `getInitiativeById` / `getDocumentById` / `getMilestoneById` resolve to the same singular `get<noun>` suffix and are fenced. `getProjectById` stays unfenced because it trims to `getproject`, which is not a guarded suffix (consistent with the intentional non-fence of the general project read).

  Suffixes are read-verb-anchored (`get`/`list`) forms in both singular by-id and plural collection spellings, so write/create/update tools (`createInitiativeUpdate`, `updateProject`) are not matched. The singular `get<noun>` forms are guarded because Linear's official server names its by-id reads that way (`get_issue`, `get_project`, `get_document`), so the by-id read of a single unannounced initiative/roadmap/milestone/update (`get_initiative`, `get_roadmap`, …) is fenced exactly like the collection read. Both `get` and `list` variants are included to cover the official reads whose exact names are unverified. Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  This policy reads **no tool arguments** — the decision is (guarded tool) × (caller group) only. Identity groups are read via `object.get(input.subject, "claims", {})` → `groups`, defaulting to `[]`: a missing `subject`, missing `claims`, or missing `groups` yields no group, so the caller is treated as un-privileged and the response is withheld (fail closed — redaction/denial rather than exposure).

  ## Examples

  ### Allowed — caller is in the `product` group

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "linear-mcp-linear_getRoadmaps", "type": "tool" },
      "payload": {
        "name": "linear-mcp-linear_getRoadmaps",
        "text": ["[{\"id\":\"road_1\",\"name\":\"H2 launches\"}]"]
      },
      "subject": { "claims": { "groups": ["product"] } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — initiative read by a caller outside `product`/`exec`

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "linear-mcp-linear_getInitiatives", "type": "tool" },
      "payload": {
        "name": "linear-mcp-linear_getInitiatives",
        "text": ["[{\"id\":\"init_1\",\"name\":\"Project Titan (unannounced)\"}]"]
      },
      "subject": { "claims": { "groups": ["marketing"] } }
    }
  }
  ```

  `allow = false`, roadmap/initiative reason. A response to `linear_getIssues` or `linear_getProjects` from the same caller passes through — only roadmap/initiative/strategy reads are fenced.

  ## Composition

  This policy is single-purpose (an egress content fence). Useful companions on the Linear connector:

  - An **ingress role-gate** that stops out-of-group callers from *invoking* the roadmap/initiative reads at all (this egress fence is the backstop if the ingress gate is absent or a new read tool slips through).
  - A **`default-deny-unknown-tools`** allowlist so a newly added/renamed roadmap read is denied until reviewed rather than leaking before this suffix list is updated.
  - A **customer-data redaction** egress policy on `*getCustomers` / `*getCustomerNeeds` / `*getCustomerTiers`.

  ## Known limitations

  - **Group names are placeholders — replace `product` and `exec` with your IdP's group names at import time.** They are matched exactly against `input.subject.claims.groups`; a case or spelling mismatch withholds the response (fail closed).
  - **Placeholder-claim trust.** The gate trusts `input.subject.claims.groups` as asserted by the IdP-issued JWT. If your IdP does not emit a `groups` claim (Auth0, for example, does not without explicit configuration), every caller is treated as un-privileged and every guarded response is withheld until the claim is wired up. Confirm the claim shape with `dtwo-list-claims` / the dump-input technique before deployment. A non-array `groups` value (e.g. a bare string) is not iterated and also fails closed.
  - **Unverified official tool names.** The Feb-2026 official initiative / project-update read tool names are **unverified** in the landscape note — confirm them via a live `tools/list` and extend `guarded_suffixes` if they differ. Both `get`/`list` prefixes, both singular by-id (`get_initiative`) and plural collection (`get_initiatives`/`list_initiatives`) spellings, and the tacticlaunch `get<Noun>ById` by-id form (via a trailing-`byid` trim) are matched, but a *differently-worded* read (e.g. an official `roadmap_details`- or `fetch_initiative`-style name that doesn't end in a guarded `get<noun>`/`list<noun>` suffix, or a `search`-over-plans read like a hypothetical `searchInitiatives`) would slip through until its suffix is added. Re-enumerate after any Linear MCP upgrade.
  - **Sibling read surfaces are out of scope.** This policy fences the roadmap/initiative/strategy/document read tools by name; it does **not** inspect responses of other reads that can *incidentally* surface the same content. In particular Linear comments attach to initiatives, projects, updates, and documents (`linear_getComments`/`list_comments`), and issue reads (`get_issue`) can quote roadmap context — those responses are **not** fenced and pass through for out-of-group callers. Add a companion egress policy on the comment/issue read surface (and the customer-data reads) if that leakage path matters in your tenant.
  - **Search reaches the same content, so `searchDocuments` is fenced too.** tacticlaunch's `linear_searchDocuments` returns document bodies by another path, so its suffix (`searchdocuments`) is in `guarded_suffixes` and is withheld for out-of-group callers exactly like `getDocuments`. There is no matching document-*search* tool on the official server in the verified baseline; if your tenant exposes a differently-named search-over-plans read, add its suffix. By contrast `getProjects` (a general project list) is intentionally *not* fenced — only roadmap/initiative/strategy and project/initiative *update* reads, plus document reads, are.
  - **Whole-response denial, not field redaction.** Because the sensitivity is the entire returned plan, a guarded response is withheld in full; this policy does not attempt to return a partial/redacted roadmap. If you need field-level redaction instead, replace the deny with a `transform` on the same tools.
  - **Egress only.** This blocks the response; it does not stop the underlying read from executing against Linear (a read has no side effects, so this is acceptable). Pair with an ingress gate if you also want to avoid the upstream call.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - linear
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package linear.egress.fence_roadmap

# Deny-by-default: an egress response is withheld unless an allow rule fires.
# For a guarded roadmap/initiative/strategy read this means the response is
# blocked (denied) unless the caller is in a privileged group.
default allow := false

# Placeholder IdP group names — map these to your tenant's IdP groups at import.
privileged_groups := {"product", "exec"}

# --- Tool identification -------------------------------------------------

# The tool name is exposed on egress under three surfaces that carry the same
# value: resource.name (PARC), tool_metadata.name (legacy), and payload.name
# (tool-hook canonical). We collect all three because this is a DENY policy: if
# a guarded read's name only appeared on a surface we didn't inspect, the tool
# would go unrecognized and the response would fail OPEN (leak). Each name is
# lowercased and has its underscores stripped, so one suffix matches all three
# Linear naming schemes — official snake_case (get_roadmaps / list_documents),
# tacticlaunch camelCase (linear_getRoadmaps), and fully-snake community forms.
# The gateway server-name prefix separator (hyphen) is left intact; the guarded
# suffixes contain no hyphens. object.get chains keep a missing surface from
# failing the rule.
candidate_names contains replace(lower(object.get(object.get(input, "resource", {}), "name", "")), "_", "")

candidate_names contains replace(lower(object.get(object.get(input, "tool_metadata", {}), "name", "")), "_", "")

candidate_names contains replace(lower(object.get(object.get(input, "payload", {}), "name", "")), "_", "")

# tacticlaunch also exposes by-id reads as get<Noun>ById (verified pattern:
# linear_getIssueById). A by-id read of a guarded noun — getRoadmapById /
# getInitiativeById / getDocumentById / getMilestoneById — would otherwise end in
# "byid" and match none of the get<noun> suffixes, failing OPEN (leaking a single
# unannounced initiative/roadmap/milestone/document). We therefore also add a
# copy of each surface name with a trailing "byid" trimmed, so get<GuardedNoun>ById
# resolves to the same singular get<noun> suffix. get_project stays unfenced
# because getprojectbyid trims to getproject, which is not a guarded suffix.
candidate_names contains trim_suffix(replace(lower(object.get(object.get(input, "resource", {}), "name", "")), "_", ""), "byid")

candidate_names contains trim_suffix(replace(lower(object.get(object.get(input, "tool_metadata", {}), "name", "")), "_", ""), "byid")

candidate_names contains trim_suffix(replace(lower(object.get(object.get(input, "payload", {}), "name", "")), "_", ""), "byid")

# Normalized suffixes of the roadmap/initiative/strategy READ tools whose
# responses carry unreleased-plan content. Read verbs (get/list) with both
# singular by-id and plural collection nouns (Linear's official server names
# by-id reads get_<noun> singular — get_issue/get_project/get_document — so the
# singular get forms are guarded alongside the plural). Write verbs are on
# create/update, so createInitiativeUpdate / updateProject are not matched (they
# end in ...ateinitiativeupdate / ...ateproject, never get<noun>). Both get- and
# list- forms are included to cover the unverified Feb-2026 official read names.
guarded_suffixes := {
    "getroadmaps",
    "getroadmap",
    "listroadmaps",
    "getinitiatives",
    "getinitiative",
    "listinitiatives",
    "getinitiativeupdates",
    "getinitiativeupdate",
    "listinitiativeupdates",
    "getprojectupdates",
    "getprojectupdate",
    "listprojectupdates",
    "getmilestones",
    "getmilestone",
    "listmilestones",
    "getdocuments",
    "getdocument",
    "listdocuments",
    "searchdocuments",
    "getdocumentcontenthistory",
}

is_guarded_tool if {
    some suffix in guarded_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# --- Identity ------------------------------------------------------------

# Caller's IdP groups; a missing subject/claims/groups yields [] so a caller
# with no usable claim is treated as un-privileged (fail closed → response
# withheld rather than exposed).
caller_groups := groups if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
}

# The caller is in one of the privileged groups.
caller_in_privileged_group if {
    some g in caller_groups
    privileged_groups[g]
}

# --- Allow rules ---------------------------------------------------------

# Any response that isn't a guarded roadmap/initiative/strategy read passes.
allow if not is_guarded_tool

# Guarded reads pass only for callers in a privileged group.
allow if {
    is_guarded_tool
    caller_in_privileged_group
}

# --- Deny reason ---------------------------------------------------------

reasons contains "This Linear response contains roadmap, initiative, or strategy content (unreleased plans and launch timing that may be material non-public information). It is restricted to the product and exec groups (placeholder IdP group names \"product\" and \"exec\"). Ask your administrator to grant you the appropriate group if you need pre-announcement access, and confirm your IdP is emitting the `groups` claim. If you believe you already have this access, ask your admin to verify your IdP group mapping." if {
    is_guarded_tool
    not caller_in_privileged_group
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
