/**
 * Narratives layered on top of the catalog.
 *
 * Stories are the "why" — a problem an AI deployment actually hits, told as a
 * short scenario, ending in the policies that resolve it. They are the SEO +
 * agentic-search surface: search-shaped titles, a one-line dek used as the meta
 * description, and `policySlugs` that resolve to real catalog entries (validated
 * at build time — an unknown slug fails the build). Copy is in DTwo's voice.
 *
 * `policySlugs` use the site route form `<app>/<policy>` (no leading `apps/`).
 */
export interface Story {
  slug: string;
  /** Search-shaped headline — also the <title> and og:title. */
  title: string;
  /** One sentence; used verbatim as the meta description. */
  dek: string;
  /** Who hits this problem. */
  persona: string;
  /** Short mono-uppercase category label, e.g. "SLACK · DLP". */
  eyebrow: string;
  /** Markdown narrative. */
  body: string;
  /** Catalog policies that resolve the story, in reading order. */
  policySlugs: string[];
  /** Optional pointers to the matching browse pages. */
  related?: { bundle?: string; app?: string };
}

export const stories: Story[] = [
  {
    slug: "stop-secrets-leaking-into-slack",
    title: "Stop AI agents from leaking secrets into Slack",
    dek: "Once an agent posts to Slack, an API key is in channel history and search. Catch it before the send, not after.",
    persona: "Platform and InfoSec teams running an AI assistant with Slack write access",
    eyebrow: "SLACK · DLP",
    policySlugs: ["slack/block-secrets", "slack/redact-sensitive-info"],
    related: { app: "slack", bundle: "im-messaging" },
    body: "A Slack message is a write you can't take back. The moment your agent calls `slack-post-message`, the text is in channel history and search indexes, and may have already gone out in email digests. So when an agent drops an `AKIA…` key or a `-----BEGIN PRIVATE KEY-----` block into a \"summary,\" redacting on read is already too late. The secret is out.\n\nThe fix is to inspect the call before it reaches Slack. The `block-secrets` policy runs at ingress (`tool_pre_invoke`) and denies any send whose body matches a high-confidence secret shape: AWS keys, GitHub PATs, Slack tokens, Stripe `sk_live_` keys, OpenAI keys, PEM private keys, and generic `key: value` pairs. Other sends are unaffected.\n\nA hard deny suits high-assurance environments. Where it gets in the way of normal chatter, reach for `redact-sensitive-info` instead. It rewrites the matching substrings to `[REDACTED]` and lets the message through, minus the secret. Use deny where you can't tolerate a leak; use redact where you'd rather not break the message. Both run on the same pipeline, so you can attach either one or layer them.",
  },
  {
    slug: "keep-customer-pii-inside-your-crm",
    title: "Keep customer PII from walking out of your CRM",
    dek: "An agent reading Salesforce or HubSpot pulls emails, phone numbers, and addresses into its context and your chat logs. Mask them on the way out.",
    persona: "RevOps and data-governance owners exposing a CRM to AI tooling",
    eyebrow: "CRM · PII",
    policySlugs: ["salesforce/redact-pii", "hubspot/redact-pii", "salesforce/protect-contact-fields"],
    related: { app: "salesforce", bundle: "crm" },
    body: "A CRM record carries the personal data you're accountable for: emails, mobile numbers, mailing addresses, birthdates, sometimes an SSN or a card number dropped into a notes field. Point an agent at those records to \"draft a follow-up\" and it pulls all of that straight into its response. From there it copies into the model context and the chat transcript, which then gets logged somewhere outside the CRM.\n\nThis is an egress problem. The values already exist in Salesforce and HubSpot, so there's nothing to block on the way in. The leak happens on the way out, when the response is handed back to the MCP client. `redact-pii` (one policy per app) is transform-only. It never denies a call; it rewrites matching fields and patterns to `[REDACTED]` before the caller sees them. `Name` and `Account` stay intact by design, so the records remain usable.\n\nThat covers reads. Add `protect-contact-fields` on the ingress side to stop agents from overwriting protected contact data: ownership, account linkage, consent flags. That covers both directions. Protected fields don't read out, and protected fields can't be overwritten.",
  },
  {
    slug: "read-only-crm-for-ai-agents",
    title: "Give AI agents read-only access to your CRM",
    dek: "For a low-risk CRM pilot, give the agent a one-way mirror: it reads every record and changes none. The read-only policies enforce that, and a query allowlist tightens it further.",
    persona: "Teams piloting AI on a CRM who want zero write risk",
    eyebrow: "CRM · ACCESS CONTROL",
    policySlugs: ["salesforce/read-only", "hubspot/read-only", "salesforce/query-allowlist"],
    related: { app: "salesforce", bundle: "crm" },
    body: "For a low-risk CRM pilot, give the agent read access only. It can query every record but cannot change any. It can't flip a deal stage, overwrite an owner, or run a bulk update from a misread instruction.\n\n`read-only` does this fail-closed. The Salesforce variant allowlists the read tools and denies the rest, so a write tool you haven't seen yet is denied by default rather than allowed. The HubSpot variant blocks the single `*-manage-crm-objects` write tool that fronts every mutation. Either way, the integration can't make a write.\n\nIf even the reads need a fence, add `query-allowlist`. It restricts Salesforce SOQL to the Account, Contact, and Opportunity objects, so the agent can't query arbitrary objects across the org. Run fully read-only for the pilot. Once the workflow earns trust, relax to the narrow write-protection policies.",
  },
  {
    slug: "guard-high-stakes-crm-writes",
    title: "Guard the CRM writes your revenue depends on",
    dek: "You want agents logging activities and creating records, just not closing deals or reassigning owners on their own. Gate the few writes that matter.",
    persona: "RevOps teams who want productive agents without high-impact mistakes",
    eyebrow: "HUBSPOT · ACCESS CONTROL",
    policySlugs: ["hubspot/block-deal-closure", "hubspot/protect-deal-owner", "hubspot/protect-associations", "hubspot/protect-lifecycle-stage"],
    related: { app: "hubspot", bundle: "crm" },
    body: "Full read-only is too restrictive when you actually want the agent to update notes, log activities, and create records. The writes worth gating are the few that move money or change how your data is linked.\n\nThis set is four single-purpose deny policies. Each one is `default allow := false` re-allowing everything except its own narrow concern, so they don't step on each other or on the rest of your CRM policies.\n\n`block-deal-closure` denies moves into `closedwon` or `closedlost`. The agent can advance a deal; it just can't declare it won or lost. `protect-deal-owner` denies changes to `hubspot_owner_id`, which keeps attribution and territory under human control. Object associations are handled by `protect-associations`, which denies creating or rewiring them. And `protect-lifecycle-stage` denies changes to a contact's `lifecyclestage`, so funnel reporting stays honest.\n\nAttach the ones that map to your guardrails. They're independent, so you can attach just `block-deal-closure` now and add the rest later.",
  },
  {
    slug: "wall-off-sensitive-jira-projects",
    title: "Wall off sensitive Jira projects from AI agents",
    dek: "Security, legal, and HR projects share the same Jira as your sprint board. Keep agents from reading or writing them, and redact whatever still comes back.",
    persona: "Teams running AI on Jira with confidential projects in the same instance",
    eyebrow: "JIRA · ACCESS CONTROL",
    policySlugs: ["jira/deny-view-search-sensitive-projects", "jira/deny-write-sensitive-projects", "jira/redact-sensitive-info"],
    related: { app: "jira", bundle: "atlassian" },
    body: "Your security, legal, and HR projects sit in the same Jira instance as everything else. Incident-response, legal-hold, and HR-investigation work lives next to the sprint board, and an agent with Jira access sees all of it. Ask it to \"summarize open issues\" and the active security incident is in scope too.\n\nThe control is project-scoped and covers both ways into an issue. `deny-view-search-sensitive-projects` blocks the read side: it denies the two paths a caller has to reach an issue — fetching it directly by key, and JQL search — matched by project key or ID, so the content never reaches the model context. The write side is handled by `deny-write-sensitive-projects`, which stops an agent from creating, commenting on, or transitioning issues in those projects.\n\nWhatever still comes back — including a summary the agent built from issue content it was allowed to read — runs through `redact-sensitive-info`, which masks secrets and PII before the response reaches the caller. The read and write policies share one sensitive-project list, so the fence is defined in a single place. The `atlassian` bundle collects the curated set.",
  },
  {
    slug: "slack-hygiene-for-ai-agents",
    title: "Slack hygiene for autonomous AI agents",
    dek: "Slack OAuth scopes are coarse. Grant enough to post a status update and you've often granted channel creation, DMs, and private-channel reads too.",
    persona: "Platform teams granting agents Slack access beyond a single channel",
    eyebrow: "SLACK · ACCESS CONTROL",
    policySlugs: ["slack/deny-channel-creation", "slack/deny-direct-messages", "slack/deny-read-search-summarize-sensitive-channels"],
    related: { app: "slack", bundle: "slack" },
    body: "Slack OAuth scopes come in big buckets. Grant an agent enough to post a status update and you've usually also handed it channel creation, DMs to any user, and reads on private conversations. The gateway is where you narrow that down, since the scopes can't.\n\nEach of these three ingress policies blocks one specific action and leaves the rest of the Slack tools available. `deny-channel-creation` stops channel sprawl from an over-eager agent. `deny-direct-messages` denies writes addressed to a 1:1 DM, a user ID, or a group DM, so the agent stays in the channels it was scoped for. `deny-read-search-summarize-sensitive-channels` keeps named sensitive channels out of reach for read, search, and summarize.\n\nAdd `block-secrets` from the secrets story and the agent is limited to posting in approved channels with no secrets in the payload. The `slack` bundle gathers the hygiene set.",
  },
];

export function getStory(slug: string): Story | undefined {
  return stories.find((s) => s.slug === slug);
}
