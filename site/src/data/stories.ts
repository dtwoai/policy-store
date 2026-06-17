/**
 * Narratives layered on top of the catalog.
 *
 * Stories are the "why" — a problem an AI deployment actually hits, told as a
 * short scenario, ending in the concrete policies that solve it. They are the
 * SEO + agentic-search surface: search-shaped titles, a one-line dek used as
 * the meta description, and `policySlugs` that resolve to real catalog entries
 * (validated at build time — an unknown slug fails the build).
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
  /** Markdown narrative. */
  body: string;
  /** Catalog policies that resolve the story, in reading order. */
  policySlugs: string[];
  /** Optional pointers to the matching browse pages. */
  related?: { bundle?: string; app?: string };
}

export const stories: Story[] = [
  {
    slug: 'stop-secrets-leaking-into-slack',
    title: 'Stop AI agents from leaking secrets into Slack',
    dek: 'When an AI assistant can post to Slack, an API key or password is one hallucinated message away from your channel history. Block it at the gateway.',
    persona: 'Platform & InfoSec teams running an AI assistant with Slack write access',
    related: { app: 'slack', bundle: 'im-messaging' },
    policySlugs: ['slack/block-secrets', 'slack/redact-sensitive-info'],
    body: `
A Slack message is a write you can't take back. The moment your agent calls
\`slack-post-message\`, the text exists in channel history, in email digests, in
search indexes, and possibly in DMs to half the workspace. So when an agent
pastes an \`AKIA…\` key or a \`-----BEGIN PRIVATE KEY-----\` block into a
"summary," redaction-on-read is already too late — the secret is out.

The fix is to inspect the call **before** it reaches Slack. The
\`block-secrets\` policy runs at ingress (\`tool_pre_invoke\`) and denies any
send whose body matches a high-confidence secret shape — AWS keys, GitHub PATs,
Slack tokens, Stripe \`sk_live_\` keys, OpenAI keys, PEM private keys, and
generic \`key: value\` credentials. Everything else passes through untouched.

Some teams find a hard deny too disruptive for day-to-day chatter. For them,
\`redact-sensitive-info\` is the softer sibling: it rewrites the offending
substrings to \`[REDACTED]\` instead of rejecting the call, so the message still
goes out — minus the secret. Pick deny for high-assurance environments, redact
where flow matters more than strictness. They compose cleanly on the same
pipeline.
`,
  },
  {
    slug: 'keep-customer-pii-inside-your-crm',
    title: 'Keep customer PII from walking out of your CRM',
    dek: 'AI agents that read Salesforce or HubSpot will happily surface emails, phone numbers, and SSNs. Mask them on the way out without breaking the workflow.',
    persona: 'RevOps & data-governance owners exposing a CRM to AI tooling',
    related: { app: 'salesforce', bundle: 'crm' },
    policySlugs: ['salesforce/redact-pii', 'hubspot/redact-pii', 'salesforce/protect-contact-fields'],
    body: `
Your CRM is a vault of personal data — emails, mobile numbers, mailing
addresses, birthdates, sometimes SSNs and card numbers sitting in a notes
field. An AI agent reading those records to "draft a follow-up" pulls all of it
into the model context, the chat transcript, and wherever that transcript is
logged. The data was never meant to leave the CRM, and now it has.

These are **egress** problems: the values already exist in Salesforce and
HubSpot, so there's nothing to block on the way in — the leak happens on the way
*out*, when the response is handed back to the MCP client. \`redact-pii\`
(one policy per app) is transform-only: it never denies a call, it just rewrites
matching fields and patterns to \`[REDACTED]\` before the caller sees them.
\`Name\` and \`Account\` are left intact by design so records stay usable.

Pair it with \`protect-contact-fields\` on the ingress side to stop agents from
*overwriting* protected contact data (ownership, account linkage, consent
flags), and you've covered both directions: nothing sensitive reads out, nothing
critical gets clobbered.
`,
  },
  {
    slug: 'read-only-crm-for-ai-agents',
    title: 'Give AI agents read-only access to your CRM',
    dek: 'The safest way to let an AI agent use your CRM is to make sure it can read everything and change nothing. Two policies enforce exactly that.',
    persona: 'Teams piloting AI on a CRM who want zero write risk',
    related: { app: 'salesforce', bundle: 'crm' },
    policySlugs: ['salesforce/read-only', 'hubspot/read-only', 'salesforce/query-allowlist'],
    body: `
The fastest path to a safe CRM pilot is a one-way mirror: the agent can look at
anything, but it can't touch a thing. No accidental deal-stage flips, no
overwritten owners, no bulk updates from a misread instruction — just reads.

\`read-only\` does this fail-closed. The Salesforce variant allowlists the read
tools and denies everything else (so a brand-new write tool you haven't seen yet
is denied by default, not allowed). The HubSpot variant blocks the single
\`*-manage-crm-objects\` write tool that fronts all mutations. Either way, the
blast radius of the integration drops to zero.

If even reads need a fence, add \`query-allowlist\`: it restricts Salesforce SOQL
to Account, Contact, and Opportunity objects, so an agent can't go spelunking
through every object in the org. Start fully read-only for the pilot, then relax
to the narrow write-protection policies once you trust the workflow.
`,
  },
  {
    slug: 'guard-high-stakes-crm-writes',
    title: 'Guard the CRM writes your revenue depends on',
    dek: 'You want agents to do real CRM work — just not close deals, reassign owners, or rewire associations on their own. Gate the few writes that actually matter.',
    persona: 'RevOps teams who want productive agents without high-impact mistakes',
    related: { app: 'hubspot', bundle: 'crm' },
    policySlugs: [
      'hubspot/block-deal-closure',
      'hubspot/protect-deal-owner',
      'hubspot/protect-associations',
      'hubspot/protect-lifecycle-stage',
    ],
    body: `
Full read-only is safe but blunt — sometimes you *want* the agent updating
notes, logging activities, and creating records. The risk isn't writes in
general; it's the handful of writes that move money or rewrite the shape of your
data. Those are the ones to gate.

This set is four single-purpose deny policies, each \`default allow := false\`
re-allowing everything except its own narrow concern, so they never step on each
other or on your other CRM policies:

- \`block-deal-closure\` — denies moves into \`closedwon\` / \`closedlost\`. An
  agent can advance a deal, just not declare it won or lost.
- \`protect-deal-owner\` — denies changes to \`hubspot_owner_id\`, so
  attribution and territory stay human-controlled.
- \`protect-associations\` — denies creating or rewiring object associations.
- \`protect-lifecycle-stage\` — denies changes to a contact's
  \`lifecyclestage\`, keeping funnel reporting honest.

Attach the ones that map to your guardrails. Each is independently composable,
so you can start with deal closure and add the others as your policy posture
matures.
`,
  },
  {
    slug: 'wall-off-sensitive-jira-projects',
    title: 'Wall off sensitive Jira projects from AI agents',
    dek: 'Security, legal, and HR projects live in the same Jira as everything else. Keep AI agents out of them — for reads, writes, and summaries alike.',
    persona: 'Teams running AI on Jira with confidential projects in the same instance',
    related: { app: 'jira', bundle: 'atlassian' },
    policySlugs: [
      'jira/deny-view-search-sensitive-projects',
      'jira/deny-write-sensitive-projects',
      'jira/redact-sensitive-info',
    ],
    body: `
Jira rarely separates the mundane from the confidential. Your incident-response,
legal-hold, and HR-investigation projects sit in the same instance as the
sprint board — and an AI agent given Jira access sees all of them. "Summarize
open issues" quietly becomes "summarize the active security incident."

The defense is project-scoped and covers every path into those issues:

- \`deny-view-search-sensitive-projects\` blocks the read side — view, search,
  and summarize operations targeting sensitive projects (matched by project key
  or ID), so the content never enters the model context.
- \`deny-write-sensitive-projects\` blocks the write side, so an agent can't
  create, comment on, or transition issues in those projects.
- \`redact-sensitive-info\` is the backstop: for issues that *do* come back, it
  masks secrets and PII before the response reaches the caller.

Together they keep a single sensitive project list enforced across reads,
writes, and the data that leaks through summaries. See the \`atlassian\` bundle
for the curated set.
`,
  },
  {
    slug: 'slack-hygiene-for-ai-agents',
    title: 'Slack hygiene for autonomous AI agents',
    dek: 'An agent with broad Slack scopes can create channels, DM anyone, and read private conversations. Trim it down to the behavior you actually intended.',
    persona: 'Platform teams granting agents Slack access beyond a single channel',
    related: { app: 'slack', bundle: 'slack' },
    policySlugs: [
      'slack/deny-channel-creation',
      'slack/deny-direct-messages',
      'slack/deny-read-search-summarize-sensitive-channels',
    ],
    body: `
Slack OAuth scopes are coarse. Grant an agent enough to post a status update and
you've often also granted it the ability to spin up channels, slide into anyone's
DMs, and read conversations that were never meant for a bot. The gateway is where
you put the precision the scopes lack.

These three ingress policies each fence off one behavior and pass everything else
through:

- \`deny-channel-creation\` — stops channel sprawl from an over-eager agent.
- \`deny-direct-messages\` — denies writes addressed to a 1:1 DM, a user ID, or
  a group DM, so the agent stays in the open channels it was meant for.
- \`deny-read-search-summarize-sensitive-channels\` — keeps named sensitive
  channels out of reach for read, search, and summarize alike.

Stack them with \`block-secrets\` from the secrets story and you've got a tidy,
well-behaved Slack agent that does its job and nothing else. The \`slack\`
bundle collects the hygiene set.
`,
  },
];

export function getStory(slug: string): Story | undefined {
  return stories.find((s) => s.slug === slug);
}
