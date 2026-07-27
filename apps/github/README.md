# GitHub policies

Reusable DTwo policies for the GitHub MCP server — the official `github/github-mcp-server` remote endpoint (`https://api.githubcopilot.com/mcp/`) that Claude clients connect to, plus the archived `@modelcontextprotocol/server-github` community/legacy build still found in brownfield configs. The MCP surface is broad: read tools that reach across *every* repo the OAuth grant can see (source code, diffs, CI logs, secret-scanning alerts), consolidated `*_read`/`*_write` tools that multiplex several REST operations behind a `method` argument, and externally visible or irreversible write tools (commits, merges, PR approvals, gists, forks, repo creation, Actions triggers). Its risk profile is dominated by *IP exfiltration* (source code is the crown jewel) and *irreversible or externally visible change* (a merge, a public gist, a personal-namespace fork of org code) — so tool-name matching alone is insufficient and several of these policies inspect the `method` and `owner` arguments as well.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [role-gate-writes-engineering](./role-gate-writes-engineering/policy.md) | ingress | Gate every write-class and destructive GitHub tool behind an IdP engineering group; read-only by default. | soc2, sox |
| [require-human-approval-merge](./require-human-approval-merge/policy.md) | ingress | Deny agent-initiated pull-request merges and approval submissions, keeping a human in the code-review loop. | soc2, sox |
| [fence-scopes-org-allowlist](./fence-scopes-org-allowlist/policy.md) | ingress | Deny any GitHub call whose `owner` is not in the tenant's company-org allowlist. | soc2, gdpr-ccpa |
| [block-secrets-commits](./block-secrets-commits/policy.md) | ingress | Deny GitHub write calls whose file content, commit message, PR/issue/comment body, or gist carries a live credential. | soc2, pci-dss, gdpr-ccpa |
| [deny-public-exposure-repos](./deny-public-exposure-repos/policy.md) | ingress | Force new repos private, deny public-gist creation, and block personal-namespace forks that would expose org code. | — |
| [redact-secrets-egress](./redact-secrets-egress/policy.md) | egress | Redact known credential shapes from file-content, code-search, job-log, commit, and PR read responses before they enter agent context. | soc2, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A GitHub MCP server registered as `github` surfaces tools like `github-merge_pull_request`, while one registered as `gh-mcp` surfaces `gh-mcp-merge_pull_request`. The policies in this directory match on the *suffix* (`merge_pull_request`, `push_files`, `create_or_update_file`, etc.) so they stay portable across naming conventions and across both the official and archived server builds — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. Where the official server consolidates operations behind a `method` argument (`pull_request_review_write`, `issue_write`, `label_write`, …), the relevant policies read `input.payload.args.method` rather than trusting the tool name alone.

## Identity claims

Most of these policies are single-purpose and require no IdP claims. The identity-gated one (`role-gate-writes-engineering`) reads `input.subject.claims.groups` with a **placeholder** group name (`engineering`). Replace it with your own IdP group name at import time. Missing claims fail closed for grants (no group → not an engineer → write denied).

## Contributing

To add a GitHub policy:

1. Create `apps/github/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["github"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
