import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import { getPolicies, REPO_ROOT, type Policy } from '../../lib/catalog';

/**
 * /policies/<app>/<policy>.md — the raw policy.md (frontmatter + Rego) straight
 * from the catalog, served as text/markdown. A clean, single-artifact target an
 * agent can fetch and hand to a gateway, alongside the rendered HTML page at the
 * same slug (without the .md).
 */
export function getStaticPaths() {
  return getPolicies().map((policy) => ({ params: { slug: policy.slug }, props: { policy } }));
}

export const GET: APIRoute = ({ props }) => {
  const { policy } = props as { policy: Policy };
  const body = fs.readFileSync(path.join(REPO_ROOT, policy.path, 'policy.md'), 'utf8');
  return new Response(body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
