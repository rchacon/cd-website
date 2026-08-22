---
title: Architecture
description: Repo layout, the single-source-of-truth data model, and the design principles behind CivicDog.
---

## Repo layout

CivicDog is deliberately split into small, single-responsibility repos rather than one giant monorepo:

- **`cd-platform`** — a Python monorepo containing three independently versioned, independently deployed
  services: `cd-etl` (the Airflow ingestion pipeline), `cd-api` (the FastAPI service that serves
  `cd-lookup`), and `cd-server` (the app backend for `cd-webapp`). Each has its own `pyproject.toml`, its
  own README, and its own release tag pattern (`cd-etl-v*`, `cd-api-v*`, `cd-server-v*`).
- **`cd-webapp`** — the React web app at `app.civicdog.com`, the core product experience. Its own
  toolchain (npm, its own CI), entirely separate from the Python services it talks to.
- **`cd-lookup`** — a WordPress plugin, PHP, entirely separate tooling (Composer, PHPUnit, WordPress
  Coding Standards) from the Python side.
- **`cd-infra`** — Terraform only. No application code. Infra changes are reviewed and applied
  independently of app deploys.

This separation means a change to the WordPress plugin never touches Python CI, and a Terraform change
never triggers an application redeploy.

## Single source of truth: `current_members`

The data model lives in Postgres, defined by Alembic migrations in `cd-etl`:

- **`congresses`** — one row per numbered Congress, with a date range.
- **`members`** — one row per Bioguide ID: biographical identity, and a `party_history` JSONB timeline
  (members can and do change party).
- **`member_terms`** — one row per member per Congress they served in (chamber, district, term dates).
- **`current_members`** — a SQL *view* that joins the three tables above, derives "current party" via a
  `LEFT JOIN LATERAL` on the party history, and filters to whichever Congress is currently active.

Both the ETL job and the API need to agree on "what Congress is current right now." Rather than
duplicating that logic in Python and SQL and letting them drift, it's a single SQL function,
`current_congress()`, that both the ETL upsert logic and the `current_members` view call. `cd-api` never
queries the raw tables — it only ever reads from `current_members`, so the API's notion of "current" can
never diverge from the ETL's.

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
- **Defensive by default.** Hash-guarded upserts, apportionment-validated districts, and RFC 9457 error
  bodies — see [Data Pipeline](/data-pipeline/) and [API](/api/) for specifics.
