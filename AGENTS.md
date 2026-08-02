## Repo structure

This is a two-app monorepo, not a single Astro project:

- `apps/site` — the custom landing page (Tailwind, no Starlight), deploys to `civicdog.com`.
- `apps/docs` — the Starlight engineering docs, deploys to `docs.civicdog.com`.

Each app has its own `package.json`, `astro.config.mjs`, and `amplify.yml`, and must be run/built from
within its own directory (`cd apps/site` or `cd apps/docs`), or via the root `package.json` convenience
scripts (`npm run site:dev`, `npm run docs:dev`, etc.).

## Development

When starting a dev server, use background mode from inside the relevant app directory:

```
cd apps/site && astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Git conventions

PRs are merged with a merge commit (`gh pr merge --merge`), not squash or
rebase — preserves the individual commit history from the PR branch.
After merging, delete the branch both locally and remotely
(`gh pr merge --merge --delete-branch` does both in one step).

When addressing review comments on an open PR, break the fixes up into
separate commits along logical lines (one commit per distinct issue/fix,
not one commit for everything) rather than a single catch-all commit, and
reply to each review comment on GitHub referencing the specific commit
hash that addressed it (e.g. "Fixed in `abc1234`.") -- keeps the review
thread traceable to the exact change that resolved it, rather than a
generic "addressed" reply pointing at the whole PR.

When *submitting* a code review on a PR, post each finding as its own
separate inline review comment (anchored to the specific file/line via
`gh api repos/{owner}/{repo}/pulls/{number}/comments`, not a single bundled
`gh pr comment`) -- a combined comment listing every finding only supports
one flat reply thread, making it impossible to reply to (or resolve)
individual findings separately later.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
