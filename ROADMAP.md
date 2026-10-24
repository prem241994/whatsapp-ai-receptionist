# End-to-End Roadmap — WhatsApp AI Receptionist SaaS

**Version:** 1.0 | **Date:** 2026-10-22 | **Status:** PLANNING / 0% implementation

## 1. Vision, audience, and product boundaries
Build a multi-tenant SaaS that lets small businesses manage inbound WhatsApp enquiries, FAQs, bookings or reservations, reminders, and human handoff. Start with independently operated salons in Bengaluru and validate the workflow before expanding to clinics/doctors and restaurants. Clinics share appointment scheduling concepts but add privacy and workflow needs; restaurants require reservation concepts such as party size, table capacity, and seating duration. Implement these as explicit vertical-specific rules rather than treating every business as a salon or forcing restaurant reservations into appointment rules. Begin in Kannada + English (add Hindi/Telugu based on demand).

**North-star metric:** confirmed appointments completed through the assistant per active business per month, with low correction and failure rates.

**MVP includes:** salon onboarding (manual for pilot), service catalog, staff, working hours, slots, holidays, WhatsApp messaging, FAQ answers, booking/rescheduling/cancellation, owner dashboard, human handoff, basic reminders and operational logs. Clinic and restaurant workflows are future verticals, not MVP requirements.

**MVP excludes:** clinic/doctor and restaurant workflows until salon validation, outbound promotional broadcasts, payment collection for customer appointments, voice calls, Instagram DMs, complex CRM, franchise analytics, full omnichannel inbox, native mobile apps, automated sales campaigns, and self-service Meta Embedded Signup until justified.

**Differentiator hypothesis:** easy setup for Indian small businesses, regional-language conversations, trustworthy appointment handling, clear ROI, and transparent local pricing. Must be validated through interviews and pilots.

## 2. Recommended stack and alternatives
| Layer | Initial choice | Why / notes |
|---|---|---|
| Web dashboard | Next.js App Router, React, TypeScript, Tailwind, shadcn/ui | Familiar stack, rapid UI development |
| Backend | Node.js LTS, Fastify, TypeScript | Dedicated webhook/API runtime, typed routes |
| Validation | Zod | Runtime validation of API, webhook, AI tool outputs |
| Database | PostgreSQL | ACID bookings, constraints, tenancy |
| ORM | Prisma | Typed queries/migrations; use SQL for advanced constraints |
| Auth | Supabase Auth or Auth.js (choose one during Phase 1) | Owner/staff login, sessions |
| WhatsApp | Official Meta WhatsApp Business Platform Cloud API (Graph API) | Direct authorized messaging, webhooks |
| AI | Provider-agnostic adapter; evaluate OpenAI models | Intent extraction and FAQs, multilingual testing |
| Job processing | Start with DB outbox/cron; introduce Redis + BullMQ as volume grows | Reliable delayed reminders and retries |
| Cache/rate limits | Redis later if needed | Avoid premature infra |
| File storage | S3-compatible managed object storage (later) | Optional media/attachments |
| Hosting | Vercel for web; managed long-running Node service for API/worker; managed Postgres | Persistent webhook/worker execution |
| Monitoring | Structured logs + Sentry + uptime alerts | Trace incidents and failures |
| Analytics | SQL dashboards initially; PostHog optional | Product usage and funnel |
| Payments | Razorpay Subscriptions after pilots | INR recurring billing; verify current policies |
| Testing | Vitest, Supertest/Fastify inject, Playwright, contract tests | Unit, API, integration, E2E |
| CI/CD | GitHub Actions | lint, typecheck, tests, migration checks, deploy |
| Development | VS Code or Codex IDE, pnpm, Docker optional | Mac-friendly; no Docker requirement if using managed DB |

Use current supported Node/Next/Prisma versions when implementing. Pin dependency versions and keep lockfile. No credentials in repo.

## 3. Logical architecture
```
Customer WhatsApp
    -> Meta Cloud API -> signed/verified webhook (apps/api)
    -> normalize + deduplicate event -> durable inbound event record/queue
    -> conversation orchestrator
         -> policy & human-handoff gate
         -> deterministic FAQ or AI intent extraction
         -> booking service (availability/transaction/confirmation)
         -> outbound message outbox
    -> Meta send API -> customer

Owner/staff -> Next.js dashboard -> authenticated API -> tenant-aware Postgres
Worker -> scheduled reminders/retries -> message policy/template checks -> Meta API
Admin/ops -> audit/metrics/error alerts
```

