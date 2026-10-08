---
title: WordPress Plugin
description: How cd-lookup caches, sanitizes, and tests itself inside a full WordPress plugin lifecycle.
---

`cd-lookup` is a real, installable WordPress plugin — Composer-managed, PHPUnit-tested, WordPress Coding
Standards compliant — not a script wrapped in a plugin header. It's in production use on a real advocacy
site.

## What it does

A site visitor types a street address into the `[cd_lookup]` shortcode's form. The plugin:

1. Resolves the address to a congressional district via the **Census Bureau's geocoding API**.
2. Calls **`cd-api`**'s JSON:API `GET /members?filter[state]=XX` (authenticated with an `x-api-key`,
   configured under **Settings → CD Lookup**). One call returns the whole state delegation; the plugin
   regroups it into senators and the representative for the visitor's district, comparing districts
   numerically so an at-large `0` matches however it's formatted.
3. Renders the result client-side, via a small vanilla-JS widget with no build step.

## Caching, deduplicated into one abstraction

District lookups are cached for 1 day; member lookups for 1 hour — different TTLs because districts change
far less often than member details. Rather than writing two near-identical caching wrappers, both go
through a single generic helper:

```php
cd_lookup_cached($cache_key, $ttl, $is_valid, $compute)
```

using WordPress's Transients API underneath. One commit (`a56caa0`) extracted this specifically to
deduplicate what had been two copies of the same caching logic.

Member lookups stay cached per state *and* district, even though one API call now returns the whole
state. That means every district in a large state stores its own copy of the same few-KB payload within
an hour. It's a known, accepted trade-off: a state-keyed cache with district filtering on read would save
little at this traffic level.

## The sanitization boundary

Data returned by the plugin's REST route gets rendered into the page via client-side `innerHTML`. That's
exactly the kind of boundary where upstream data has to be treated as untrusted before it touches the DOM.
`cd_lookup_sanitize_reps()` / `cd_lookup_sanitize_person()` explicitly document themselves as that
boundary:

- Phone numbers are stripped down to digits and punctuation only.
- URLs are scheme-allowlisted to `http`/`https` — blocking `javascript:` URI injection outright, rather
  than trying to blocklist bad patterns.

## Errors that mean different things

`LookupDistrict.php` distinguishes `NoAddressMatchException` from `AmbiguousAddressException` (both
subclasses of `InvalidAddressException`), so a visitor who mistypes their address gets a different, more
useful message than one whose address is genuinely ambiguous. Non-numeric district fields are rejected
outright rather than silently cast to an at-large district (`0`) — a subtle bug class avoided by refusing
to guess.

## Testing without a real WordPress install

The full PHPUnit suite (~1,100 lines: six test files plus a stub bootstrap) runs entirely offline. `tests/bootstrap.php` stubs
WordPress core functions (`add_action`, `get_option`, `get_transient`, the Settings API, etc.) directly —
and the plugin's own `get_district()` / `fetch_members()` functions use `function_exists()` guards so
production code and test doubles can coexist in the same file without a mocking framework or a live
WordPress/MySQL environment in CI.

## Release process

A `v*` git tag triggers `wp-release.yml`, which zips only the production files (`cd-lookup.php`, `src`,
`templates`, `README.md` — explicitly excluding dev-only files like `DEVELOPMENT.md`) and publishes a
GitHub Release via `gh release create --generate-notes`. `wp-tests.yml` runs the PHPUnit suite on every
pull request, separately from the release path.

## A deliberate rewrite, not organic growth

`cd-lookup` didn't start this way — it began as a scraper against GovTrack.us, styled for one specific
client site. A Python proof-of-concept for the district-lookup logic was built, proven out, and then
**deliberately deleted** once the PHP implementation replaced it (`4ec0d0a Remove the discovery/ Python
POC and its README reference`) — evidence of active scope discipline, not just accumulating code.
