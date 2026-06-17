import type { APIRoute } from 'astro';
import { getPolicies } from '../lib/catalog';
import { stories } from '../data/stories';

/**
 * /llms-full.txt — the entire catalog as one self-contained markdown document:
 * every story narrative and every policy's full description + Rego body inline,
 * so an agent can ingest the whole thing in a single fetch without crawling.
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://policies.dtwo.ai')).origin;
  const abs = (p: string) => `${origin}${p}`;
  const policies = getPolicies();

  const out: string[] = [];
  out.push('# DTwo Policy Store — full text');
  out.push('');
  out.push(
    'Every policy in the catalog, inline. Source of truth: ' +
      'https://github.com/dtwoai/dtwo-policy-store. Browse: ' +
      `${origin}/. Structured index: ${abs('/catalog.json')}.`,
  );
  out.push('');

  out.push('---');
  out.push('## Stories');
  out.push('');
  for (const s of stories) {
    out.push(`### ${s.title}`);
    out.push(`URL: ${abs(`/stories/${s.slug}`)}`);
    out.push(`For: ${s.persona}`);
    out.push('');
    out.push(s.dek);
    out.push(s.body.trim());
    out.push('');
    out.push(`Policies: ${s.policySlugs.map((slug) => abs(`/policies/${slug}`)).join(', ')}`);
    out.push('');
  }

  out.push('---');
  out.push('## Policies');
  out.push('');
  for (const p of policies) {
    out.push(`### ${p.name}`);
    out.push(`URL: ${abs(`/policies/${p.slug}`)}`);
    out.push(
      `App(s): ${p.apps.join(', ')} | Direction: ${p.direction} | ` +
        `Bundles: ${p.bundles.join(', ') || 'none'} | Package: ${p.packageName ?? 'n/a'} | ` +
        `Published: ${p.publishedAt} | Tags: ${p.tags.join(', ')}`,
    );
    out.push(`Source: ${p.links.github}`);
    out.push('');
    out.push(p.description.trim());
    out.push('');
    out.push('```rego');
    out.push(p.rego);
    out.push('```');
    out.push('');
  }

  return new Response(out.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
