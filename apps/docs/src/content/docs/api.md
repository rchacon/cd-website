---
title: API
description: cd-api's design — endpoints, error handling, and serverless deployment on AWS Lambda.
---

`cd-api` is a small FastAPI service with one real job: serve `current_members` over HTTP for `cd-lookup`
to consume. It's wrapped with **Mangum** and deployed as an AWS Lambda function behind API Gateway — there's
no long-running server to patch or scale.

For the endpoint list and schema reference, see [API Reference](/api-reference/) — generated
directly from cd-api's OpenAPI schema, so it can't drift from what's actually deployed.

## Error handling: RFC 9457, not ad hoc JSON

Errors are returned as `application/problem+json`, per [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
("Problem Details for HTTP APIs"), instead of a bespoke `{ "error": "..." }` shape. That means every error
response is self-describing and machine-parseable in a standard way, not something a client has to guess
at from reading the source.

## A real 404 vs. a genuine vacancy

This is the detail that's easy to get wrong: not every "no representative found" is an error.

- **Unknown state** → `404`.
- **District number that doesn't exist** for that state → `404`, validated against real U.S. House
  apportionment data (`apportionment.py`) — so a typo'd district number fails clearly instead of silently
  returning nothing.
- **District that exists but is currently vacant** → `200` with an empty list. A vacancy is a true,
  valid state, not an error.

Collapsing these into one generic "not found" would make the API lie about which case actually happened.

## Deployment

- **Lambda + RDS Proxy.** Lambda's connection model (many short-lived invocations) doesn't play well with
  Postgres's per-connection overhead, so `cd-api` connects through RDS Proxy rather than directly to RDS.
- **Tag-triggered deploys.** A `cd-api-v*` tag triggers `cd-api-deploy.yml`, which builds a Lambda zip with
  `uv`, checks it against Lambda's 50MB limit, and calls `aws lambda update-function-code`.
- **Keyless CI.** The deploy workflow assumes an IAM role via GitHub OIDC — no static AWS credentials
  stored in GitHub. More on this in [CI/CD & Automation](/cicd/).
- **OpenAPI spec, exported on every deploy.** The same workflow calls FastAPI's `app.openapi()` to
  generate `openapi.json` and pushes it to a small public S3 bucket, which is what powers the
  [API Reference](/api-reference/) page — no separate step to remember, no risk of the published
  schema falling behind a deploy. API Gateway requires an API key on every route (including a live
  `/openapi.json`), so publishing a static export to S3 is what makes an unauthenticated reference
  page possible at all.
