/**
 * Build-time catalog loader.
 *
 * Reads the *real* policy-store artifacts that live one directory up from this
 * site (manifest.json + apps/<app>/<policy>/policy.md + the app/bundle README
 * landing pages) and turns them into typed, render-ready objects. Everything
 * here runs at build time on Node, so plain `fs` access is fine.
 *
 * The repo is the single source of truth: this loader never invents metadata,
 * it only re-shapes what the catalog already declares. Narrative copy lives in
 * src/data/stories.ts and is layered on top by reference (by policy path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { marked } from 'marked';

// src/lib -> src -> site -> repo root (where manifest.json + apps/ live).
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../../..');

const GITHUB_REPO = 'https://github.com/dtwoai/dtwo-policy-store';
const GITHUB_BLOB = `${GITHUB_REPO}/blob/main`;
const GITHUB_RAW = 'https://raw.githubusercontent.com/dtwoai/dtwo-policy-store/main';

export type Direction = 'ingress' | 'egress';

export interface ManifestEntry {
  path: string;
  name: string;
  direction: Direction;
  publishedAt: string;
  apps: string[];
  industries: string[];
  bundles: string[];
  tags: string[];
  policyChecksum: string;
  schemaVersion: string;
  minimumGatewayVersion?: string;
}

export interface Manifest {
  policies: ManifestEntry[];
  apps: Record<string, string>;
  industries: Record<string, string>;
  bundles: Record<string, string>;
}

export interface Policy extends ManifestEntry {
  /** `<app>/<policy>` — the site route slug under /policies/. */
  slug: string;
  /** Primary app slug (first in `apps`). */
  app: string;
  /** The Rego package declaration, e.g. `slack.ingress.block_secrets`. */
  packageName?: string;
  /** One-line, plain-text summary for meta descriptions + cards. */
  summary: string;
  /** Full description as authored (markdown). */
  description: string;
  /** Full description (markdown) rendered to HTML. */
  descriptionHtml: string;
  /** Raw Rego policy body (no fence). */
  rego: string;
  /** Links back to the source of truth. */
  links: {
    github: string;
    raw: string;
    rawMd: string;
  };
}

export interface AppPage {
  slug: string;
  /** Human title, e.g. "Slack". */
  title: string;
  readmeHtml: string;
  policies: Policy[];
}

export interface BundlePage {
  slug: string;
  title: string;
  readmeHtml: string;
  policies: Policy[];
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function titleCase(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Strip markdown to plain text and collapse whitespace. */
function toPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links
    .replace(/[*_>#]/g, ' ') // emphasis / blockquote / heading marks
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive a tight, human meta-description from the policy's markdown
 * description: the first real prose paragraph (skipping the H1 title and the
 * bold **Direction:** / **Default:** / **Package:** meta lines).
 */
function deriveSummary(description: string, max = 158): string {
  const lines = description.split('\n');
  const buf: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (buf.length) break; // end of first paragraph
      continue;
    }
    if (line.startsWith('#')) continue; // heading
    if (line.startsWith('**')) continue; // meta line
    if (line.startsWith('|') || line.startsWith('-') || line.startsWith('>')) continue;
    if (line.startsWith('```')) break;
    buf.push(line);
  }
  let text = toPlain(buf.join(' '));
  if (text.length > max) {
    text = text.slice(0, max).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

function extractRego(body: string): string {
  const m = body.match(/```rego\s*\n([\s\S]*?)```/);
  return (m ? m[1] : body).replace(/\s+$/, '');
}

function extractPackage(rego: string): string | undefined {
  const m = rego.match(/^\s*package\s+([\w.]+)/m);
  return m ? m[1] : undefined;
}

let _manifest: Manifest | null = null;
export function getManifest(): Manifest {
  if (!_manifest) _manifest = JSON.parse(read('manifest.json')) as Manifest;
  return _manifest;
}

let _policies: Policy[] | null = null;
export function getPolicies(): Policy[] {
  if (_policies) return _policies;
  const manifest = getManifest();
  _policies = manifest.policies
    .map((entry): Policy => {
      const file = read(path.join(entry.path, 'policy.md'));
      const { data, content } = matter(file);
      const description: string = (data.description as string) ?? '';
      const rego = extractRego(content);
      const slug = entry.path.replace(/^apps\//, '');
      return {
        ...entry,
        // frontmatter wins for the long description; manifest carries the rest.
        slug,
        app: entry.apps[0] ?? slug.split('/')[0],
        packageName: extractPackage(rego),
        summary: deriveSummary(description),
        description,
        descriptionHtml: marked.parse(description, { async: false }) as string,
        rego,
        links: {
          github: `${GITHUB_BLOB}/${entry.path}/policy.md`,
          raw: `${GITHUB_RAW}/${entry.path}/policy.md`,
          rawMd: `${GITHUB_RAW}/${entry.path}/policy.md`,
        },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return _policies;
}

export function getPolicyBySlug(slug: string): Policy | undefined {
  return getPolicies().find((p) => p.slug === slug);
}

export function getApps(): AppPage[] {
  const manifest = getManifest();
  const policies = getPolicies();
  return Object.entries(manifest.apps)
    .map(([slug, dir]): AppPage => ({
      slug,
      title: titleCase(slug),
      readmeHtml: marked.parse(read(path.join(dir, 'README.md')), { async: false }) as string,
      policies: policies.filter((p) => p.apps.includes(slug)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function getBundles(): BundlePage[] {
  const manifest = getManifest();
  const policies = getPolicies();
  return Object.entries(manifest.bundles)
    .map(([slug, dir]): BundlePage => ({
      slug,
      title: titleCase(slug),
      readmeHtml: marked.parse(read(path.join(dir, 'README.md')), { async: false }) as string,
      policies: policies.filter((p) => p.bundles.includes(slug)),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** All distinct tags with their policy counts, most-common first. */
export function getTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of getPolicies()) {
    for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function getPoliciesByTag(tag: string): Policy[] {
  return getPolicies().filter((p) => p.tags.includes(tag));
}

export const repoLinks = { repo: GITHUB_REPO, blob: GITHUB_BLOB, raw: GITHUB_RAW };
