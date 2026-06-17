// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// The public canonical origin for this site. Override with SITE_URL at build
// time (e.g. for a GitHub Pages preview). Canonical links, OpenGraph URLs,
// sitemap.xml, robots.txt, and llms.txt all derive from this value, so it must
// be the real production origin for SEO + agentic discovery to work.
const SITE_URL = process.env.SITE_URL || 'https://policies.dtwo.ai';

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  // Trailing slashes kept consistent so canonical URLs and the sitemap agree.
  trailingSlash: 'never',
  build: { format: 'directory' },
  integrations: [
    sitemap({
      // Static catalog — change frequency is low and every page is equal weight
      // for crawlers; we let per-page <link rel="canonical"> do the precise work.
      changefreq: 'weekly',
      lastmod: new Date('2026-06-17'),
    }),
  ],
});