**Crucial:** webhook handlers acknowledge quickly and process asynchronously where appropriate. Validate Meta webhook verification challenge and authenticity/signatures according to current official documentation. Do not rely on untrusted client-supplied tenant IDs.

## 4. Repository layout (target)
```
whatsapp-ai-receptionist/
  apps/
    web/               # Next.js owner dashboard
    api/               # Fastify HTTP API + Meta webhook
    worker/            # jobs/reminders (later)
  packages/
    db/                # Prisma, migrations, repositories
    shared/            # Zod schemas, domain types
    integrations/      # WhatsApp + AI provider adapters
  tests/
    integration/
    e2e/
    fixtures/
  docs/
    architecture/
    adr/
    runbooks/
  .github/workflows/
  .env.example
  README.md
  ROADMAP.md
  PROJECT_STATUS.md
  CODEX_INSTRUCTIONS.md
  CUSTOMER_DISCOVERY.md
```

## 5. Domain model and schema outline
All tenant-owned entities include `business_id` and are authorized server-side. Use UUIDs and UTC timestamps; retain business timezone (default Asia/Kolkata). Minimum entities:

- `businesses`: legal/display name, locale, timezone, status, settings.
- `users`, `memberships`: identity, role (owner/manager/staff), business scope.
- `whatsapp_connections`: WABA/phone-number identifiers, connection state, encrypted token reference, permission metadata.
- `customers`: business-scoped identity, normalized phone, consent and opt-out state.
- `services`: name, duration, price, buffers, enabled status.
- `staff`, `staff_services`, `working_hours`, `time_off`: scheduling configuration.
- `appointments`: customer, staff, service, start/end UTC, status, source, audit timestamps.
- `conversations`, `messages`: business-scoped inbound/outbound metadata, status, optional redacted content.
- `webhook_events`: provider event ID, dedupe key, payload metadata, processing state.
- `message_outbox`: payload reference, category/template, idempotency key, retry state.
- `consent_events`, `audit_events`: proof of consent and material changes.
- `subscriptions`, `usage_records`: billing plan, message/AI usage and limits (later).

### Booking integrity
- Generate availability from staff schedule + service duration/buffers + time off + existing appointments.
- Use transactions and DB-enforced non-overlap (e.g. PostgreSQL exclusion constraints on active appointment ranges per staff, where appropriate).
- Handle concurrent bookings, retries, duplicates, daylight/timezone conversions, walk-ins and manual overrides.
- Booking states: `requested -> offered -> pending_confirmation -> confirmed -> completed`, with `cancelled`, `expired`, `no_show` as applicable.
- Never claim confirmation until durable commit succeeds.

## 6. API and events outline
Owner APIs (authenticated, tenant-scoped):
- `POST /auth/...` via chosen auth provider
- `GET/PATCH /business`, `GET/POST/PATCH /services`, `/staff`, `/availability-rules`
- `GET /availability?serviceId&date&staffId`
- `POST /appointments`, `PATCH /appointments/:id`, `GET /appointments`
- `GET /conversations`, `POST /conversations/:id/handoff`, `POST /conversations/:id/resume`
- `GET /metrics`, `GET /usage`, `GET /settings`
- `GET /health`, `GET /ready` (appropriate protection for diagnostics)

Provider callbacks:
- `GET /webhooks/meta` (verification handshake)
- `POST /webhooks/meta` (message/status events, verification and deduplication)

Version API (`/v1`) as needed. Use OpenAPI docs, Zod schemas, pagination, consistent errors and rate limits. No unauthenticated tenant data endpoints.

