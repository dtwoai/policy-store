# hubspot / block-deal-closure

**Direction:** ingress (`tool_pre_invoke`) · **Package:** `hubspot.ingress.no_close_deal`

Denies HubSpot CRM-object calls that move a deal into a closed stage (`closedwon` or `closedlost`). Every other deal change — and every other HubSpot tool — passes through unchanged.

## What it does

The policy is `default allow := false` and re-allows everything except the one case it targets: a `hubspot-manage-crm-objects` call that sets a deal's `dealstage` to a closed value. It inspects both `createRequest.objects` and `updateRequest.objects`, matches objects whose `objectType` is `deals`, and reads `properties.dealstage` (all comparisons case-insensitive). A blocked call returns a clear denial reason instead of closing the deal.

## When to use it

Use this when deals should not be closed through the gateway — for example, to keep an AI agent or integration from advancing pipeline stages that drive revenue recognition or trigger downstream automation, while still letting it make other CRM edits.

## Configuration

- **Closed stages** — edit `closed_stages` at the top of the Rego. Defaults to `closedwon` and `closedlost`; add your pipeline's custom closed-stage internal names if they differ.
- **Tool name** — the policy matches on the suffix `-manage-crm-objects`, so it works regardless of the MCP server name the gateway prefixes (`hubspot-`, `hubspot-mcp-`, etc.). Confirm exact tool/argument names with the dump-input debug technique.

## Assumptions

- Deal-stage changes flow through `hubspot-manage-crm-objects` with `objectType: "deals"` and a `properties.dealstage` value. If your MCP server exposes a dedicated deal tool or a different argument shape, extend the `is_closing_deal` rules.
- No identity-based exemptions. All callers are treated the same — add an `allow if` branch gated on `input.subject.claims` for a break-glass role.

## Tests

See [`tests/`](./tests/):

- [`deny.json`](./tests/deny.json) — an update that sets `dealstage` to `closedwon` is denied.
- [`allow.json`](./tests/allow.json) — an update to a non-closed stage passes through.

## Composition

Part of the [`hubspot`](../../../bundles/hubspot/README.md) bundle. It is a single-purpose deny policy, so it composes cleanly with other HubSpot policies on the same ingress pipeline.
