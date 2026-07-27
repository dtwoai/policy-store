# Onboarding starter policies

Generic, app-agnostic starter policies surfaced in the DTwo Hub **"Define a security policy for your agents"** onboarding step. They are designed to deliver immediate, observable policy activity without requiring you to author any Rego first — pick one, attach it, and watch the gateway exercise a real policy on your traffic.

Unlike the app-specific policies elsewhere in this catalog, these are **not** scoped to a single MCP server. Each one scans the whole request or response body for PII (email addresses, in this starter set) regardless of which tools you have connected, so they work the moment you connect anything.

## Available policies

| Policy                                          | Direction | Purpose                                                                                                            |
| ----------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| [detect-email-allow](./detect-email-allow/policy.md) | ingress   | Passive/observability starter: scan the whole request body for email addresses and **allow** with an `Email Detected` reason. Never blocks. |
| [deny-email](./deny-email/policy.md)            | ingress   | Scan the whole request body for email addresses and **deny** the call when one is found; all other calls pass through. |
| [redact-email](./redact-email/policy.md)        | egress    | Scan the whole response body and **redact** any email address to `[REDACTED]` (transform-only); never blocks.     |

The three cover the same detection (email addresses, scanned across the whole body) with the three enforcement stances — **allow-with-reason**, **deny**, and **redact** — so you can start passive and graduate to enforcement when you're ready.

## Tool naming on the DTwo gateway

These policies are deliberately app-agnostic and match on content, not tool name, so they do not depend on how any MCP server is named on your gateway. If you later want to scope one to a specific server, gate the relevant rule with `startswith(lower(input.resource.name), "<server>-")` and confirm the exact tool name your gateway sends using the dump-input debug technique.

## Identity claims

These policies do not require any specific IdP claims. If you want to add identity-based exemptions (e.g., an InfoSec break-glass user who may pass or read raw PII), gate the relevant `allow` rule with `object.get(input.subject.claims, "<claim>", "<default>")`.

## Contributing

To add an onboarding starter policy:

1. Create `apps/onboarding/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["onboarding"]` and include `onboarding` in `tags` so Hub surfaces it in the onboarding step.
4. Keep it app-agnostic — match on content rather than a specific server's tool names.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
