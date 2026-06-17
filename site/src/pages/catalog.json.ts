import type { APIRoute } from 'astro';
import { getPolicies, getApps, getBundles } from '../lib/catalog';
import { stories } from '../data/stories';

/**
 * /catalog.json — a structured, absolute-URL index for agentic consumers.
 * Enriches the repo's manifest.json with this site's canonical page URLs, the
 * derived one-line summaries, and the story graph, so a tool can pick a policy
 * and link straight to both the human page and the raw markdown.
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://policies.dtwo.ai')).origin;
  const abs = (p: string) => `${origin}${p}`;

  const data = {
    name: 'DTwo Policy Store',
    description:
      'Curated catalog of reusable OPA/Rego policies for governing MCP tool calls via the DTwo MCP Gateway.',
    source: 'https://github.com/dtwoai/dtwo-policy-store',
    site: origin,
    indexes: { llms: abs('/llms.txt'), llmsFull: abs('/llms-full.txt'), sitemap: abs('/sitemap-index.xml') },
    counts: {
      policies: getPolicies().length,
      apps: getApps().length,
      bundles: getBundles().length,
      stories: stories.length,
    },
    apps: getApps().map((a) => ({ slug: a.slug, title: a.title, url: abs(`/apps/${a.slug}`), policyCount: a.policies.length })),
    bundles: getBundles().map((b) => ({ slug: b.slug, title: b.title, url: abs(`/bundles/${b.slug}`), policyCount: b.policies.length })),
    stories: stories.map((s) => ({
      slug: s.slug,
      title: s.title,
      dek: s.dek,
      url: abs(`/stories/${s.slug}`),
      policies: s.policySlugs.map((slug) => abs(`/policies/${slug}`)),
    })),
    policies: getPolicies().map((p) => ({
      slug: p.slug,
      name: p.name,
      summary: p.summary,
      url: abs(`/policies/${p.slug}`),
      markdown: abs(`/policies/${p.slug}.md`),
      app: p.app,
      apps: p.apps,
      bundles: p.bundles,
      tags: p.tags,
      direction: p.direction,
      package: p.packageName,
      publishedAt: p.publishedAt,
      policyChecksum: p.policyChecksum,
      schemaVersion: p.schemaVersion,
      minimumGatewayVersion: p.minimumGatewayVersion,
      repoPath: p.path,
      github: p.links.github,
    })),
  };

  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
