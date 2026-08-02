---
title: CI/CD & Automation
description: Keyless deploys, container automation, and infrastructure scanning across the CivicDog stack.
---

CivicDog has three separate deploy paths — one per service — each shaped by what that service actually
needs, rather than one generic pipeline forced onto everything.

## Keyless deploys via GitHub OIDC

No repo stores long-lived AWS credentials. Instead, GitHub Actions authenticates via OpenID Connect and
assumes a narrowly-scoped IAM role for the duration of the job, via `aws-actions/configure-aws-credentials`.

The `cd-api` deploy role, for example, is scoped tightly to
`repo:.../cd-platform:ref:refs/tags/cd-api-v*` — it can only be assumed by a workflow run triggered from
that exact tag pattern, in that exact repo.

**A real-world gotcha, fixed:** GitHub rolled out an *immutable* OIDC `sub` claim format for repos created
after a certain date, which required embedding numeric owner/repo IDs into the trust policy condition —
not just the repo name — for the role assumption to keep working. This shipped as a small, well-scoped fix
once it was hit, rather than a rewrite of the trust policy from scratch.

## Two very different deploy shapes

**`cd-api` (Lambda):** a `cd-api-v*` tag builds a Lambda deployment zip with `uv`, checks it against
Lambda's 50MB limit, and calls `aws lambda update-function-code` followed by
`aws lambda wait function-updated`. This path *does* touch AWS directly, via the OIDC-assumed role above.

**`cd-etl` (Airflow container):** a `cd-etl-v*` tag builds a Docker image and pushes it to **GHCR** — not
ECR. That's deliberate: a **Watchtower** sidecar running on the Airflow EC2 host polls GHCR for new images
and pulls/restarts automatically. This path never touches AWS credentials at all, because it doesn't need
to — self-healing container deploys instead of a push-based pipeline.

**`cd-lookup` (WordPress plugin):** a `v*` tag zips the production files only (explicitly excluding
dev-only files like `DEVELOPMENT.md`) and publishes a GitHub Release via `gh release create --generate-notes`
— a standard installable WordPress plugin artifact, no AWS involved at all.

## Automated bootstrapping, not manual setup steps

The Airflow EC2 instance's user-data script installs Docker/Compose, pulls secrets from Secrets Manager via
the instance's own IAM role (zero static credentials baked into the image), and idempotently bootstraps
the `airflow_metadata` database and a least-privilege `cd_etl_app` Postgres role — safe to re-run on every
reboot. RDS has no equivalent to `docker-entrypoint-initdb.d`, so this fills that specific gap.

## Every infra change is scanned before merge

`cd-infra`'s CI runs on every pull request, not just before a release:

- `terraform fmt -check -recursive`
- `terraform validate` per directory (auto-discovers new `terraform/*` modules)
- A **Trivy** IaC security scan, which fails the build on HIGH/CRITICAL findings

`terraform apply` itself stays a manual, human-run step — CI's job is to catch problems before a human
ever runs it.
