# DTwo Policy Store — discovery site

A static [Astro](https://astro.build) site that turns the policy catalog in this
repo into a browsable, narrative, SEO- and agent-friendly website. It reads the
**real** catalog artifacts at build time — `../manifest.json`, the
`../apps/**/policy.md` files, and the app/bundle `README.md` landing pages — so
the site never drifts from the source of truth. Add a policy, run the manifest
generator, rebuild, and it shows up.

## What it generates

- **Narrative stories** (`/stories`) — problem-first guides that walk a real
  risk to the policies that solve it. Authored in `src/data/stories.ts`; each
  references catalog policies by slug and fails the build on a dangling link.
- **Browse by app / bundle / tag** and a full **policy index**.
- **Policy detail pages** with the rendered description, the Rego source, and
  links back to GitHub.
- **SEO**: per-page `<title>`/meta description, canonical URLs, OpenGraph +
  Twitter cards, JSON-LD (`WebSite`, `CollectionPage`, `Article`,
  `SoftwareSourceCode`, `BreadcrumbList`), and a `sitemap-index.xml`.
- **Agentic search**: [`/llms.txt`](https://llmstxt.org) (curated index),
  `/llms-full.txt` (every policy inline), `/catalog.json` (structured, absolute
  URLs), per-policy raw markdown at `/policies/<app>/<policy>.md`, and a
  `robots.txt` that points crawlers at all of the above.

## Develop

```sh
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # -> ./dist
pnpm preview
```

## Configure the public origin

Canonical URLs, OpenGraph, the sitemap, `llms.txt`, and `catalog.json` all derive
from the site origin. It defaults to `https://policies.dtwo.ai`; override per
build:

```sh
SITE_URL="https://dtwoai.github.io/dtwo-policy-store" pnpm build
```

> Styling is intentionally minimal (`src/styles/global.css`) — semantic HTML
> with a readability baseline and nothing more. No page depends on class names,
> so a design system can be dropped in without touching content.
