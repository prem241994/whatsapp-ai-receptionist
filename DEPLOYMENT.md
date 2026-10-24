# Deployment Runbook

This application has two hosted runtime processes and one database:

- `web`: Next.js owner dashboard
- `api`: Fastify API, authentication, webhook, and internal processing endpoints
- embedded scheduler: scheduled reminders and outbound queue delivery inside the API
- PostgreSQL: durable application data

## Free-tier pilot layout

For an initial pilot, use Vercel for `web`, Render for `api` and `worker`, and
Neon for PostgreSQL. The repository includes `render.yaml` for the API and
worker. Vercel can deploy the Next.js app directly from the repository with the
root build settings detected automatically. Neon supplies the `DATABASE_URL`.

Free services have limits: Render free services can sleep when idle, free
database plans have storage/compute limits, and WhatsApp usage may still incur
Meta messaging charges. Treat this as a development or early-pilot setup, not
an always-on production guarantee.

## Required production environment

Set these variables in the hosting provider's secret manager. Do not commit real
values to the repository.

```text
DATABASE_URL
BETTER_AUTH_URL
BETTER_AUTH_SECRET
INTERNAL_WORKER_SECRET
META_ACCESS_TOKEN
META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
META_PHONE_NUMBER_ID
```

Optional worker settings:

```text
API_BASE_URL=https://api.example.com
WORKER_INTERVAL_MS=30000
```

## Release order

1. Provision PostgreSQL and apply `prisma migrate deploy` from a controlled release environment. The current Render Blueprint does not run migrations during every build because Neon advisory-lock contention can fail an otherwise healthy deploy; the 12 Neon migrations for this environment are already applied.
2. Deploy the API and confirm `/health/live` returns `200`.
3. Confirm `/health/ready` returns `200` and the protected production-readiness endpoint reports `ready: true`.
4. Deploy the web app with its API base URL and Better Auth URL.
5. Confirm the API's embedded scheduler is enabled with `EMBEDDED_WORKER_ENABLED=true` and `WORKER_INTERVAL_MS`.
6. Register the Meta webhook URL as `https://api.example.com/webhooks/meta` and configure the verify token.
7. Send a test inbound message and confirm the webhook event, conversation, outbound queue, and delivery status.

## Render deployment

1. Create a Render Blueprint from this repository and select `render.yaml`.
2. Enter the Neon `DATABASE_URL`, Better Auth URL, and Meta values when Render asks for `sync: false` variables.
3. Render automatically supplies the API's HTTPS URL. The API runs the reminder and outbound scheduler when `EMBEDDED_WORKER_ENABLED=true`.
4. Confirm the API passes its health/start checks before registering the Meta webhook.

The API start command uses `apps/api/dist/src/server.js`. The standalone worker
package remains available for non-Render deployments, but is not provisioned by
the free Render Blueprint.

## Vercel web deployment

1. Import this repository into Vercel and select the `apps/web` directory as the project root.
2. Keep the framework preset as Next.js.
3. Set `NEXT_PUBLIC_API_URL` to the public API URL, for example `https://whatsapp-receptionist-api.onrender.com`.
4. Deploy the project and open the generated HTTPS URL.
5. Set `BETTER_AUTH_URL` in the API service to that Vercel URL so Better Auth callbacks and cookies use the production origin.

There is intentionally no `vercel.json`: Vercel detects the Next.js app from
the `apps/web` project root and uses the standard Next.js build command.

## Operational rules

- Run exactly one worker instance initially; add distributed locking before scaling workers horizontally.
- Keep API and worker logs enabled and retain request IDs for incident tracing.
- Use a managed/shared rate limiter before running multiple API instances.
- Run database migrations as a release step, never on every API request.
- Configure HTTPS before registering the Meta webhook.
- Rotate `INTERNAL_WORKER_SECRET`, Meta tokens, and Better Auth secrets through the hosting provider, not source control.

## Local production-readiness check

With the API running locally:

```bash
curl -H "X-Worker-Secret: $INTERNAL_WORKER_SECRET" \
  http://localhost:4000/internal/production-readiness
```

The response intentionally exposes only boolean checks and the names of missing
configuration values. Local development will remain `ready: false` until real
Meta configuration is supplied.
