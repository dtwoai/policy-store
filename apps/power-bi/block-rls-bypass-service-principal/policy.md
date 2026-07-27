---
name: Block Power BI RLS-Bypass Service-Principal Queries
tags:
  - power-bi
  - role-gate-writes
  - rls
  - service-principal
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # power-bi / block-rls-bypass-service-principal

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny the targeted read/query tools under service-principal or unconfirmed identity; allow otherwise
  **Package:** `power_bi.ingress.block_rls_bypass_service_principal`

  ## What it does

  On Microsoft's remote Power BI MCP server (`https://api.fabric.microsoft.com/v1/mcp/powerbi`), row-level security (RLS) is enforced for interactive Microsoft Entra **user** sessions but is **not** enforced under **Service Principal** authentication. An SP-authenticated agent therefore reads every RLS role's data across the semantic model — a shared-credential deployment (one service principal serving many users) silently widens every user's data scope to the principal's full access.

  This ingress policy denies the read/query tools whenever the session identity indicates a service principal rather than a named user:

  - `ExecuteQuery` — runs arbitrary DAX against a semantic model (remote server)
  - `ValueSearch` — searches actual data values in a model (remote server)
  - `execute_dax` / `desktop_execute_dax` — community server DAX execution
  - `dax_query_operations` — modeling server DAX query surface

  The identity check reads an Entra token-type claim via `object.get(input.subject, "claims", {})`. It treats `idtyp == "app"` — or an app/`oid` identity carrying no user `upn`/`email` claim — as a service principal, and **fails closed (deny)** when identity is absent or ambiguous, including when `subject`/`claims` arrive as a non-object (string/number/array) or the tool name is carried only on `payload.name`. On the **remote official** server, named-user sessions pass through unchanged so the service enforces RLS filters; see the Known-limitations caveat on the community/modeling servers, which authenticate upstream under their own service principal. Every non-query tool passes through unchanged (this policy governs only the RLS-sensitive read surfaces above; pair it with the RLS-tampering and modeling-write policies for the rest).

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets by preventing a service identity from reading past the RLS boundary that scopes each user to their own rows; **CC6.3** — supports role-based least privilege by keeping the agent's data scope tied to a named user's RLS role rather than the principal's full model access.
  - **GDPR Art. 25** — supports data protection by default: the RLS-widening path is closed unless a named user is positively identified; **Art. 29** — supports processing only on the controller's instructions by refusing agent reads that cannot be attributed to an instructed named user.

  ## Why ingress and not egress

  RLS scoping must be decided before the query runs. Under a service principal the model returns every role's rows, so egress redaction would have to reconstruct per-user RLS filters after the fact — the gateway has no way to know which rows a given user should have seen. Denying the call at ingress is the only point where the RLS boundary can be preserved.

  ## Tool name matching

  Tools are matched case-insensitively on `lower(input.resource.name)` by **suffix**, because the DTwo gateway prefixes tool names with the configured MCP server name and that prefix is not standardized:

  - `endswith(name, "executequery")` — remote `ExecuteQuery`
  - `endswith(name, "valuesearch")` — remote `ValueSearch`
  - `endswith(name, "execute_dax")` — community `execute_dax` **and** `desktop_execute_dax`
  - `endswith(name, "dax_query_operations")` — modeling `dax_query_operations`

  Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production. If your query tool exposes a different name, add its suffix to `is_query_tool` in `policy.md`.

  ## Argument shape

  This policy makes **no** assumptions about argument keys — the decision is driven entirely by the tool name and the session identity claims, not by the DAX text or model IDs. It composes with the whole-table-dump guard and model-ID fencing policies, which do inspect arguments.

  ## Identity claims

  Identity is read from `object.get(input.subject, "claims", {})`:

  - `idtyp` — Entra token-type claim. `"app"` denotes an application (client-credentials / service-principal) token; `"user"` denotes a delegated user token.
  - `upn` / `email` — a named user's principal name or email. Presence of either (with `idtyp` not `"app"`) is treated as a named-user signal when `idtyp` is not carried. To count as a positive signal the value must be a **string containing `@`** — both fields are `@`-bearing — so whitespace-only or non-string junk values (`" "`, `0`, `false`) do **not** spoof a named user.

  `idtyp` is normalized to a lowercase string; a non-string `idtyp` (a type-confusion attempt) degrades to `""` so the service-principal test stays defined and fails closed rather than collapsing to a fail-open allow.

  A caller is treated as a **named user** (allowed) only when it is not an app token **and** carries a positive user signal (`idtyp == "user"`, or a `upn`/`email` string containing `@`). Everything else — an explicit `app` token, or an identity with no valid user principal at all — is treated as a service principal or ambiguous identity and denied.

  ## Examples

  ### Allowed — named user runs a query (RLS applies)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-mcp-ExecuteQuery", "type": "tool" },
      "subject": { "claims": { "idtyp": "user", "upn": "alice@corp.com" } },
      "payload": {
        "name": "powerbi-mcp-ExecuteQuery",
        "args": { "modelId": "…", "query": "EVALUATE TOPN(10, 'Sales')" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — a non-query tool passes through

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-mcp-GetSemanticModelSchema", "type": "tool" },
      "subject": { "claims": { "idtyp": "app" } },
      "payload": { "name": "powerbi-mcp-GetSemanticModelSchema", "args": {} }
    }
  }
  ```

  `allow = true` — this policy only governs the RLS-sensitive read/query surfaces.

  ### Denied — service-principal (app) token

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-mcp-ExecuteQuery", "type": "tool" },
      "subject": { "claims": { "idtyp": "app", "oid": "…", "appid": "…" } },
      "payload": { "name": "powerbi-mcp-ExecuteQuery", "args": { "query": "EVALUATE 'Customers'" } }
    }
  }
  ```

  `allow = false`, reason names the RLS-bypass risk and tells the caller to re-run under an interactive user identity.

  ### Denied — ambiguous / absent identity (fail closed)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "community-desktop_execute_dax", "type": "tool" },
      "subject": { "claims": {} },
      "payload": { "name": "community-desktop_execute_dax", "args": { "dax_query": "EVALUATE 'Sales'" } }
    }
  }
  ```

  `allow = false` — with no user token-type or `upn`/`email` claim, the policy cannot confirm a named user and denies rather than risk a silent RLS bypass.

  ## Composition

  Single-purpose. Curated companions on the Power BI surface:

  - **Deny RLS tampering** (`security_role_operations` and community RLS role tools) — stops the filter *definitions* from being rewritten.
  - **Whole-table dump guard** — denies bare `EVALUATE 'Table'` DAX on the same query tools regardless of identity.
  - **Model-ID fencing** — restricts which semantic models a caller may touch.
  - **Egress PII redaction** on query results — a backstop for models without column masking.

  ## Known limitations

  - **Claim key is a placeholder to confirm at import time.** The exact wire name of the token-type / service-principal claim as forwarded by the gateway is **unverified**. This policy reads it as `idtyp` (the Entra optional-claim name); if your gateway forwards it under a different key, update `idtyp`/`upn`/`email` in `is_service_principal` / `has_user_principal` in `policy.md`. Because the policy fails closed, a mis-named claim degrades to denying named users (safe but noisy), not to allowing service principals.
  - **RLS restoration for named users holds only on the remote official server.** The premise "named user ⇒ RLS applies" is true for the hosted `/mcp/powerbi` server, whose queries run as the authenticated Entra user. The **community** server (`execute_dax` / `desktop_execute_dax`) authenticates to Power BI with its **own** service-principal credentials (`CLIENT_ID`/`CLIENT_SECRET`), and the **modeling** server's `dax_query_operations` runs against Power BI Desktop / local PBIP / XMLA endpoints where RLS is not enforced at all. On those servers, allowing a named-user gateway session does **not** restore RLS — the upstream connection is still a service principal (or a Desktop model with no RLS), invisible to the gateway. Treat the identity gate as a full RLS control only for the remote server; on the community/modeling DAX surfaces, pair it with model-ID fencing, the whole-table-dump guard, and egress PII redaction. (A shop that wants a hard stop there should deny those two suffixes unconditionally.)
  - **Adjacent community read tools are out of scope.** This policy gates only the four DAX-execution / value-search suffixes. Other community read tools that also touch model data under the server's service principal — `analyze_query_performance` (executes DAX to profile a query), `desktop_discover`, `cloud_list_tables`/`cloud_list_columns`/`cloud_list_measures`, `scan_measure_dependencies` — and the remote `GenerateQuery` (NL→DAX generation; returns query text, not rows) are **not** matched here. Add their suffixes to `query_suffixes` if you want them under the same identity gate, and rely on model-ID fencing / egress redaction for the metadata-listing tools.
  - **Malformed identity and tool-name fields fail closed.** `subject`, `claims`, `idtyp`, `upn`, and `email` are each hardened against non-object / non-string / whitespace values so a malformed or hostile token shape degrades to deny, not allow. The query-tool test reads **both** `resource.name` and `payload.name`, so a call that carries the tool name on only one of those fields (or a non-string `resource.name`) is still matched. What remains out of reach is a caller who forges a genuine-looking `idtyp: "user"` or `@`-bearing `upn`/`email` claim past the gateway's authenticator — token validation is the authenticator's job, upstream of policy.
  - **`ValueSearch` / `ResolveReportIdFromUrl` presence on `/mcp/powerbi` is unverified.** The landscape note verifies `ValueSearch` on the closely related `fabricaihub` endpoint variant; its presence on `/mcp/powerbi` is landscape-noted as unverified. The suffix match is harmless if the tool is absent.
  - **Modeling-server multiplexers.** `dax_query_operations` is a query surface, but the modeling server's other `*_operations` tools multiplex reads and writes under one name; this policy does not touch them — use the modeling-write and RLS-tampering policies for that surface.
  - **Identity signals only.** The policy trusts the forwarded claims to distinguish user from service-principal sessions; it does not attempt to validate the token itself. Token validation is the gateway's authenticator's job, upstream of policy. The claim *values* are hardened against type-confusion and whitespace/junk spoofing (`idtyp` is string-normalized; `upn`/`email` must be strings containing `@`), but a caller who can forge a genuine-looking `upn`/`email` claim past the authenticator is out of this policy's reach.
  - **No batched-read surface.** None of the Power BI MCP servers in the landscape note expose a batched/composite read tool (the community `batch_*` tools are writes), so there is no batching route to smuggle a query past the per-tool suffix match. Re-verify if a future server version adds one.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - power-bi
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package power_bi.ingress.block_rls_bypass_service_principal

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Session identity claims. A fully-absent subject or claims degrades to {} so
# every lookup below fails closed rather than leaving the rule undefined.
# A NON-OBJECT claims value (string / number / array — a malformed or hostile
# token shape) also degrades to {}: without this guard `object.get(claims, ...)`
# on a non-object returns UNDEFINED, which collapses `is_service_principal` to
# undefined and fails OPEN (allow) on the query tools. Forcing {} keeps every
# lookup defined so the policy fails closed.
# `subject` is guarded to an object first: a non-object subject (e.g. a bare
# string) would make `object.get(subject, "claims", {})` return UNDEFINED, which
# leaves `raw_claims` undefined and — because an undefined rule value poisons the
# `not is_object(raw_claims)` guard below — collapses `claims` to undefined and
# fails OPEN. Forcing a non-object subject to {} keeps the chain defined.
subject := object.get(input, "subject", {})

raw_claims := object.get(subject, "claims", {}) if is_object(subject)

raw_claims := {} if not is_object(subject)

claims := raw_claims if is_object(raw_claims)

claims := {} if not is_object(raw_claims)

# Entra token-type claim, normalized to a lowercase string. NOTE: the exact wire
# name is unverified — see the "Claim key is a placeholder" limitation. "app" ==
# application/service-principal (client-credentials) token; "user" == delegated
# user token. A NON-STRING value (type-confusion attempt) degrades to "" so the
# rules below stay defined and fail closed — without this guard `lower(non_string)`
# is undefined, which collapses `is_service_principal` and fails OPEN.
raw_idtyp := object.get(claims, "idtyp", "")

idtyp := lower(raw_idtyp) if is_string(raw_idtyp)

idtyp := "" if not is_string(raw_idtyp)

# Named-user signals. A positive signal must actually look like a principal: a
# string containing "@" (both upn and email are @-bearing). This rejects
# whitespace-only or non-string values (e.g. " ", 0, false) that would otherwise
# slip past a bare emptiness check and spoof a named user, opening the RLS bypass.
upn := object.get(claims, "upn", "")
email := object.get(claims, "email", "")

has_user_principal if {
    is_string(upn)
    contains(upn, "@")
}

has_user_principal if {
    is_string(email)
    contains(email, "@")
}

# RLS-sensitive read/query tools. Matched case-insensitively by suffix for
# portability across the gateway's server-name prefix. `execute_dax` also
# matches the community `desktop_execute_dax`.
query_suffixes := [
    "executequery", # remote ExecuteQuery
    "valuesearch", # remote ValueSearch (presence on /mcp/powerbi unverified)
    "execute_dax", # community execute_dax + desktop_execute_dax
    "dax_query_operations", # modeling dax_query_operations
]

# Tool name is read from BOTH input.resource.name and input.payload.name. A deny
# policy must not fail open on the tool-identity field: if `input.resource.name`
# is absent or non-string (leaving `lower(input.resource.name)` undefined) but the
# call still identifies a query tool via `payload.name`, matching only
# resource.name would collapse `is_query_tool` and ALLOW the read. Considering
# both string-valued names closes that gap; non-string names are simply ignored.
resource_name := object.get(object.get(input, "resource", {}), "name", "")
payload_name := object.get(object.get(input, "payload", {}), "name", "")

candidate_names contains lower(resource_name) if is_string(resource_name)

candidate_names contains lower(payload_name) if is_string(payload_name)

is_query_tool if {
    some name in candidate_names
    some suffix in query_suffixes
    endswith(name, suffix)
}

# Explicit application/service-principal token.
is_service_principal if {
    idtyp == "app"
}

# App/oid-style identity carrying no valid user principal at all — this also
# captures the absent/ambiguous case (empty claims) and whitespace/non-string
# spoof values, so the policy fails closed.
is_service_principal if {
    idtyp != "user"
    not has_user_principal
}

# Allow anything that is not one of the RLS-sensitive query tools.
allow if {
    not is_query_tool
}

# Allow the query tools only for a positively identified named user (RLS applies).
allow if {
    is_query_tool
    not is_service_principal
}

# Deny reason: explicit service-principal (app) token.
reasons contains "Power BI does not enforce row-level security (RLS) under service-principal authentication, so this read/query would return every RLS role's data. Run Power BI query tools (ExecuteQuery, ValueSearch, execute_dax, dax_query_operations) under an interactive Entra user identity instead of an app/service-principal token. Ask your data-governance team for an exception if this service principal is intentionally scoped." if {
    is_query_tool
    idtyp == "app"
}

# Deny reason: identity absent or ambiguous — no named-user signal to confirm RLS scoping.
reasons contains "This session's identity could not be confirmed as a named Entra user (no user token-type or upn/email claim), so this RLS-sensitive Power BI read/query is denied rather than risk a silent row-level-security bypass. Re-authenticate with an interactive user identity, or confirm the gateway forwards the Entra token-type and upn/email claims. Contact your data-governance team if this is a false positive." if {
    is_query_tool
    is_service_principal
    idtyp != "app"
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
