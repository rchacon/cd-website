---
title: Data Pipeline
description: How cd-etl's Airflow DAGs keep congressional members, bills, votes, and embeddings in sync with Congress.gov.
---

`cd-etl` is an Apache Airflow project (TaskFlow API) with three DAGs, all syncing from the official
Congress.gov API, each walked through step by step below:

- **`congress_members_etl`** — keeps the `members` and `member_terms` tables in sync.
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
6. **Fetch the legislators crosswalk**, concurrently with steps 1–5: `legislators-current.yaml` from the
   public `unitedstates/congress-legislators` project, unrelated to Congress.gov. It supplies each
   senator's editorially maintained senior/junior rank and their Senate LIS ID (which Senate vote data
   is keyed by). This task never raises: if the source is broken or unreachable, it logs and returns
   nothing, so the run simply makes no crosswalk update today instead of failing the member sync.
7. **Transform** the API's shape into the internal schema, plus a list of crosswalk rows.
8. **Upsert members and terms**, hash-guarded — see below.
9. **Apply the crosswalk** as a plain `UPDATE` (never an insert) of rank and LIS ID. It's a separate task
   that runs strictly after step 8 has committed, so a crosswalk failure gets its own Airflow retries and
   shows up as a failed task, without ever blocking or rolling back the member sync.

## `house_votes_etl`, step by step

Runs daily. Each vote is linked to a bill, and bills are only synced when a vote first references one.
Of the ~18,000 bills in a Congress, only a few hundred ever get a House vote, and a bill nobody voted on
says nothing about a voting record, so syncing every bill up front would be wasted API calls.

1. **Determine the current Congress** from what's stored, same as the other DAGs.
2. **Page every House roll call vote** in both sessions of that Congress.
3. **Filter to what's new.** Drop votes already in `roll_calls`, purely procedural votes with no bill or
   amendment attached (e.g. "Elected Speaker"), and malformed summaries, which are logged and skipped
   rather than failing the run.
4. **Resolve each vote to a bill.** About 12% of votes reference an amendment rather than a bill
   directly, so the amendment is looked up to find the bill it amends. If that bill isn't in the
   database yet, it's synced (and embedded for [Semantic Search](/semantic-search/)) on the spot. This
   step runs sequentially on purpose: two votes in the same run can reference the same new bill, and
   processing them one at a time lets the second see the first's row instead of racing to insert it.
5. **Fetch vote details in parallel** for each vote's question (e.g. "On Passage").
6. **Sync member votes in batches of 50.** For each batch, fetch every member's position (~435 per vote)
   concurrently, then write the `roll_calls` rows and their `roll_call_member_votes` in one transaction.
   Batching caps memory: fetching every vote's full breakdown at once used to get the Airflow worker
   OOM-killed on catch-up days. Sharing one transaction means a roll call is never committed without its
   member votes, and a failed batch only costs that batch.

## `bills_etl`, step by step

Runs daily. Refresh only: it never discovers new bills (that's `house_votes_etl`'s job above). It keeps
bills already in the database current as they move through Congress: policy areas get reassigned,
subjects get added, and a new CRS summary is published at each legislative stage.

1. **Determine the current Congress.**
2. **Select bills due for a refresh**: bills in that Congress not synced in the last 7 days. Most bills
   stop changing once they pass, fail, or are vetoed, but nothing in the schema records that, so each
   bill is re-checked at most once every 7 days. That limits daily API load, at the cost of an active
   bill being up to a week behind.
3. **Refresh them, five at a time.** Each bill goes through the same shared sync function the votes DAG
   uses: fetch its details, subjects, and CRS summaries concurrently, upsert them, and re-embed it only
   if its content actually changed. Each worker uses its own database connection, and one bill's
   failure is logged and skipped rather than failing the run.

The two DAGs aren't chained together. The votes DAG never waits for a refresh, since it syncs any bill it
hasn't seen itself; a known bill's subjects being a few days stale only affects readers, not whether
votes get recorded correctly.

## Hash-guarded upserts

Members, roll calls, and bills each carry a `source_hash` of their upstream content. For members and roll
calls, the upsert compares the incoming hash to what's stored, and `updated_at` only changes if the hash
actually changed. For bills, the same hash decides whether the bill needs a new embedding for
[Semantic Search](/semantic-search/), so unchanged bills never cost a Bedrock call. On the members side,
two details make this robust rather than just "close enough":

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
- **Senior/junior senator** isn't something Congress.gov provides, and deriving it from service history
  gets the tie-breaks wrong (prior House or gubernatorial service, then alphabetical order). Rather than
  approximating, it's sourced from the congress-legislators crosswalk above, which records each
  senator's rank editorially.
- **Known upstream gaps are tracked, not papered over.** Congress.gov gives term end dates only to the
  year, which can't distinguish a member who left in March from one still serving in December. That's
  tracked as an open issue rather than guessed at.

## Testing

CI doesn't just build the container and call it done — `.github/workflows/cd-etl-tests.yml` builds the
production image, runs it against a **live** Postgres instance, polls its health endpoint, and asserts
that the `congress_members_etl` DAG is actually discoverable by Airflow. That catches an entire class of
"the image builds but doesn't actually run" failures that a build-only check would miss.

Tests run against a dedicated `congressional_app_test` database, kept separate from the seeded dev
database, so test runs and normal local development don't race each other's migrations.

## Deployment

Airflow runs as four ECS services on a single EC2 instance (scheduler, DAG processor, triggerer, API
server), all from the same `cd-etl` image. A `cd-etl-v*` tag:

1. Checks the tag matches the version in `pyproject.toml`, so a mistyped tag can't ship.
2. Builds the production image and pushes it to **GHCR**, tagged with the version and `latest`.
3. Assumes a deploy role via GitHub OIDC, with no stored AWS credentials.
4. Runs a one-shot **migrate task** and waits for it to exit cleanly. If migrations fail, the workflow
   stops before any service is touched, so nothing ever runs against a half-migrated schema.
5. Force-redeploys all four services onto the new image.

See [CI/CD & Automation](/cicd/) for how this compares to the other services' deploy paths.
