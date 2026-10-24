# WhatsApp AI Receptionist — Codex Project Workspace

**Product:** Multi-tenant WhatsApp AI receptionist for Indian appointment-based businesses  
**Initial niche:** Independent salons and beauty parlours in Bengaluru  
**Expansion:** Clinics/doctors and restaurants after validating the salon workflow; later other booking or reservation businesses  
**Status:** PLANNING — implementation 0% (as of 2026-10-22)  
**Owner workflow:** Local IDE + Codex, GitHub, phased delivery

## Purpose
Help small businesses handle inbound WhatsApp enquiries, answer FAQs, manage bookings or reservations, send compliant reminders, and hand off to a human. Start with salons; later support clinic appointments and restaurant table reservations through vertical-specific rules. Business owners manage offerings, staff, availability, and conversations through a web dashboard.

## Start here
1. Read `CODEX_INSTRUCTIONS.md` and `ROADMAP.md` completely.
2. Read `PROJECT_STATUS.md` before making changes.
3. Begin **Phase 0** only. Do not implement all phases at once.
4. Complete acceptance criteria, tests, and documentation before marking a task done.
5. Update `PROJECT_STATUS.md` after each meaningful work session.

## Local development

Requirements: Node.js 22+ and Corepack-enabled pnpm 10.

```bash
corepack pnpm install
corepack pnpm dev
```

The dashboard runs at `http://localhost:3000`; the API health endpoint is
available at `http://localhost:4000/health`.

Run the background worker in a separate terminal to process reminders and the
outbound message queue:

```bash
corepack pnpm --filter @whatsapp-receptionist/worker dev
```

Run the Phase 0 checks with:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## Documents
- `ROADMAP.md` — full product, technical, operational, and go-to-market plan
- `PROJECT_STATUS.md` — truthful live project progress, decisions, blockers, next tasks
- `CODEX_INSTRUCTIONS.md` — execution rules and starter prompt for Codex
- `CUSTOMER_DISCOVERY.md` — salon outreach, interviews, and pilot playbook

## Principles
- Meta **official WhatsApp Business Platform Cloud API** only; no unofficial WhatsApp Web automation.
- Each business owns its WhatsApp Business assets and authorizes our access.
- **AI interprets language; deterministic code validates and commits bookings.**
- Never claim an appointment is booked until the database confirms it.
- Respect WhatsApp policy, opt-in requirements, template rules, customer-service windows, privacy, and applicable Indian laws.
- All provider prices, messaging categories, and platform limits must be verified against current official documentation before launch.
- Avoid premature complexity; ship a useful vertical MVP and validate willingness to pay.
