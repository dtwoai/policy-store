import type { APIRoute } from 'astro';
import { getPolicies, getApps, getBundles } from '../lib/catalog';
import { stories } from '../data/stories';

/**
 * /llms.txt — the llmstxt.org convention: a curated, link-rich index an LLM or
 * agent can read to understand the whole catalog in one fetch. Links are
 * absolute so they resolve regardless of where the agent found this file.
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://policies.dtwo.ai')).origin;
  const abs = (p: string) => `${origin}${p}`;

  const policies = getPolicies();
  const apps = getApps();
  const bundles = getBundles();

  const lines: string[] = [];
  lines.push('# DTwo Policy Store');
  lines.push('');
  lines.push(
    '> A curated catalog of reusable OPA/Rego policies for the DTwo MCP Gateway. ' +
      'Each policy is evaluated on every MCP tool call to allow, deny, redact, or ' +
      'rewrite the request or response — governing what AI agents can do with ' +
      'Slack, Jira, Salesforce, HubSpot and other connected apps.',
  );
  lines.push('');
  lines.push(
    `Policies are small and single-purpose; you compose a security posture by attaching several together. ` +
      `${policies.length} policies span ${apps.length} apps and ${bundles.length} bundles. ` +
      `The canonical source of truth is the dtwo-policy-store repository on GitHub ` +
      `(https://github.com/dtwoai/dtwo-policy-store). Full policy text inline: ${abs('/llms-full.txt')}. ` +
      `Structured index: ${abs('/catalog.json')}.`,
  );
  lines.push('');

  lines.push('## Stories (problem-first guides)');
  for (const s of stories) lines.push(`- [${s.title}](${abs(`/stories/${s.slug}`)}): ${s.dek}`);
  lines.push('');

  lines.push('## Apps');
  for (const a of apps) lines.push(`- [${a.title}](${abs(`/apps/${a.slug}`)}): ${a.policies.length} policies`);
  lines.push('');

  lines.push('## Bundles');
  for (const b of bundles) lines.push(`- [${b.title}](${abs(`/bundles/${b.slug}`)}): ${b.policies.length} policies`);
  lines.push('');

  lines.push('## Policies');
  for (const p of policies) {
    lines.push(`- [${p.name}](${abs(`/policies/${p.slug}`)}) (${p.app}, ${p.direction}): ${p.summary}`);
  }
  lines.push('');

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
