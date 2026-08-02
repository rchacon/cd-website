# CivicDog Website

The marketing site and engineering showcase for [CivicDog](https://civicdog.com) — a civic data platform
that syncs authoritative U.S. Congress data from Congress.gov and ships it as a REST API
([`cd-api`](https://github.com/rchacon/cd-platform)) and a WordPress plugin
([`cd-lookup`](https://github.com/rchacon/cd-lookup)).

This is a two-app monorepo, deployed as two separate AWS Amplify apps on two subdomains:

| App | Deploys to | What it is |
| :--- | :--- | :--- |
| [`apps/site`](apps/site) | [civicdog.com](https://civicdog.com) | A fully custom [Astro](https://astro.build) + Tailwind landing page: the problem, the API product, the WordPress plugin. |
| [`apps/docs`](apps/docs) | [docs.civicdog.com](https://docs.civicdog.com) | A [Starlight](https://starlight.astro.build)-powered engineering showcase covering the data pipeline, the API, the [Terraform-managed AWS infrastructure](https://github.com/rchacon/cd-infra), and CI/CD automation. |

Each app is fully independent — its own `package.json`, `astro.config.mjs`, and `amplify.yml` — so they
build, deploy, and version separately. The only thing that couples them is a handful of cross-links (the
site links out to `docs.civicdog.com`, and the docs site links back).

## Project structure

```
cd-website/
├── package.json          # root convenience scripts only — no shared dependencies
├── apps/
│   ├── site/              # → civicdog.com
│   │   ├── amplify.yml
│   │   ├── astro.config.mjs
│   │   ├── public/logo/   # brand assets
│   │   └── src/
│   │       ├── components/          # Hero, ProductApi, ProductWordPress, ...
│   │       ├── layouts/Layout.astro
│   │       ├── pages/index.astro
│   │       └── styles/global.css    # Tailwind theme (navy/blue brand tokens)
│   └── docs/               # → docs.civicdog.com
│       ├── amplify.yml
│       ├── astro.config.mjs
│       └── src/
│           ├── content.config.ts
│           ├── content/docs/        # engineering docs (Markdown/MDX)
│           ├── components/MermaidDiagram.astro
│           └── styles/starlight.css # Starlight theme override (same brand tokens)
```

Since each app owns its own domain root, `apps/docs` needs no URL-prefix tricks — its content lives
directly under `src/content/docs/` and routes land at `/`, `/architecture/`, `/api/`, etc.

The two apps intentionally duplicate a small amount (the navy/blue theme tokens, the favicon/logo assets)
rather than sharing a package for them — for a design system this small, that's simpler than the workspace
plumbing it'd take to share it, and it keeps each app fully self-contained for Amplify's per-app builds.

## Commands

Each app is run independently. From the repo root:

| Command | Action |
| :--- | :--- |
| `npm run site:install` / `npm run site:dev` / `npm run site:build` | Install, run (`localhost:4321`), build the landing page |
| `npm run docs:install` / `npm run docs:dev` / `npm run docs:build` | Install, run (`localhost:4322`), build the docs site |

Or `cd apps/site` / `cd apps/docs` and use the normal `npm install`, `npm run dev`, `npm run build`,
`npx astro check` directly.

Requires Node.js 22+.

## Deploying (AWS Amplify)

Each app is its own Amplify Hosting app, both pointed at this same git repo but with a different
**app root** — Amplify's standard monorepo pattern. Neither app is connected automatically; this repo is
just built to be ready for it.

For **each** app (`apps/site` and `apps/docs`):

1. **Create the Amplify app.** In the [Amplify console](https://console.aws.amazon.com/amplify/), choose
   **Host a web app** → select this repo and the `main` branch.
2. **Set the app root.** In the app's build settings, set the **monorepo app root directory** to
   `apps/site` (or `apps/docs` for the docs app). Amplify will then use the `amplify.yml` inside that
   directory automatically — no manual build settings needed.
3. **Attach the custom domain.** **Hosting → Custom domains** → **Add domain** → `civicdog.com` for the
   site app, `docs.civicdog.com` for the docs app. Amplify provisions and manages the SSL certificate and
   shows the DNS records to add at your domain registrar.
4. **Verify.** Once DNS propagates, Amplify shows each domain as "Available" and serves it over HTTPS.

No AWS changes are made automatically by this repo — creating the two apps and wiring the domains are done
once, manually, in the Amplify console.
