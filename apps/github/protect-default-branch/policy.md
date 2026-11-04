---
name: Protect the Default Branch from Direct Agent Commits
tags:
  - github
  - access-control
  - code-review
  - branch-protection
  - ingress
publishedAt: 2026-10-11
description: |
  # github / protect-default-branch

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `github.ingress.protect_default_branch`

  ## What it does

  Stops the agent from committing straight to `main` or `master`. Changes have to land on
  another branch and go through a pull request, where a person reviews them.

  - **`create_or_update_file`**, **`push_files`**, and **`delete_file`** are denied when their
    `branch` argument is `main` or `master` (case-insensitive, with an optional `refs/heads/`
    prefix).
  - The same calls are denied when `branch` is **missing or empty**. GitHub's contents API
    writes to the repository's default branch when no branch is given, so an omitted branch
    is treated as a commit to the default branch.
  - Commits to any other branch, and every other tool (reads, branch creation, PRs), pass
    through.

  ## Compliance alignment

  - **SOC 2 CC8.1** — supports change management: changes reach the production branch
    only through a reviewed pull request.
  - **SOX ITGC (change management)** — supports segregation between authoring a change and
    promoting it.

  ## Why ingress

  A commit is permanent once it reaches GitHub, and a push to the default branch can trigger
  deploys immediately. The target branch is in the request, so ingress can stop it before
  anything is written.

  ## Configuration

  `protected_branches` lists the branch names treated as protected. Add `develop`,
  `release`, or `trunk` if your team uses them as the default or deploy branch.

  ## Tool name matching

  Tools are matched by suffix (`create_or_update_file`, `push_files`, `delete_file`), so the
  policy works whatever name your gateway gives the GitHub server, and covers both the
  official `github/github-mcp-server` and the archived community server, which use the same
  names for these three tools. Confirm the exact names your gateway sends with the
  dump-input debug technique before relying on it.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-push_files", "type": "tool" },
      "payload": { "args": { "owner": "acme", "repo": "app", "branch": "fix/payments-timeout",
        "message": "Revert timeout", "files": [ { "path": "src/client.ts", "content": "..." } ] } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-create_or_update_file", "type": "tool" },
      "payload": { "args": { "owner": "acme", "repo": "app", "branch": "main",
        "path": "src/client.ts", "message": "hotfix", "content": "..." } }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: agents can't commit directly to the main or master branch. Push to a new branch and open a pull request instead."`.

  ## Composition

  Pairs naturally with [`require-human-approval-merge`](../require-human-approval-merge/policy.md):
  this policy forces changes into a PR, that one keeps the merge with a person. Together they
  mean nothing an agent writes reaches the default branch without review.

  ## Known limitations

  - **The default branch name is not looked up.** The policy can't see each repository's
    configured default branch. A repo whose default is `trunk` or `develop` is unprotected
    until you add that name to `protected_branches`.
  - **Other write paths are out of scope.** `merge_pull_request` (handled by
    `require-human-approval-merge`), `update_pull_request_branch`, and Git operations made
    outside the MCP server are not covered.
  - **Not a substitute for GitHub branch protection.** Keep branch protection rules on in
    GitHub too; this policy covers the agent path only.

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
package github.ingress.protect_default_branch

# Allow by default; deny commit-writing tools that target a protected branch.
default allow := true

# Branch names treated as the default / deploy branch. Extend for your repos.
protected_branches := {"main", "master"}

_tool := lower(object.get(input.resource, "name", ""))

_args := object.get(object.get(input, "payload", {}), "args", {})

# Tools that write a commit to a named branch.
_commit_tool_suffixes := {"create_or_update_file", "push_files", "delete_file"}

_is_commit_tool if {
    some suffix in _commit_tool_suffixes
    endswith(_tool, suffix)
}

# Normalize the requested branch: trim, lowercase, drop a refs/heads/ prefix.
_branch := b if {
    raw := object.get(_args, "branch", "")
    is_string(raw)
    b := trim_prefix(lower(trim_space(raw)), "refs/heads/")
}

# Missing, non-string, or empty branch: GitHub writes to the default branch.
_targets_default if not _branch

_targets_default if _branch == ""

_targets_protected if _targets_default

_targets_protected if protected_branches[_branch]

allow := false if {
    _is_commit_tool
    _targets_protected
}

reason := "Blocked: agents can't commit directly to the main or master branch. Push to a new branch and open a pull request instead." if {
    _is_commit_tool
    _targets_protected
}
```
