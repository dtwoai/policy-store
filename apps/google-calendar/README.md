# Google Calendar policies

Reusable DTwo policies for Google Calendar MCP servers — Google's official remote Calendar server (`create_event`/`update_event`/`delete_event`/`respond_to_event` plus the read tools), the community `nspady/google-calendar-mcp` (`create-event`, `update-event`, `delete-event`, `search-events`, `get-freebusy`, `manage-accounts`), and `taylorwilsdon/google_workspace_mcp`, whose consolidated `manage_event` tool spans create, update, **and** delete behind one name. The Anthropic Claude connector is read-only, so all write risk comes from the official Google server or the community servers wired in behind a gateway. Its risk profile is dominated by *externally visible writes and read-side leakage*, not just deletion: a create/update with an external attendee and `sendUpdates: all` emails the event body outside the org (an under-watched exfil channel), `visibility: public` / `guestsCan*` flags hand a private event to the world, recurring-series-wide edits and deletes silently move or wipe standing meetings with no MCP-level undo, and read responses expose attendee email lists, private event bodies, and live meeting-join links across every calendar the OAuth grant covers.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [guard-external-attendees](./guard-external-attendees/policy.md) | ingress | Deny event-write calls (create/update/`manage_event`) that invite any attendee whose domain is outside the corporate allowlist; closes the calendar-invite exfil channel. | soc2, hipaa, gdpr-ccpa |
| [guard-public-exposure](./guard-public-exposure/policy.md) | ingress | Deny create/update calls that set `visibility: public` or hand edit / invite / self-add control to guests. | soc2 |
| [freeze-destructive-events](./freeze-destructive-events/policy.md) | ingress | Deny event deletes (including `manage_event` delete actions) for non-admins, and deny recurring-series-wide changes for everyone. | soc2, hipaa, gdpr-ccpa, sox |
| [redact-attendee-pii](./redact-attendee-pii/policy.md) | egress | Redact attendee emails and names, meeting-join links, and PII/PHI in calendar read responses (transform-only); reads still return, scrubbed. | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway, and the three Calendar implementations disagree on delimiters for the *same* operations — `create_event` (Google, snake), `create-event` (nspady, kebab), `gcal_*` (Claude connector), and `manage_event` (taylorwilsdon, consolidated). The policies here match on the *suffix* and normalize `-`/`_` so they stay portable across naming conventions, and the destructive-ops policy inspects the `action` argument on `manage_event` because the tool name alone cannot tell a reschedule from a delete. Always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying.

## Identity claims

The identity-gated policies read `input.subject.claims.groups` with **placeholder** group names — replace them with your own IdP group names at import time: `guard-external-attendees` exempts `calendar-external-schedulers`, `freeze-destructive-events` exempts `calendar-admins` (deletes only — series-wide changes are denied even for admins), and `redact-attendee-pii` exempts `calendar-full-read`. Missing claims fail closed for grants (no group → not exempt).

## Contributing

To add a Google Calendar policy:

1. Create `apps/google-calendar/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["google-calendar"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework bundle, link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