## 7. WhatsApp Cloud API integration plan
1. Register Meta developer account and app; enable WhatsApp product, obtain test sender and recipient configuration.
2. Test sending a permitted message with temporary token and documented API version.
3. Expose local HTTPS webhook via approved development tunnel; verify challenge and signatures.
4. Normalize inbound text, interactive replies, delivery/read statuses; dedupe retries.
5. Implement send adapter with retries/backoff, rate limits, observability, token rotation and dead-letter handling.
6. Store provider IDs, timestamps, delivery status, conversation/service-window context and required template metadata.
7. Define utility reminder/confirmation templates and submit for approval where required; do not assume free-form messages outside service window are permitted.
8. For production: business portfolio/WABA setup, appropriate permissions, phone number onboarding, approved business identity, payment method and compliance checks per current Meta docs.
9. For multiple businesses: design account connection and credential isolation. Start with **manual assisted onboarding**; add Embedded Signup only after eligibility and app review are understood.
10. Confirm how a salon's existing WhatsApp Business App number can coexist or migrate using current Meta guidance; never promise a frictionless migration.

**Costs:** Cloud API access itself may not have a platform subscription, but messaging is charged by current category/country/rules, and BSP/hosting fees may apply. Verify official current rate cards and policy before pricing. Do not embed unverified INR rates in code or business assumptions.

## 8. AI design and guardrails
- Start with deterministic menus/FAQ and a typed AI intent extractor, not an unrestricted autonomous agent.
- Supported intents: greet, list_services, get_price, business_hours, check_availability, book, confirm, cancel, reschedule, request_human, unknown.
- Use Zod-validated structured output: intent, locale, service/staff, date/time preference, confidence, missing fields.
- Store business-approved knowledge (services, pricing, hours, policies). Never invent prices, promotions or availability.
- On ambiguity or low confidence, ask clarifying questions; on repeated failure, escalate to staff.
- Language tests: Kannada script, English, code-mixed Kannada-English, transliterated Kannada, common spelling variants.
- Never pass secrets or unnecessary personal data to model providers; configure retention and provider terms deliberately.
- AI may **request** an action, but only domain services can confirm and commit a booking.
- Prompt-injection defense: customer messages are untrusted; tools expose narrow, permissioned operations.
- Cost controls: small model first, bounded context, per-business usage limits, token accounting, caching approved FAQs where safe.

## 9. Owner dashboard screens
1. Login / business selection.
2. Today view: appointments, upcoming reminders, conversations requiring action.
3. Calendar: day/week, create/edit/cancel booking, block slots.
4. Services and prices, staff schedules and holidays.
5. WhatsApp connection status and templates.
6. Inbox: customer conversations, pause bot, human takeover, resume.
7. AI settings: language, FAQs, escalation rules, business voice.
8. Metrics: enquiries, response time, bookings, handoffs, no-shows.
9. Billing/usage and business settings (later).

Mobile-responsive web dashboard first; native apps later only if needed.

## 10. Phased build plan and acceptance gates

### Phase 0 — Foundation (target: 1 week; NOT STARTED)
- [ ] Create GitHub repo and pnpm monorepo.
- [ ] Scaffold Next.js web, Fastify API, shared package.
- [ ] Configure TypeScript strict, ESLint, Prettier, Vitest, basic Playwright.
- [ ] Local Postgres (Docker or managed dev DB), `.env.example`, secrets handling.
- [ ] GitHub Actions lint/typecheck/test and README developer setup.
**Exit:** fresh checkout runs locally; CI green; health endpoint and starter dashboard load.

### Phase 1 — Business model, auth and database (1–2 weeks; NOT STARTED)
- [ ] Prisma schema and migrations for business, membership, services, staff, schedules, customers, appointments.
- [ ] Authentication and role-based tenant authorization; tests for cross-tenant access.
- [ ] Service/staff/schedule CRUD; seed demo salon.
- [ ] Implement transactional booking and overlap constraints with concurrency tests.
**Exit:** two demo salons remain isolated; no double booking under simultaneous requests.

### Phase 2 — Meta sandbox integration (1 week; NOT STARTED)
- [ ] Create Meta test app/number (requires owner action).
- [ ] Verify webhook GET and signed POST events.
- [ ] Implement inbound event dedupe and outbound send adapter.
- [ ] Handle error/retry/delivery statuses; test with Meta sandbox.
**Exit:** test number can receive and reply; duplicate webhook does not duplicate actions.

### Phase 3 — End-to-end booking + dashboard (1–2 weeks; NOT STARTED)
- [ ] Implement conversation state machine and non-AI booking flow.
- [ ] Ask service/date/staff, offer available slots, request confirmation, commit appointment.
- [ ] Build owner calendar and basic conversation inbox.
- [ ] Add cancel/reschedule and manual override.
**Exit:** complete booking works via WhatsApp test number; dashboard reflects booking; conflicts handled.

