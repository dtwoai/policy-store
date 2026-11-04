---
name: Block Agent Edits to GitHub Actions Workflows
tags:
  - github
  - supply-chain
  - ci-cd
  - access-control
  - ingress
publishedAt: 2026-10-11
description: |
  # github / block-workflow-edits

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `github.ingress.block_workflow_edits`

  ## What it does

  Stops the agent from creating, changing, or deleting GitHub Actions workflows and local
  actions. A workflow file is code that runs in CI with the repository's secrets and tokens,
  so an agent that can edit one can run anything it likes with those credentials. Workflow
  changes stay with people.

  Denied when any target path is under **`.github/workflows/`** or **`.github/actions/`**
  (case-insensitive; a leading `./` or `/` is ignored):

  - **`create_or_update_file`** and **`delete_file`** — the `path` argument.
  - **`push_files`** — every entry of `files[].path`, so a workflow hidden among other files
    in a multi-file commit is still caught.

  Everything else passes through, including commits to other paths in the same repo and
  reads of workflow files.

  ## Compliance alignment

  - **SOC 2 CC8.1** — supports change management over the CI/CD pipeline itself.
  - **SOC 2 CC6.8** — supports controls that prevent the introduction of unauthorized or
    malicious software.
  - **SLSA (build integrity)** — keeps build definitions out of reach of an automated
    author.

  ## Why ingress

  Workflows can run on `push` and `pull_request` events, so a malicious workflow can execute
  the moment it lands, even on a feature branch. Blocking the write before it reaches GitHub
  is the only way to prevent that.

  ## Tool name matching

  Tools are matched by suffix (`create_or_update_file`, `push_files`, `delete_file`), which
  covers both the official `github/github-mcp-server` and the archived community server.
  Confirm the exact names your gateway sends with the dump-input debug technique.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-create_or_update_file", "type": "tool" },
      "payload": { "args": { "owner": "acme", "repo": "app", "branch": "docs",
        "path": "docs/ci.md", "message": "Document CI", "content": "..." } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-push_files", "type": "tool" },
      "payload": { "args": { "owner": "acme", "repo": "app", "branch": "fix/tests", "message": "fix",
        "files": [ { "path": "src/a.ts", "content": "..." },
                   { "path": ".github/workflows/ci.yml", "content": "..." } ] } }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: agents can't create, change, or delete GitHub Actions workflows or actions (.github/workflows, .github/actions). Ask a maintainer to make CI changes."`.

  ## Composition

  Use alongside [`protect-default-branch`](../protect-default-branch/policy.md) and
  [`block-secrets-commits`](../block-secrets-commits/policy.md). This policy covers the CI
  definition; those cover where code lands and what it contains.

  ## Known limitations

  - **Other CI systems are not covered.** Only GitHub Actions paths are matched. Add paths
    such as `.circleci/`, `.gitlab-ci.yml`, `Jenkinsfile`, or `.buildkite/` to
    `protected_prefixes` / `protected_files` if your repos use them.
  - **Workflow triggers are a separate concern.** Running or re-running an existing workflow
    (`run_workflow`, `rerun_workflow_run`) is not blocked here.
  - **Reusable workflows in other repos.** A workflow file can call a reusable workflow from
    another repository; edits made there are only caught if the agent writes them through
    this gateway too.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - github
industries: []
bundles:
  - engineering-stack-jira
  - engineering-stack-linear
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package github.ingress.block_workflow_edits

# Allow by default; deny file writes that touch CI workflow definitions.
default allow := true

# Path prefixes that hold GitHub Actions workflows and local actions.
protected_prefixes := [".github/workflows/", ".github/actions/"]

# Exact file paths to protect (none by default; e.g. ".gitlab-ci.yml").
protected_files := set()

_tool := lower(object.get(input.resource, "name", ""))

_args := object.get(object.get(input, "payload", {}), "args", {})

_is_single_path_tool if endswith(_tool, "create_or_update_file")

_is_single_path_tool if endswith(_tool, "delete_file")

_is_push_files_tool if endswith(_tool, "push_files")

# Every path the call would write or delete.
_paths contains p if {
    _is_single_path_tool
    p := object.get(_args, "path", "")
    is_string(p)
}

_paths contains p if {
    _is_push_files_tool
    files := object.get(_args, "files", [])
    is_array(files)
    some f in files
    is_object(f)
    p := object.get(f, "path", "")
    is_string(p)
}

# Lowercase, trim, and drop a leading "./" or "/".
_normalize(p) := n if {
    n := trim_left(trim_prefix(lower(trim_space(p)), "./"), "/")
}

_is_protected(p) if {
    some prefix in protected_prefixes
    startswith(_normalize(p), prefix)
}

_is_protected(p) if protected_files[_normalize(p)]

_touches_ci if {
    some p in _paths
    _is_protected(p)
}

allow := false if _touches_ci

reason := "Blocked: agents can't create, change, or delete GitHub Actions workflows or actions (.github/workflows, .github/actions). Ask a maintainer to make CI changes." if _touches_ci
```
