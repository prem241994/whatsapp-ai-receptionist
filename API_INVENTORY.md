# API Inventory

This document records the current local API surface for manual testing. Playwright automation is intentionally deferred until the development workflow is complete.

## Base URLs

- API: `http://localhost:4000`
- Web: `http://localhost:3000`
- Authentication: Better Auth session cookie, normally sent with `credentials: include`

## Health and authentication

### `GET /health`

Returns API health.

Example response:

```json
{ "status": "ok", "service": "api" }
```

### `GET|POST /api/auth/*`

Better Auth catch-all route. The current frontend uses:

- `GET /api/auth/get-session`
- `POST /api/auth/sign-in/email`
- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-out`

Email sign-in body:

```json
{ "email": "owner@local.test", "password": "SalonOwner123!" }
```

## Meta webhooks

### `GET /webhooks/meta`

Meta verification handshake. Requires the query parameters `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`. The challenge is returned only when the token matches `META_WEBHOOK_VERIFY_TOKEN`.

### `POST /webhooks/meta`

Accepts signed Meta webhook payloads. Requests must include `X-Hub-Signature-256`, calculated with `META_APP_SECRET`. The current handler acknowledges valid payloads and extracts inbound message metadata (`providerEventId`, sender phone, message type, and text) without logging message content. Normalized message persistence is recorded in `webhook_events`; reply processing is a later step.

When Meta credentials are not configured locally, the endpoint returns `503 meta_webhook_not_configured`.

### `POST /v1/businesses/:businessId/dev/simulate-whatsapp`

Development-only simulator for an inbound WhatsApp text. Requires an authenticated `OWNER` or `MANAGER` session and is disabled when `NODE_ENV=production`. It creates a customer/conversation message and queues a matching FAQ or intent reply without calling Meta. Booking-intent messages receive a service-list prompt; service selection, date parsing, availability offers, explicit slot selection, and `YES` confirmation can then create a `CONFIRMED` appointment with conflict protection. Greetings and availability questions receive guided replies. Cancellation identifies the next appointment and requires `YES` before marking it `CANCELLED`. Rescheduling identifies the next appointment, offers new availability, requires `YES`, then cancels the old appointment and creates a new `CONFIRMED` appointment.

```json
{
  "senderPhone": "+919876543210",
  "text": "What are your opening hours?"
}
```

Returns `201` with the simulated provider message ID and conversation ID.

## WhatsApp connections

### `GET /v1/businesses/:businessId/whatsapp-connections`

Lists the Meta phone-number mappings configured for a business. Requires a business membership.

### `PUT /v1/businesses/:businessId/whatsapp-connections`

Requires `OWNER` or `MANAGER`. Registers or re-enables a Meta `phoneNumberId` for the business. The phone number ID must not already belong to another business.

```json
{
  "phoneNumberId": "<meta phone number id>",
  "displayPhoneNumber": "+91..."
}
```

## Tenant access

All business routes require an authenticated Better Auth session and a membership in the requested business.

### `GET /v1/me/businesses`

Returns the businesses available to the signed-in user, including membership role.

## Services

### `GET /v1/businesses/:businessId/services`

Lists services for the business.

### `POST /v1/businesses/:businessId/services`

Requires `OWNER` or `MANAGER`.

```json
{
  "name": "Haircut",
  "durationMinutes": 30,
  "priceMinor": 50000
}
```

### `PATCH /v1/businesses/:businessId/services/:id`

Requires `OWNER` or `MANAGER`. Accepts any of `name`, `durationMinutes`, `priceMinor`, and `enabled`.

### `DELETE /v1/businesses/:businessId/services/:id`

Requires `OWNER` or `MANAGER`.

## Staff

### `GET /v1/businesses/:businessId/staff`

Lists staff for the business.

### `POST /v1/businesses/:businessId/staff`

Requires `OWNER` or `MANAGER`.

```json
{ "name": "Demo Stylist" }
```

### `PATCH /v1/businesses/:businessId/staff/:id`

Requires `OWNER` or `MANAGER`. Accepts `name` and/or `enabled`.

### `DELETE /v1/businesses/:businessId/staff/:id`

Requires `OWNER` or `MANAGER`.

## Working hours

### `GET /v1/businesses/:businessId/staff/:staffId/working-hours`

Returns the staff member’s weekly working hours.

### `PUT /v1/businesses/:businessId/staff/:staffId/working-hours`

Requires `OWNER` or `MANAGER`. Replaces the weekly schedule.

```json
{
  "hours": [
    { "dayOfWeek": 1, "startTime": "10:00", "endTime": "19:00" }
  ]
}
```

`dayOfWeek` uses JavaScript convention: Sunday `0` through Saturday `6`.

## Availability

### `GET /v1/businesses/:businessId/availability`

Calculates open slots from working hours, service duration, time off, and existing appointments.

Required query parameters:

- `date=YYYY-MM-DD`
- `serviceId=<service UUID>`

Optional query parameter:

- `staffId=<staff UUID>`

Example:

`/v1/businesses/<businessId>/availability?date=2026-10-26&serviceId=<serviceId>`

## Appointments

### `GET /v1/businesses/:businessId/appointments`

Lists appointments in chronological order.

Optional query parameters:

- `from=<ISO timestamp>`
- `to=<ISO timestamp>`

### `POST /v1/businesses/:businessId/appointments`

Requires `OWNER` or `MANAGER`. Validates the selected service, staff, working hours, time off, past dates, and overlapping appointments. Creates or updates the customer by business and phone number.

```json
{
  "customerPhone": "+919999999999",
  "customerName": "Example Customer",
  "serviceId": "<service UUID>",
  "staffId": "<staff UUID>",
  "startsAt": "2026-10-26T04:30:00.000Z"
}
```

Successful creation returns `201`. A slot conflict returns `409` with `slot_unavailable`.

## Conversations

### `GET /v1/businesses/:businessId/conversations`

Returns the business’s conversations ordered by most recently active, including customer contact details and up to 50 messages per conversation.

### `POST /v1/businesses/:businessId/conversations/:conversationId/handoff`

Requires `OWNER` or `MANAGER`. Changes an open conversation to `HANDOFF`; inbound messages remain visible but no automatic FAQ reply is queued.

### `POST /v1/businesses/:businessId/conversations/:conversationId/resume`

Requires `OWNER` or `MANAGER`. Changes a handed-off conversation back to `OPEN`, allowing automatic FAQ replies again.

### `POST /v1/businesses/:businessId/conversations/:conversationId/messages`

Requires `OWNER` or `MANAGER` and a conversation in `HANDOFF` status. Queues a staff-authored outbound text message.

```json
{ "text": "Thanks, I can help you with that." }
```

## FAQs

### `GET /v1/businesses/:businessId/faqs`

Lists FAQ rules configured for a business.

### `POST /v1/businesses/:businessId/faqs`

Requires `OWNER` or `MANAGER`. FAQ keywords are matched case-insensitively against inbound text.

```json
{
  "question": "What are your hours?",
  "answer": "We are open Monday to Saturday, 10 AM to 7 PM.",
  "keywords": ["hours", "open", "timing"]
}
```

### `PATCH /v1/businesses/:businessId/faqs/:id`

Requires `OWNER` or `MANAGER`. Updates any FAQ field: `question`, `answer`, `keywords`, or `enabled`.

### `DELETE /v1/businesses/:businessId/faqs/:id`

Requires `OWNER` or `MANAGER`.

## Outbound queue

### `GET /v1/businesses/:businessId/outbound-queue`

Lists queued outbound messages for the business in creation order.

### `PATCH /v1/businesses/:businessId/outbound-queue/:id`

Requires `OWNER` or `MANAGER`. Development delivery-state update for a queued message. Allowed statuses are `SENT`, `DELIVERED`, `READ`, and `FAILED`; an optional `providerMessageId` may be supplied.

### `POST /internal/outbound-queue/process`

Internal worker trigger. Requires the `X-Worker-Secret` header matching `INTERNAL_WORKER_SECRET`. Accepts optional `{ "limit": 20 }`. It sends queued messages through the configured Meta adapter and updates each message to `SENT` or `FAILED`. Returns `503 worker_not_configured` until the internal secret is configured; it also requires `META_ACCESS_TOKEN` for delivery.

### `POST /internal/reminders/process`

Internal worker trigger. Requires the `X-Worker-Secret` header matching `INTERNAL_WORKER_SECRET`. It creates one 24-hour reminder job for each upcoming confirmed appointment that has not opted out, then queues due reminder messages in the existing outbound message queue. Accepts optional `{ "limit": 20, "horizonDays": 30 }`. It does not call Meta directly; the outbound worker remains responsible for delivery.

### `PATCH /v1/businesses/:businessId/customers/:id/consent`

Owner/manager endpoint for changing a customer’s appointment-reminder consent. Body: `{ "optedOut": true | false }`. The same state can be changed by the customer through the simulator or Meta webhook by sending `STOP`/`UNSUBSCRIBE` or `START`/`SUBSCRIBE`.

### `GET /v1/businesses/:businessId/reminder-jobs`

Authenticated tenant-scoped list of reminder jobs, including status, schedule, attempts, appointment, customer opt-out state, and any processing error.

### `GET /v1/businesses/:businessId/message-templates`

Authenticated tenant-scoped list of configured WhatsApp template metadata.

### `POST /v1/businesses/:businessId/message-templates`

Owner/manager endpoint to add template metadata. Body requires `name` and `bodyPreview`; optional fields are `language`, `category`, `providerTemplateId`, and `status`. This records Meta approval state but does not call Meta.

### `PATCH /v1/businesses/:businessId/message-templates/:id`

Owner/manager endpoint to update `bodyPreview`, `providerTemplateId`, `status`, or `enabled`, scoped to the tenant.

### `GET /health/ready`

Readiness check that verifies the API can execute a PostgreSQL query. Returns `200` with `database: ok` when ready and `503` with `database: unavailable` otherwise.

### `GET /health/live`

Liveness check that confirms the API process is responding without requiring PostgreSQL.

### `GET /internal/metrics`

Worker-secret-protected operational metrics for request count, 4xx/5xx count, and average response duration. Requires `X-Worker-Secret`; returns `503 worker_not_configured` or `401 worker_unauthorized` when unavailable or unauthorized. This local in-memory endpoint should be replaced or supplemented by a shared metrics system in production.

### `GET /v1/businesses/:businessId/audit-logs`

Authenticated tenant-scoped audit history for sensitive actions such as appointment creation and customer consent changes. Optional `limit` is capped at 200.

### `GET /internal/production-readiness`

Worker-secret-protected production configuration checklist. Requires `X-Worker-Secret`. Returns only boolean configuration checks and a `next` list of missing check names; secret values are never returned. Local development is expected to report `ready: false` until real Meta credentials and production configuration are supplied.

### Rate limiting

The API applies a configurable in-memory per-IP/per-path limit per minute using `RATE_LIMIT_GENERAL_PER_MINUTE`, `RATE_LIMIT_SIMULATOR_PER_MINUTE`, and `RATE_LIMIT_AUTH_PER_MINUTE`. Defaults are 120 general requests, 30 development simulator requests, and 20 authentication requests. Exceeded requests return `429 rate_limit_exceeded` with `Retry-After: 60`. This is a local single-process guard; production should use a shared limiter at the edge or Redis.

## Common errors

- `401 unauthenticated`: no valid Better Auth session.
- `403 business_access_denied`: the user is not a member of the requested business.
- `403 insufficient_permissions`: the membership cannot perform a write operation.
- `404`: the requested business-scoped resource does not exist.
- `409`: the requested appointment slot is unavailable.