### Phase 4 — AI receptionist (1–2 weeks; NOT STARTED)
- [ ] AI provider interface and structured intent extraction.
- [ ] Ground answers in business-approved FAQ/service data.
- [ ] Support Kannada, English, code-mixed inputs; evaluate real samples.
- [ ] Add low-confidence fallback and human handoff.
- [ ] Add per-business model usage caps and safe logging.
**Exit:** defined test set meets agreed accuracy/cost thresholds; no hallucinated bookings.

### Phase 5 — Reminders and compliance (1 week; NOT STARTED)
- [ ] Durable message outbox, scheduled jobs and idempotent retries.
- [ ] Approved templates and message-window enforcement.
- [ ] Consent tracking, opt-out handling and retention/deletion controls.
- [ ] Failed delivery and retry visibility.
**Exit:** reminders send only when permitted, once per event, with audit trail.

### Phase 6 — Pilot readiness and hardening (1–2 weeks; NOT STARTED)
- [ ] Security review, RBAC, webhook authenticity, rate limits, secret rotation.
- [ ] Data minimization, backups, restore drill, incident runbooks, error monitoring.
- [ ] Load tests and chaos cases: Meta outage, model timeout, DB conflict, duplicate events.
- [ ] Owner training, bot pause/handoff, pilot feedback collection.
**Exit:** pilot readiness checklist signed off; no critical security or booking defects.

### Phase 7 — Production onboarding and billing (2–4+ weeks; NOT STARTED)
- [ ] Verify Meta business setup, permissions, app review and phone-number connection requirements.
- [ ] Assisted onboarding for 1–3 businesses; validate number migration/coexistence.
- [ ] Production hosting, domain, TLS, alerts, backups, data agreements and privacy notice.
- [ ] Measure actual unit costs, define plan quotas, integrate Razorpay only after willingness to pay.
- [ ] Meter usage, enforce quotas, handle payment failures and subscription cancellations.
**Exit:** real consented customer conversations work, owner can operate independently, costs tracked.

### Phase 8 — Validate sales and expand (ongoing; NOT STARTED)
- [ ] Interview 10–15 owners; 2–3 pilot businesses; at least 2 willingness-to-pay signals.
- [ ] Measure conversion, retention, failed bookings, message and AI costs, support time.
- [ ] Improve onboarding and ROI reporting.
- [ ] Expand languages and adjacent verticals only after retention is established.
**Exit:** evidence of repeat usage, paying customers and positive contribution margin.

**Timeline:** ~10–16+ weeks for a credible pilot/initial release depending on approvals, solo development time, and external dependencies; phases may overlap. Do not treat estimates as deadlines.

## 11. Test strategy and release gates
- **Unit:** time parsing, duration/buffers, slot generation, intent validation, business policies.
- **Integration:** Postgres constraints, transactions, tenant isolation, provider adapter mocks, outbox.
- **Contract:** Meta webhook payload variants, Graph API errors, AI structured outputs.
- **E2E:** Playwright dashboard login, service setup, booking calendar, human handoff; simulated webhook to booking.
- **Security:** IDOR/cross-tenant, auth, webhook signatures, replay, prompt injection, secrets leakage, rate limits.
- **Reliability:** duplicate events, concurrent bookings, retries, crash/restart, provider outages, timezone edge cases.
- **Language QA:** consented synthetic/real-world Kannada-English examples, accuracy and fallback metrics.
- **CI:** PR checks + migration safety + dependency scanning; deploy to staging, then manually approve production.

Do not test by sending messages to unconsenting real phone numbers. Use Meta's approved sandbox and test recipients.

## 12. Security, privacy, and operational requirements
- Encrypt credentials at rest, use secret manager, least-privilege roles, rotate tokens.
- Verify Meta webhook authenticity and validate inbound payloads; avoid logging message bodies by default.
- Encrypt transport, segregate tenants in API and DB queries, optionally use Postgres RLS as defense-in-depth.
- Provide human handoff and a clear indication of automation where appropriate.
- Collect only necessary customer information; document purposes, consent, retention, deletion, access requests, backups.
- Review India's Digital Personal Data Protection framework and applicable rules with qualified counsel before processing real customer data; check current effective provisions.
- Business continuity: DB backups/restore, provider outage fallback, message retry limits, alert thresholds, incident ownership.
- Terms of service, privacy policy, subprocessor disclosure, support channels, cancellation/export policy before paid launch.

