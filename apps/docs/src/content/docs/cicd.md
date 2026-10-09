---
title: CI/CD & Automation
description: Keyless deploys, container automation, and infrastructure scanning across the CivicDog stack.
---

Every CivicDog component has its own deploy path, each shaped by what that component actually needs,
rather than one generic pipeline forced onto everything: a Lambda zip, two container rollouts with
different downtime trade-offs, static sites on Amplify, and a WordPress plugin release.

## Keyless deploys via GitHub OIDC

No repo stores long-lived AWS credentials. Instead, GitHub Actions authenticates via OpenID Connect and
assumes a narrowly-scoped IAM role for the duration of the job, via `aws-actions/configure-aws-credentials`.

There's one deploy role per service (`cd-api`, `cd-etl`, `cd-server`), each granted only what its own
deploy needs. The `cd-api` deploy role, for example, is scoped tightly to
`repo:.../cd-platform:ref:refs/tags/cd-api-v*` — it can only be assumed by a workflow run triggered from
that exact tag pattern, in that exact repo.

**A real-world gotcha, fixed:** GitHub rolled out an *immutable* OIDC `sub` claim format for repos created
after a certain date, which required embedding numeric owner/repo IDs into the trust policy condition —
not just the repo name — for the role assumption to keep working. This shipped as a small, well-scoped fix
once it was hit, rather than a rewrite of the trust policy from scratch.

## Deploy paths

All three Python services release on a version tag (`cd-api-v*`, `cd-etl-v*`, `cd-server-v*`), and every
deploy workflow first checks that the tag matches the version in that service's `pyproject.toml`. The
same check runs in an optional local pre-push hook, so a mismatch is usually caught before CI.

**`cd-api` (Lambda):** builds a Lambda deployment zip with `uv`, checks it against Lambda's 50MB
direct-upload limit, and calls `aws lambda update-function-code` followed by
`aws lambda wait function-updated`. The same workflow exports the OpenAPI spec to S3, which powers the
[API reference](/api/).

**`cd-etl` (Airflow on ECS):** builds the image and pushes it to **GHCR**, then runs a one-shot migrate
task and waits for a clean exit before force-redeploying the four Airflow services. These services
deploy *stop-then-start*: Airflow runs on a single instance where the API server's fixed host port can't
be bound twice, so ECS's default of starting the new task alongside the old one would never finish. A
brief gap is fine for a scheduled batch system with no live request traffic.

**`cd-server` (app backend on ECS):** same build-and-migrate shape, but this one serves live traffic
behind an ALB, so it deploys **zero-downtime**:

- Migrations run only in the dedicated migrate task, never in the app containers' startup. That's what
  makes it safe to run old and new tasks side by side, and a Postgres advisory lock backs it up.
- Rolling deploys keep 100% of capacity healthy and start new tasks alongside old ones.
- A deployment circuit breaker automatically rolls back to the last good task definition if new tasks
  keep failing to start. The old task keeps serving the whole time, so even a failed deploy causes no
  downtime.
- Migrations must be expand/contract, since old code briefly runs against the new schema.

It didn't start this way. The first version deployed stop-then-start, with migrations in every task's
entrypoint, and each release caused a ~6-minute 503 window. Splitting migrations out is what made
rolling deploys possible.

**`cd-webapp`, `civicdog.com`, and this docs site (AWS Amplify):** each is an Amplify app, provisioned
in Terraform, that builds and deploys on every push to `main`. Pull requests run tests, a production
build, and lint (`cd-webapp`) before anything merges.

**`cd-lookup` (WordPress plugin):** a `v*` tag zips the production files only (explicitly excluding
dev-only files like `DEVELOPMENT.md`) and publishes a GitHub Release via `gh release create --generate-notes`
— a standard installable WordPress plugin artifact, no AWS involved at all.

**`cd-lib` (shared library):** never deployed on its own. Each service bundles it at build time, and it
has its own test workflow on every pull request.

## Automated bootstrapping, not manual setup steps

The Airflow ECS container instance boots the ECS-optimized AMI, so Docker and the ECS agent come
preinstalled. Its user-data script only joins the cluster, then pulls secrets from Secrets Manager via
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
