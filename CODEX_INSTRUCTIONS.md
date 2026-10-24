# Codex Execution Instructions

## Initial prompt to paste into Codex

> Read README.md, ROADMAP.md, PROJECT_STATUS.md, and CUSTOMER_DISCOVERY.md in full. This is a greenfield multi-tenant WhatsApp AI Receptionist SaaS. Implement **Phase 0 only**, beginning with repository setup, documentation, a minimal Next.js + TypeScript application, lint/format/typecheck/test tooling, environment-variable examples, and CI skeleton. Do not add live WhatsApp, OpenAI, or payment credentials. Make small, reviewable changes. Run available checks, document what you verified, and update PROJECT_STATUS.md with completed work, evidence, blockers, and next steps. Stop after Phase 0 and ask for review before proceeding to Phase 1.

## Rules for every session
1. Inspect the repository and `PROJECT_STATUS.md` before planning edits.
2. Select the next **unblocked** task in the current phase; describe the intended change.
3. Prefer a small vertical slice with tests over scaffolding many unimplemented modules.
4. Do not mark tasks complete without verifying the acceptance criteria.
5. Record commands run, tests passing/failing, decisions, and actual files changed.
6. Update `PROJECT_STATUS.md`: current phase, completed checklist, blockers, next three actions, dated changelog.
7. Stop and request user input for Meta app ownership, credentials, paid services, irreversible migrations, public deployments, or outreach.
8. Never commit secrets, personal customer data, or production message content to Git.
9. Do not send real customer WhatsApp messages or contact salons without explicit user approval.
10. Follow provider terms and current official docs; don't invent APIs or price assumptions.
11. The owner knows TypeScript and database technology but is learning the broader product stack. Before each phase or major vertical slice, explain the concepts, intended outcome, and how the pieces fit together. Afterward, summarize files changed, verification, practical meaning, and update `PROJECT_STATUS.md`.

## Architecture conventions
- Monorepo using pnpm workspaces (Turborepo optional; add only if useful).
- `apps/web`: Next.js + TypeScript dashboard, auth and admin UI.
- `apps/api`: Fastify + TypeScript, REST endpoints, Meta webhook, booking orchestration.
- `apps/worker`: background reminders, retries and outbox processing (introduce after MVP core).
- `packages/db`: Prisma schema, migrations and tenant-aware repositories.
- `packages/shared`: Zod schemas, shared domain types, business errors.
- `packages/integrations`: WhatsApp and AI provider adapters behind interfaces.
- `tests`: contract, integration, Playwright end-to-end, fixtures.
- PostgreSQL as system of record; Redis/BullMQ only when needed for jobs.
- Supabase can provide managed Postgres/Auth; validate authorization on API server regardless.
- No dependency on browser automation for WhatsApp messaging.

## Definition of Done
- Feature works end to end in the targeted environment.
- Automated tests cover normal, invalid, duplicate, unauthorized and failure cases.
- Tenant isolation and security checks pass where relevant.
- Logs are safe, traceable and do not leak secrets or sensitive messages.
- Documentation, env examples and project status are current.
- No unverified claims of production readiness.

## Engineering priorities
Correctness > security/privacy > reliability > observability > user experience > optimization.
Use deterministic booking state transitions and idempotency. AI must not execute arbitrary database mutations or hallucinate availability. Require explicit customer confirmation before booking. Support human handoff.