## 13. Costs, pricing, and unit economics
Track monthly costs per business: Meta messaging by category/region, AI input/output tokens, hosting, DB, job execution, monitoring, payment processing, customer support, onboarding and taxes.

**Proposed experimental plans (not market-validated):** Starter ₹499, Growth ₹999, Business ₹1,999 per month, with capped included usage and overage policy. A limited founding-customer pilot can be free or discounted with explicit expiry. Never promise unlimited messaging or AI.

Contribution margin = subscription revenue (net of applicable taxes/refunds) − direct variable delivery costs. Also track CAC, churn, LTV and onboarding time. Recheck official Meta pricing, API policies, AI provider rates and GST implications before publishing.

## 14. Customer acquisition and success metrics
See `CUSTOMER_DISCOVERY.md`. Start with owner interviews rather than bulk marketing. Use public business contact channels, short calls and opt-in demos. Focus on a narrow segment, track interview evidence, and pilot with owners who actively experience missed bookings.

**Product metrics:** inbound enquiries, median first-response time, booking completion rate, reschedule success, failed/duplicate booking count (target zero), human handoff rate, no-show rate, weekly active businesses, owner-reported time saved.

**Commercial metrics:** interview-to-pilot conversion, pilot-to-paid conversion, active paying businesses, MRR, churn, gross/contribution margin, support hours per account.

## 15. Major risks and mitigation
| Risk | Mitigation |
|---|---|
| Meta policies/pricing/onboarding change | Use official docs, versioned adapter, verify before each release |
| Salon cannot use existing number as assumed | Validate phone-number coexistence/migration early with pilot owner |
| AI invents appointment or price | Tool-limited structured intent + authoritative backend + confirmation |
| Double bookings | Database constraints + transactions + concurrency tests |
| Cross-tenant customer data leak | Business-scoped auth, tests, defense-in-depth isolation |
| Message charges exceed subscription | Usage metering, quotas, plan limits, per-tenant alerts |
| Customers prefer phone calls/walk-ins | Interview before building; measure WhatsApp enquiry volume |
| Salon owners distrust AI | Human handoff, transparent audit trail, easy pause, narrow automation |
| Sales and onboarding cost too high | Standardize one vertical and assisted onboarding playbook |
| WhatsApp outages or API limits | Queues, retries, fallback, alerts, no false booking confirmation |

## 16. Roadmap beyond MVP (only after traction)
- More languages and localized booking workflows.
- Self-service Meta Embedded Signup and subscription onboarding.
- Multi-location/multi-staff scheduling and Google Calendar synchronization.
- Deposits/payments for appointments, no-show mitigation.
- Customer rebooking suggestions with appropriate opt-in and template compliance.
- Voice-note transcription, images/catalogues, richer analytics.
- Additional verticals: gyms, tutors, car services, home services.
- Optional channel integrations only after core retention.

## 17. Official docs to consult during implementation
- Meta WhatsApp Cloud API: https://developers.facebook.com/docs/whatsapp/cloud-api/
- WhatsApp Business Platform pricing: https://developers.facebook.com/docs/whatsapp/pricing/
- Meta webhooks: https://developers.facebook.com/docs/graph-api/webhooks/
- Next.js: https://nextjs.org/docs
- Fastify: https://fastify.dev/docs/latest/
- Prisma: https://www.prisma.io/docs
- PostgreSQL: https://www.postgresql.org/docs/
- Playwright: https://playwright.dev/docs/intro
- Razorpay: https://razorpay.com/docs/

Documentation and pricing can change. Codex should verify current official versions and requirements rather than trusting static examples.

## 18. Execution and status discipline
The `PROJECT_STATUS.md` file is the single source of truth for implementation status. Codex must update it after each completed task, with actual test evidence. Never mark a phase complete because files exist; demonstrate acceptance criteria. Keep a dated changelog and track blockers. Begin with Phase 0 and request approval before Phase 1.
