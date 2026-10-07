---
title: Data Pipeline
description: How cd-etl's Airflow DAGs keep congressional members, bills, votes, and embeddings in sync with Congress.gov.
---

`cd-etl` is an Apache Airflow project (TaskFlow API) with three DAGs, all syncing from the official
Congress.gov API:

- **`congress_members_etl`** — keeps the `members` and `member_terms` tables in sync (walked through
  step by step below).
- **`house_votes_etl`** — syncs House roll call votes and each member's position, syncing whatever bill a
  vote references on demand the first time it's seen.
- **`bills_etl`** — runs daily to refresh already-known bills (policy area, subjects, title, CRS summary),
  re-checking each bill at most once every 7 days so settled bills aren't re-fetched every day.

Every bill write — from either the votes DAG or the refresh DAG — goes through one shared function that
also generates the bill's embedding for [Semantic Search](/semantic-search/), re-embedding only when the
bill's content actually changed.

## `congress_members_etl`, step by step

1. **Sync the current Congress** — checks whether a new Congress needs to be inserted.
2. **Determine the current Congress** from what's stored, via the shared `current_congress()` SQL function.
3. **Page the full member roster**, including departed members — Congress.gov paginates, and departed
   members matter for historical accuracy.
4. **Diff against stored `updateDate`** — skip members whose upstream data hasn't changed since the last
   run, instead of re-fetching and re-writing everyone every time.
5. **Fetch full member details in parallel**, via a `ThreadPoolExecutor`, for members that did change.
6. **Transform** the API's shape into the internal schema.
7. **Upsert**, hash-guarded — see below.

## Hash-guarded upserts

Every member row carries a `source_hash`. On upsert, the incoming record's hash is compared to what's
stored; `updated_at` only changes if the hash actually changed. Two details make this robust rather than
just "close enough":

- **`party_history` is sorted before hashing.** Congress.gov doesn't guarantee stable ordering across
  calls, so hashing an unsorted array would produce spurious diffs — and spurious `updated_at` bumps —
  every single run.
- **`end_date` is derived, not trusted verbatim.** The upstream API's `endYear` field has an off-by-one
  quirk for a Congress's end date; the pipeline computes the correct date rather than propagating the
  API's value directly.

## Correctness as a first-class concern

A few other things worth calling out, because they're the kind of edge case that's easy to get wrong
silently:

- Member terms distinguish chamber, district, and member type explicitly, rather than inferring them.
- The pipeline is aware of known upstream gaps (e.g., senior/junior senator distinction, year-only
  end-date precision in some historical records) and tracks them as open issues rather than silently
  guessing.

## Testing

CI doesn't just build the container and call it done — `.github/workflows/cd-etl-tests.yml` builds the
production image, runs it against a **live** Postgres instance, polls its health endpoint, and asserts
that the `congress_members_etl` DAG is actually discoverable by Airflow. That catches an entire class of
"the image builds but doesn't actually run" failures that a build-only check would miss.

Tests run against a dedicated `congressional_app_test` database, kept separate from the seeded dev
database, so test runs and normal local development don't race each other's migrations.

## Deployment

`cd-etl` doesn't have its own CI/CD pipeline to AWS. Instead:

1. A `cd-etl-v*` tag triggers a GitHub Actions workflow that builds the Docker image and pushes it to
   **GHCR** (not ECR — see [CI/CD & Automation](/cicd/) for why).
2. A **Watchtower** sidecar container running on the Airflow EC2 host polls GHCR and pulls new images
   automatically.

No AWS credentials are ever involved in this path — the deploy pipeline never talks to AWS at all.
