# jira / deny-view-search-sensitive-projects

**Direction:** ingress (`tool_pre_invoke`) · **Package:** `jira.ingress.deny_sensitive_search_and_view`

Keeps issues in a configurable set of sensitive JIRA projects out of read access through the JIRA MCP server, guarding both the direct-view and JQL-search paths.

## What it does

The policy is `default allow := true` and acts on the two JIRA read tools:

- **Direct view** (`*-getjiraissue`) — denied when `issueIdOrKey` resolves to a sensitive project. The caller gets a reason naming the project.
- **Explicit search** (`*-searchjiraissuesusingjql`) — denied when the JQL explicitly references a sensitive project (`project = X`, `project in (... X ...)`, or any `X-NNN` issue key). The caller gets a reason naming the matched project(s).
- **Generic search** (`*-searchjiraissuesusingjql`) — any other JQL is silently rewritten to prepend `project NOT IN (...)`, so sensitive-project issues never appear in the result set.

All other JIRA tools and all other projects pass through unchanged.

## When to use it

Use this when one or more JIRA projects (HR, legal, security, M&A, etc.) must not be readable by callers going through the gateway, but you still want those callers to use JIRA normally for everything else. Because generic searches are filtered rather than blocked, day-to-day search workflows keep working — they just can't surface protected issues.

## Assumptions

- Tool names are matched by **suffix** (`-getjiraissue`, `-searchjiraissuesusingjql`) so the policy is portable across gateway MCP-server naming. Confirm the exact names your gateway emits with the dump-input debug technique.
- The issue key is read from `input.payload.args.issueIdOrKey`; the query from `input.payload.args.jql`. Adjust the lookups if your JIRA MCP server names these differently.
- JQL is inspected with regex, not a full parser — see *Known limitations* in [`policy.md`](./policy.md).

## Configuration

Edit the `sensitive_projects` set at the top of [`policy.md`](./policy.md). The shipped keys `PROJA` / `PROJB` are placeholders — replace them with your real project keys (uppercase). If you also run a write-protection policy for the same projects, mirror the set there.

## Tests

See [`tests/`](./tests/) for sample inputs and expected outcomes:

- [`allow.json`](./tests/allow.json) — a generic search that is allowed (and silently filtered).
- [`deny.json`](./tests/deny.json) — an explicit sensitive-project search that is denied with a reason.

## Composition

This policy covers reads. It pairs with the [`redact-sensitive-info`](../redact-sensitive-info/policy.md) egress policy in the [`atlassian`](../../../bundles/atlassian/README.md) bundle (which masks PII/secrets in returned issue content), and with a separate write-protection policy for the same projects.
