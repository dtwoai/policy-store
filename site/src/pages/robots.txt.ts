import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL('https://policies.dtwo.ai')).origin;
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${origin}/sitemap-index.xml`,
    '',
    '# Agent-readable indexes of this catalog:',
    `# ${origin}/llms.txt`,
    `# ${origin}/llms-full.txt`,
    `# ${origin}/catalog.json`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
