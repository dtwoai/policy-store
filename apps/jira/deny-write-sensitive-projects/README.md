# jira / deny-write-sensitive-projects

**Direction:** ingress (`tool_pre_invoke`) · **Package:** `jira.ingress.protect_sensitive_projects`

Blocks write operations against issues in a configurable set of sensitive JIRA projects — the write-side companion to the read/search restriction policy.

## What it does

The policy is `default allow := true` and denies a call only when a write targets a sensitive project, across four families of operations:

- **Direct writes** (`*-editjiraissue`, `*-transitionjiraissue`, `*-deletejiraissue`, comment/worklog/attachment/watcher/vote tools, etc.) — denied when `issueIdOrKey` resolves to a sensitive project.
- **Links** (`*-linkjiraissues`, `*-createjiraissuelink`, `*-deletejiraissuelink`) — denied when the inward or outward issue is in a sensitive project.
- **Create** (`*-createjiraissue`) — denied when the target project is sensitive.
- **Move** (`*-movejiraissue`) — denied when the destination project is sensitive.

All other tools and all other projects pass through unchanged.

## When to use it

Use this to make one or more JIRA projects (HR, legal, security, M&A, etc.) effectively read-only — or fully off-limits — to callers going through the gateway, while leaving the rest of JIRA fully writable. It pairs with the read-side policy to lock both directions on the same project set.

## Assumptions

- Tool names are matched by **suffix**, so the policy is portable across gateway MCP-server naming. Confirm the exact names your gateway emits with the dump-input debug technique, and extend the suffix sets for any additional write tools your server exposes.
- The acted-on issue is read from `input.payload.args.issueIdOrKey`; link endpoints from `inwardIssue.key` / `outwardIssue.key`. Create/move target projects are detected across several argument shapes — see [`policy.md`](./policy.md).
- Project membership is derived from `KEY-NNN` identifiers; numeric issue IDs are not covered (see *Known limitations* in [`policy.md`](./policy.md)).

## Configuration

Edit the `sensitive_projects` set at the top of [`policy.md`](./policy.md). The shipped keys `PROJECT_KEY1` / `PROJECT_KEY2` are placeholders — replace them with your real project keys (uppercase). If you also run the read/search-restriction policy for the same projects, mirror the set there.

## Tests

See [`tests/`](./tests/) for sample inputs and expected outcomes:

- [`allow.json`](./tests/allow.json) — editing an issue in a non-sensitive project is allowed.
- [`deny.json`](./tests/deny.json) — editing an issue in a sensitive project is denied with a reason.

## Composition

Part of the [`atlassian`](../../../bundles/atlassian/README.md) bundle. Pairs with [`deny-view-search-sensitive-projects`](../deny-view-search-sensitive-projects/policy.md) (ingress read/search restriction) and [`redact-sensitive-info`](../redact-sensitive-info/policy.md) (egress redaction).
