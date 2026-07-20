---
name: "Databricks: Role-Gate Compute & Job Control"
tags:
  - databricks
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # databricks / role-gate-compute-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny the compute/job-control tools unless the caller is in the platform group; allow everything else (including read-only inventory tools)
  **Package:** `databricks.ingress.role_gate_compute_ops`

  ## What it does

  The community `JustTryAI/databricks-mcp-server` exposes cluster and job control — `create_cluster`,
  `start_cluster`, `terminate_cluster`, `run_job`, and `export_notebook` — under a single Databricks
  PAT (`DATABRICKS_TOKEN`) that bypasses per-user Unity Catalog identity entirely: the token's
  privileges, not the calling user's, gate everything upstream. This policy re-imposes least privilege
  at the gateway by denying those five tools (matched by suffix) for any caller whose IdP `groups`
  claim does **not** include the placeholder group `platform-engineering`.

  Each gated tool is a distinct risk: `terminate_cluster` kills shared compute (availability impact),
  `run_job` fires pipelines with external side effects, `create_cluster` spends money, and
  `export_notebook` exfiltrates source code that frequently embeds credentials. Analyst and Cowork
  users have no business driving compute over the agent channel, so this enforces least privilege on
  that surface.

  Read-only inventory tools — `list_clusters`, `get_cluster`, `list_jobs`, `list_notebooks`,
  `list_files` — are unaffected and continue to pass through for everyone, as does any other tool that
  is not one of the five gated compute/job verbs.

  The check runs at ingress, before the call reaches the Databricks MCP server, so a denied compute
  action never executes and has no side effects (no cluster spun up, no job fired, no notebook
  exported).

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: shared Databricks
    compute and job pipelines cannot be driven over the agent channel without an explicit role grant.
    **CC6.3** — supports role-based access and least privilege (and the initiate/approve separation
    of duties behind it): compute/job-control capability is tied to a live IdP group, and removing the
    group in the IdP removes the capability on the next call.
  - **SOX ITGC (access to programs and data)** — supports least-privilege access to the compute and
    job-orchestration plane where Databricks runs financially relevant pipelines: starting, creating,
    or terminating clusters and firing jobs requires membership in a controlled group, and the
    initiate-vs-approve separation of duties (COSO Principle 10) it backs is enforced on the MCP path.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `databricks-terminate_cluster`), and the prefix is not standardized — so matching is
  case-insensitive (`lower(...)`) and by **suffix** (`endswith`) to stay portable across server names.
  The five gated suffixes are the verified `JustTryAI` write/destructive tool names:

  - `create_cluster`, `start_cluster`, `terminate_cluster` (compute control)
  - `run_job` (job control)
  - `export_notebook` (source-code exfiltration)

  Suffix matching is deliberately conservative: the read-only inventory tools do **not** match any
  gated suffix — `list_clusters` / `get_cluster` do not end in `create_cluster` / `start_cluster` /
  `terminate_cluster`, `list_jobs` does not end in `run_job` (plural), and `list_notebooks` does not
  end in `export_notebook`. A hypothetical `restart_cluster` *would* match `start_cluster` and be
  gated too — an intentional, safe over-match (a restart is still a compute-control action).

  Verify the exact names your gateway sends with the dump-input debug technique before relying on this
  in production; if your Databricks server exposes an additional compute/job-control tool, add its
  suffix to `compute_op_suffixes` in `policy.md`.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`) and the caller's identity
  (`input.subject.claims.groups`). Tool arguments are not inspected, so the policy cannot be bypassed
  by unusual argument keys, nesting, or encodings — and it works identically whether or not a tool's
  argument schema is documented.

  ## Identity

  Group membership is read fail-closed via
  `object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])`: a missing
  subject, missing claims, a missing `groups` claim, or a `groups` claim that is not an array all mean
  "not in the platform group", and every gated compute call is denied. Reads (and all non-gated tools)
  are unaffected by identity. The `is_array` guard is load-bearing — `some group in caller_groups`
  iterates the *values* of an object, so a `groups` claim shaped as `{"role": "platform-engineering"}`
  would otherwise match and fail **open**; requiring an array keeps every non-array shape (object,
  string, number) fail-closed.

  ## Examples

  ### Allowed — read-only inventory tool, no identity required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-list_clusters", "type": "tool" },
      "payload": { "name": "databricks-list_clusters", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — compute tool by a platform engineer

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-terminate_cluster", "type": "tool" },
      "subject": { "sub": "auth0|alice", "claims": { "groups": ["platform-engineering"] } },
      "payload": { "name": "databricks-terminate_cluster", "args": { "cluster_id": "0921-abc" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — compute tool, caller not in the platform group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-run_job", "type": "tool" },
      "subject": { "sub": "auth0|analyst", "claims": { "groups": ["analyst"] } },
      "payload": { "name": "databricks-run_job", "args": { "job_id": 42 } }
    }
  }
  ```

  `allow = false`, `reason = "Databricks compute and job-control tools ... are restricted to members of the 'platform-engineering' group ..."`.

  ## Composition

  This policy gates *who* may drive Databricks compute; it does not inspect *what* the job or cluster
  does. Useful companions:

  - [`apps/databricks/guard-warehouse-sql`](../guard-warehouse-sql/policy.md) — denies DML/DDL/GRANT
    and export constructs in SQL arguments to the `execute_sql*` tools, a separate surface this policy
    does not touch.
  - [`apps/databricks/default-deny-unknown-tools`](../default-deny-unknown-tools/policy.md) — allowlists
    audited tool names so a *renamed* or *new* upstream compute tool that this policy's suffix list
    does not yet cover fails closed instead of slipping through.
  - An egress PII/PHI redaction policy on the read path
    ([`apps/databricks/redact-pii-egress`](../redact-pii-egress/policy.md)), since this policy leaves
    the inventory/read tools open to everyone.

  ## Known limitations

  - **Group names are placeholders** — replace `platform-engineering` with your IdP's group name at
    import time. The policy expects `groups` to be an array claim in the caller's JWT; if your IdP
    emits roles under a different or namespaced claim (e.g. `https://acme.com/groups`), update
    `caller_groups` in `policy.md`.
  - **PAT bypass is upstream, not fixed here.** The underlying risk — the `JustTryAI` server acting
    under a shared PAT that bypasses per-user Unity Catalog identity — is not removed by this policy;
    it is *fenced* at the gateway. Any path to that PAT that does not traverse the gateway (a local
    stdio client, a direct API call) is out of scope by design.
  - **Suffix list is scoped to the verified `JustTryAI` names.** Other Databricks MCP servers name
    their compute/job tools differently (or, like the managed servers, do not expose cluster/job
    control at all). A compute tool whose name ends in none of the five gated suffixes slips through
    as "not a compute op" — pair with `default-deny-unknown-tools` if your deployment is
    allowlist-first, and add any additional verified suffixes to `compute_op_suffixes`. Concretely,
    the maximalist `pramodbhatofficial/databricks-mcp-server` (~263 SDK-generated tools) names its
    verbs noun-first — e.g. `clusters_create`, `clusters_delete`, `jobs_run_now` — and **none** of
    those end in a gated suffix, so this policy allows them for everyone (`clusters_create` does not
    end in `create_cluster`, `jobs_run_now` does not end in `run_job`). This fail-open residual is
    codified in `tests.yaml` (the `clusters_create` / `jobs_run_now` cases). On any server that does
    not use the `JustTryAI` verb-first names, this policy must be paired with
    `default-deny-unknown-tools` (allowlist-first) or have its `compute_op_suffixes` extended with the
    verified names your gateway actually emits — do not rely on suffix matching alone.
  - **A server named with a gated verb** (e.g. an MCP server configured as `run_job-runner`) could
    make unrelated tools match a suffix and require the platform group — a fail-closed false positive;
    rename the server or narrow the suffix.
  - **Reads are open to everyone**, including `export`-adjacent inventory (`list_notebooks`) and
    content-returning reads. This policy only gates the five write/destructive verbs; add a read fence
    or egress redaction if your Databricks workspace holds regulated content.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP
  > path only**. No policy or bundle makes an organization compliant with any framework; web-UI,
  > native-API, and in-app access are outside the gateway's reach by design. Validate against your own
  > compliance program before relying on it.
