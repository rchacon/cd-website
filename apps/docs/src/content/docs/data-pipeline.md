---
title: Data Pipeline
description: How cd-etl's Airflow DAGs keep congressional members, bills, votes, and embeddings in sync with Congress.gov, and how they validate what comes in.
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

## Data validation at ingestion

Upstream data is treated as untrusted. Congress.gov is the official source, but its responses still
have missing fields, quirks between endpoints, and the occasional degraded reply. Validation happens in
four layers, each catching what the one before it can't.

### 1. Schema validation at the API boundary

Every Congress.gov response is parsed into a **Pydantic model** the moment it arrives
(`cd/etl/models/congress_gov.py`, one model per endpoint shape), and senate.gov's roll-call XML, read by the
upcoming Senate votes DAG, gets its own models (`models/senate_gov.py`). A missing or wrongly typed field raises one clear
`ValidationError` naming the field, right at the call site, instead of an obscure `KeyError` several
functions later in a transform. Models map Congress.gov's camelCase onto snake_case fields
automatically, so the wire format never leaks into the pipeline's code.

### 2. Normalization while parsing

Some upstream quirks are fixed inside the model, so every caller gets the corrected value:

- **At-large districts.** Congress.gov's member-detail endpoint omits `district` entirely for at-large
  House seats, while its list endpoint returns `0`. The `Term` model treats a missing House district as
  `0` (at-large), and always clears the district on Senate terms, whatever the source sends.
- **Party history order.** `partyHistory` is sorted by start year before it's stored or hashed, since
  the API doesn't guarantee its order.
- **Congress end dates** are derived from the first session's start date, not taken from the API's
  off-by-one `endYear` (see [Hash-guarded upserts](#hash-guarded-upserts)).

### 3. Record-level checks: skip and count, don't fail the run

One malformed record shouldn't block every good one, so each DAG validates **per record**, logs what it
drops, and keeps going:

- **Malformed members and votes** (a `KeyError`, `TypeError` or `ValidationError` while transforming
  one) are logged and skipped individually.
- **House votes are skipped, and counted by reason**, when they can't be stored correctly:
  - the vote's detail couldn't be fetched (`missing_detail`)
  - its member-by-member breakdown couldn't be fetched (`missing_member_votes`)
  - none of its votes cast survived validation (`zero_valid_casts`)

  A roll call is never stored without real votes. An empty one would look "already synced" forever,
  with no way to backfill it later.
- **Votes by unknown members are dropped, not inserted.** `roll_call_member_votes` has a foreign key to
  `members`, and a single unknown `bioguide_id` would otherwise fail the whole batch insert. These are
  counted too (`dropped_unknown_bioguide`).
- **Purely procedural votes** with no bill or amendment attached (e.g. "Elected Speaker") are filtered
  out before anything is fetched.
- **A broken secondary source degrades, it doesn't fail.** If the congress-legislators crosswalk is
  unreachable or malformed, that day's run makes no crosswalk update. If a bill's `/summaries` call
  fails, that sync stores no new CRS summary. Only the data a row can't exist without (a bill's details
  and subjects) is allowed to fail its sync.

### 4. Never overwrite good data with a bad response

`bills_etl` re-syncs the same bills over and over, so a single degraded response must not erase data
that was correct yesterday:

- **Bill upserts use `COALESCE`** against the stored row. A missing title, policy area or CRS summary in
  today's response keeps the stored value instead of nulling it out.
- **An empty subjects list doesn't wipe a bill's subjects.** A bill losing every subject at once is far
  more likely to be a bad response than a real change, so the subject replace is skipped entirely when
  the fetched list is empty.
- **The CRS summary chosen is the latest one with actual text.** Summaries with null or empty text are
  ignored, rather than picking the newest entry and storing nothing.

### Backstop: constraints in Postgres

Anything that gets past the pipeline's own checks still has to satisfy the schema (Alembic migrations in
`cd-etl/migrations/`): typed columns, `NOT NULL`s, unique keys, and foreign keys tying
`roll_call_member_votes` to `roll_calls` and `members`, and `roll_calls` to `bills`. That last key is on
`(bill_id, congress)`, so a roll call can't point at a bill from a different Congress. `CHECK` constraints
encode domain rules too:

- `congress > 0`, `bill_number > 0`, and `session IN (1, 2)`
- a Congress's `end_date` falls after its `start_date`, and a term's `end_year` is no earlier than its
  `start_year`
- a member's `death_year` is no earlier than their `birth_year`
- a House term has a district of `0` or more, and a Senate term has none

So a bug in a transform fails loudly at write time instead of quietly storing an impossible row.

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
