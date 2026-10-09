---
title: Architecture
description: Repo layout, the single-source-of-truth data model, and the design principles behind CivicDog.
---

## Repo layout

CivicDog is deliberately split into small, single-responsibility repos rather than one giant monorepo:

- **`cd-platform`** — a Python monorepo containing three independently versioned, independently deployed
  services: `cd-etl` (the Airflow ingestion pipeline), `cd-api` (the FastAPI service that serves
  `cd-lookup`), and `cd-server` (the app backend for `cd-webapp`). Each has its own `pyproject.toml`, its
  own README, and its own release tag pattern (`cd-etl-v*`, `cd-api-v*`, `cd-server-v*`). Alongside them
  sits `cd-lib`, a shared library (see below).
- **`cd-webapp`** — the React web app at `app.civicdog.com`, the core product experience. Its own
  toolchain (npm, its own CI), entirely separate from the Python services it talks to.
- **`cd-lookup`** — a WordPress plugin, PHP, entirely separate tooling (Composer, PHPUnit, WordPress
  Coding Standards) from the Python side.
- **`cd-infra`** — Terraform only. No application code. Infra changes are reviewed and applied
  independently of app deploys.

This separation means a change to the WordPress plugin never touches Python CI, and a Terraform change
never triggers an application redeploy.

## Shared code without a package registry: `cd-lib`

All three Python services depend on `cd-lib`: the Pydantic and JSON:API models `cd-server` validates
`cd-api`'s responses against, the Bedrock embedding client shared by `cd-etl` and `cd-api`, and the
congressional apportionment table used to validate districts. A few deliberate choices:

- **A local path dependency, not a published package or a `uv` workspace.** Each service keeps its own
  `pyproject.toml` and lockfile and points at `../cd-lib`. No registry to run, and no shared lockfile
  coupling three independently deployed services together.
- **Only what's actually shared.** Models that only one service uses stay in that service. `cd-lib`
  isn't a dumping ground.
- **Liberal in what it accepts.** The shared models ignore unknown fields. Services deploy independently,
  so if a new `cd-api` response field broke validation in an older `cd-server`, every additive API change
  would force a lockstep deploy.
- **Editable installs only where they're safe.** The container-built services install `cd-lib` as
  editable; `cd-api`'s Lambda zip doesn't. An editable install there produces only a `.pth` file
  pointing at the build machine's checkout, not real copied files — found empirically, and it silently
  breaks the deployed zip.
- **One `cd` namespace from two places.** Each service's `cd.<service>` and `cd-lib`'s `cd.lib` are
  installed from separate locations, so no service has its own `cd/__init__.py`. That makes `cd` an
  implicit PEP 420 namespace package that merges both, rather than one hiding the other.

## Single source of truth: `current_congress()`

The data model lives in Postgres, defined by Alembic migrations in `cd-etl`:

- **`congresses`** — one row per numbered Congress, with a date range.
- **`members`** — one row per Bioguide ID: biographical identity, and a `party_history` JSONB timeline
  (members can and do change party).
- **`member_terms`** — one row per member per Congress they served in (chamber, district, term dates).
- **`bills`** / **`bill_subjects`** — bills referenced by a roll call vote, with their CRS policy area,
  legislative subjects, latest CRS summary, and a pgvector `crs_summary_embedding`.
- **`roll_calls`** / **`roll_call_member_votes`** — House roll call votes and each member's position.
- **`vocab_term_embeddings`** — one embedding per policy area / legislative subject, powering
  [Semantic Search](/semantic-search/)'s exact-match tier.
- **`current_members`** — a SQL *view* that joins `congresses`, `members`, and `member_terms`, derives
  "current party" via a `LEFT JOIN LATERAL` on the party history, filters to whichever Congress is
  currently active, and exposes whether each member is still `in_office`.

Both the ETL job and the API need to agree on "what Congress is current right now." Rather than
duplicating that logic in Python and SQL and letting them drift, it's a single SQL function,
`current_congress()`, that both the ETL and the `current_members` view call. `cd-api`'s member endpoints
never query the raw member tables. They only read `current_members`, so the API's notion of "current"
can never diverge from the ETL's. Bill search and voting records read `bills`, `roll_calls`, and their
related tables directly, since there's no "current" question to get wrong there.

## Local/prod parity

`cd-etl` ships as the same Docker image locally and in production. Locally, `make start-etl` runs it in
Docker Compose against a local Postgres. In production, the exact same image (built once, tagged, pushed
to GHCR) is pulled by a Watchtower sidecar running on the Airflow EC2 host. There's no separate
"deployment version" of the container — what you run on your laptop is what runs in AWS, which rules out
an entire class of "works locally, breaks in prod" bugs.

The container entrypoint also runs migrations automatically on every start — both Airflow's own metadata
migrations and the app's Alembic migrations — so there's no "forgot to migrate" failure mode either in
dev or in prod.

## Design principles

- **One source of truth per fact.** "What's the current Congress" lives in one SQL function, not
  scattered across services.
- **Same artifact everywhere.** Docker images are built once and promoted, never rebuilt per-environment.
- **Small, single-purpose repos.** Infra, ETL/API, the web app, and the WordPress consumer evolve and
  deploy independently.
- **Defensive by default.** Hash-guarded upserts, apportionment-validated districts, and standard error
  bodies (JSON:API error documents, RFC 9457 problem details) — see [Data Pipeline](/data-pipeline/) and [API](/api/) for specifics.