direction: ingress
apps:
  - databricks
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package databricks.ingress.role_gate_compute_ops

# Deny-by-default: the compute/job-control tools require the platform group;
# every other tool (including read-only inventory tools) is explicitly allowed
# by the `not is_compute_op` branch below.
default allow := false

# Placeholder IdP group permitted to drive Databricks compute and job control.
# Replace "platform-engineering" with your IdP's group name at import time.
compute_group := "platform-engineering"

# Lowercased tool name. The gateway prefixes tool names with the configured MCP
# server name (e.g. `databricks-terminate_cluster`), so matching below is
# case-insensitive and suffix based to stay portable across server names.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim
# that is not an array all yield "not in the platform group" — gated compute
# calls then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# The `is_array` guard is load-bearing: `some group in caller_groups` iterates
# the *values* of an object, so a groups claim shaped as
# `{"role": "platform-engineering"}` would otherwise match and fail OPEN.
# Requiring an array keeps every non-array shape (object, string, number)
# fail-closed, as the Identity section promises.
caller_is_platform_eng if {
    is_array(caller_groups)
    some group in caller_groups
    group == compute_group
}

# --- Compute / job-control tools (the deny surface) ---
# Verified `JustTryAI/databricks-mcp-server` write/destructive tool names,
# matched by suffix so any gateway server-name prefix still matches:
#   terminate_cluster -> kills shared compute (availability impact)
#   run_job           -> fires pipelines with external side effects
#   create_cluster    -> spends money
#   start_cluster     -> brings compute online
#   export_notebook   -> exfiltrates source that often embeds credentials
compute_op_suffixes := [
    "create_cluster",
    "start_cluster",
    "terminate_cluster",
    "run_job",
    "export_notebook",
]

is_compute_op if {
    some suffix in compute_op_suffixes
    endswith(tool_name, suffix)
}

# --- Decision ---

# Reads and anything that is not one of the five gated compute/job verbs pass
# for everyone.
allow if {
    not is_compute_op
}

# Gated compute/job tools pass only for members of the platform group.
allow if {
    is_compute_op
    caller_is_platform_eng
}

reasons contains msg if {
    is_compute_op
    not caller_is_platform_eng
    msg := sprintf("Databricks compute and job-control tools (create/start/terminate cluster, run job, export notebook) are restricted to members of the '%s' group — this account has read-only Databricks access through the gateway. Inventory tools (list_clusters, get_cluster, list_jobs, list_notebooks, list_files) still work. Ask your identity admin to add you to '%s', or hand this step to a platform engineer. If this tool is actually read-only, contact your InfoSec team to update the policy.", [compute_group, compute_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
