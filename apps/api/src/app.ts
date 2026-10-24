import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  AppointmentStatus,
  ConversationStatus,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { Readable } from 'node:stream';
import { db } from '@whatsapp-receptionist/db';
import {
  createServiceRepository,
  createStaffRepository,
  getMembership,
} from '@whatsapp-receptionist/db';
import { auth } from './auth.js';
import { processOutboundQueue } from './outbound-queue.js';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import { createConfiguredIntentProvider } from './intent-provider.js';
import {
  processReminderQueue,
  scheduleAppointmentReminders,
} from './reminders.js';

type AppOptions = {
  resolveUserId?: (request: {
    headers: Record<string, unknown>;
  }) => Promise<string | null>;
};

const unavailableAppointmentStatuses: AppointmentStatus[] = [
  AppointmentStatus.REQUESTED,
  AppointmentStatus.OFFERED,
  AppointmentStatus.PENDING_CONFIRMATION,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.COMPLETED,
];

// Reloaded from the local environment so Ollama can be enabled without changing booking rules.
const intentProvider = createConfiguredIntentProvider();

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();
const metrics = {
  requests: 0,
  responses4xx: 0,
  responses5xx: 0,
  totalDurationMs: 0,
};

function localDateTimeToUtc(
  date: string,
  time: string,
  timezone: string,
): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const candidate = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(candidate));
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  const timezoneAsUtc = Date.UTC(
    values.year ?? 0,
    (values.month ?? 1) - 1,
    values.day ?? 1,
    values.hour ?? 0,
    values.minute ?? 0,
  );
  return new Date(candidate - (timezoneAsUtc - candidate));
}

function isValidDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

function minutesFromTime(value: string) {
  const [hour = 0, minute = 0] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function localParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: partValue }) => [type, partValue]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

async function findAvailabilitySlots(
  businessId: string,
  date: string,
  serviceId: string,
) {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const service = await db.service.findFirst({
    where: { id: serviceId, businessId, enabled: true },
    select: { id: true, name: true, durationMinutes: true },
  });
  if (!business || !service) return null;
  const dayStart = localDateTimeToUtc(date, '00:00', business.timezone);
  const nextDate = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const staff = await db.staff.findMany({
    where: { businessId, enabled: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const slots: Array<{
    staffId: string;
    staffName: string;
    startAt: string;
    endAt: string;
  }> = [];
  for (const member of staff) {
    const [workingHours, timeOff, appointments] = await Promise.all([
      db.workingHour.findMany({ where: { staffId: member.id, dayOfWeek } }),
      db.timeOff.findMany({
        where: {
          staffId: member.id,
          startsAt: { lt: nextDate },
          endsAt: { gt: dayStart },
        },
      }),
      db.appointment.findMany({
        where: {
          staffId: member.id,
          startsAt: { lt: nextDate },
          endsAt: { gt: dayStart },
          status: { in: unavailableAppointmentStatuses },
        },
        select: { startsAt: true, endsAt: true },
      }),
    ]);
    for (const hours of workingHours) {
      const startMinutes = minutesFromTime(hours.startTime);
      const endMinutes = minutesFromTime(hours.endTime);
      for (
        let start = startMinutes;
        start + service.durationMinutes <= endMinutes;
        start += 30
      ) {
        const startAt = localDateTimeToUtc(
          date,
          `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
          business.timezone,
        );
        const endAt = new Date(
          startAt.getTime() + service.durationMinutes * 60 * 1000,
        );
        const overlaps = [...timeOff, ...appointments].some(
          (blocked) => startAt < blocked.endsAt && endAt > blocked.startsAt,
        );
        if (!overlaps)
          slots.push({
            staffId: member.id,
            staffName: member.name,
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
          });
      }
    }
  }
  return { service, slots, timezone: business.timezone };
}

function formatSlotTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

function formatBusinessHoursReply(
  hours: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    staffName: string;
  }>,
) {
  if (!hours.length) return 'The salon has not added business hours yet.';
  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const grouped = new Map<number, string[]>();
  for (const hour of hours) {
    const entries = grouped.get(hour.dayOfWeek) ?? [];
    entries.push(`${hour.startTime}–${hour.endTime} (${hour.staffName})`);
    grouped.set(hour.dayOfWeek, entries);
  }
  return `Our salon hours:\n${[...grouped.entries()]
    .sort(([dayA], [dayB]) => dayA - dayB)
    .map(([day, entries]) => `• ${dayNames[day]}: ${entries.join(', ')}`)
    .join('\n')}`;
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true, credentials: true });

  app.addHook('onRequest', async (request, reply) => {
    const requestId = request.headers['x-request-id'];
    reply.header(
      'X-Request-Id',
      typeof requestId === 'string' && requestId.length <= 128
        ? requestId
        : randomUUID(),
    );
    (
      request as typeof request & { metricsStartedAt: number }
    ).metricsStartedAt = Date.now();
    metrics.requests += 1;
    const path = request.url.split('?')[0] ?? '';
    if (path === '/health' || path === '/health/ready') return;
    const now = Date.now();
    const windowMs = 60_000;
    const configured = (name: string, fallback: number) => {
      const value = Number(process.env[name]);
      return Number.isInteger(value) && value > 0 ? value : fallback;
    };
    const limit =
      path.startsWith('/v1/businesses/') && path.includes('/dev/')
        ? configured('RATE_LIMIT_SIMULATOR_PER_MINUTE', 30)
        : path.startsWith('/api/auth/')
          ? configured('RATE_LIMIT_AUTH_PER_MINUTE', 20)
          : configured('RATE_LIMIT_GENERAL_PER_MINUTE', 120);
    const key = `${request.ip}:${path}`;
    const current = rateBuckets.get(key);
    const bucket =
      !current || current.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : current;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > limit) {
      reply.header('Retry-After', '60');
      return reply.code(429).send({ error: 'rate_limit_exceeded' });
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = (
      request as typeof request & {
        metricsStartedAt?: number;
      }
    ).metricsStartedAt;
    if (startedAt) metrics.totalDurationMs += Date.now() - startedAt;
    if (reply.statusCode >= 400 && reply.statusCode < 500)
      metrics.responses4xx += 1;
    if (reply.statusCode >= 500) metrics.responses5xx += 1;
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    return payload;
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (request.url.split('?')[0] !== '/webhooks/meta') return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);
    (request as typeof request & { rawBody: Buffer }).rawBody = rawBody;
    return Readable.from([rawBody]);
  });

  app.get('/health', async () => ({ status: 'ok', service: 'api' }));

  app.get('/health/live', async () => ({ status: 'alive', service: 'api' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: 'ready', service: 'api', database: 'ok' };
    } catch {
      return reply.code(503).send({
        status: 'not_ready',
        service: 'api',
        database: 'unavailable',
      });
    }
  });

  app.get('/internal/metrics', async (request, reply) => {
    const workerSecret = process.env.INTERNAL_WORKER_SECRET;
    if (!workerSecret)
      return reply.code(503).send({ error: 'worker_not_configured' });
    if (request.headers['x-worker-secret'] !== workerSecret)
      return reply.code(401).send({ error: 'worker_unauthorized' });
    return {
      requests: metrics.requests,
      responses4xx: metrics.responses4xx,
      responses5xx: metrics.responses5xx,
      averageDurationMs: metrics.requests
        ? Math.round(metrics.totalDurationMs / metrics.requests)
        : 0,
    };
  });

  app.get('/internal/production-readiness', async (request, reply) => {
    const workerSecret = process.env.INTERNAL_WORKER_SECRET;
    if (!workerSecret)
      return reply.code(503).send({ error: 'worker_not_configured' });
    if (request.headers['x-worker-secret'] !== workerSecret)
      return reply.code(401).send({ error: 'worker_unauthorized' });
    const configured = (name: string, minimumLength = 1) => {
      const value = process.env[name]?.trim() ?? '';
      return (
        value.length >= minimumLength && !value.startsWith('replace-with-')
      );
    };
    const checks = {
      database: Boolean(process.env.DATABASE_URL),
      betterAuthUrl: Boolean(process.env.BETTER_AUTH_URL),
      betterAuthSecret: configured('BETTER_AUTH_SECRET', 32),
      metaAccessToken: configured('META_ACCESS_TOKEN'),
      metaAppSecret: configured('META_APP_SECRET'),
      metaWebhookVerifyToken: configured('META_WEBHOOK_VERIFY_TOKEN'),
      metaPhoneNumberId: configured('META_PHONE_NUMBER_ID'),
      internalWorkerSecret: configured('INTERNAL_WORKER_SECRET', 16),
    };
    return {
      ready: Object.values(checks).every(Boolean),
      checks,
      next: Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([name]) => name),
    };
  });

  app.post<{ Body: { limit?: number } }>(
    '/internal/outbound-queue/process',
    async (request, reply) => {
      const workerSecret = process.env.INTERNAL_WORKER_SECRET;
      if (!workerSecret)
        return reply.code(503).send({ error: 'worker_not_configured' });
      if (request.headers['x-worker-secret'] !== workerSecret)
        return reply.code(401).send({ error: 'worker_unauthorized' });
      try {
        return await processOutboundQueue(request.body?.limit);
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message === 'meta_outbound_not_configured'
        )
          return reply.code(503).send({ error: cause.message });
        throw cause;
      }
    },
  );

  app.post<{ Body: { limit?: number; horizonDays?: number } }>(
    '/internal/reminders/process',
    async (request, reply) => {
      const workerSecret = process.env.INTERNAL_WORKER_SECRET;
      if (!workerSecret)
        return reply.code(503).send({ error: 'worker_not_configured' });
      if (request.headers['x-worker-secret'] !== workerSecret)
        return reply.code(401).send({ error: 'worker_unauthorized' });
      const scheduled = await scheduleAppointmentReminders({
        ...(request.body?.horizonDays !== undefined
          ? { horizonDays: request.body.horizonDays }
          : {}),
      });
      const processed = await processReminderQueue({
        ...(request.body?.limit !== undefined
          ? { limit: request.body.limit }
          : {}),
      });
      return { scheduled, processed };
    },
  );

  app.get<{
    Querystring: Record<string, string | undefined>;
  }>('/webhooks/meta', async (request, reply) => {
    const {
      'hub.mode': mode,
      'hub.verify_token': verifyToken,
      'hub.challenge': challenge,
    } = request.query;
    if (
      mode === 'subscribe' &&
      verifyToken &&
      verifyToken === process.env.META_WEBHOOK_VERIFY_TOKEN &&
      challenge
    )
      return reply.type('text/plain').send(challenge);
    return reply.code(403).send({ error: 'webhook_verification_failed' });
  });

  app.post<{ Body: Record<string, unknown> }>(
    '/webhooks/meta',
    async (request, reply) => {
      const appSecret = process.env.META_APP_SECRET;
      if (!appSecret)
        return reply.code(503).send({ error: 'meta_webhook_not_configured' });
      const signature = request.headers['x-hub-signature-256'];
      const rawBody = (request as typeof request & { rawBody?: Buffer })
        .rawBody;
      if (typeof signature !== 'string' || !rawBody)
        return reply.code(401).send({ error: 'invalid_webhook_signature' });
      const expected = `sha256=${createHmac('sha256', appSecret)
        .update(rawBody)
        .digest('hex')}`;
      const expectedBuffer = Buffer.from(expected);
      const receivedBuffer = Buffer.from(signature);
      if (
        expectedBuffer.length !== receivedBuffer.length ||
        !timingSafeEqual(expectedBuffer, receivedBuffer)
      )
        return reply.code(401).send({ error: 'invalid_webhook_signature' });

      const body = request.body;
      const entries = Array.isArray(body.entry) ? body.entry : [];
      const events = entries.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const changes = (entry as { changes?: unknown }).changes;
        if (!Array.isArray(changes)) return [];
        return changes.flatMap((change) => {
          if (!change || typeof change !== 'object') return [];
          const value = (change as { value?: unknown }).value;
          if (!value || typeof value !== 'object') return [];
          const metadata = (value as { metadata?: unknown }).metadata;
          const phoneNumberId =
            metadata &&
            typeof metadata === 'object' &&
            typeof (metadata as { phone_number_id?: unknown })
              .phone_number_id === 'string'
              ? (metadata as { phone_number_id: string }).phone_number_id
              : null;
          const messages = (value as { messages?: unknown }).messages;
          if (!Array.isArray(messages)) return [];
          return messages.flatMap((message) => {
            if (!message || typeof message !== 'object') return [];
            const typedMessage = message as {
              id?: unknown;
              from?: unknown;
              type?: unknown;
              text?: { body?: unknown };
            };
            return typeof typedMessage.id === 'string' &&
              typeof typedMessage.from === 'string'
              ? [
                  {
                    providerEventId: typedMessage.id,
                    phoneNumberId,
                    senderPhone: typedMessage.from,
                    messageType:
                      typeof typedMessage.type === 'string'
                        ? typedMessage.type
                        : 'unknown',
                    text:
                      typeof typedMessage.text?.body === 'string'
                        ? typedMessage.text.body
                        : null,
                  },
                ]
              : [];
          });
        });
      });
      if (events.length) {
        const payloadHash = createHash('sha256').update(rawBody).digest('hex');
        const phoneNumberIds = events.flatMap((event) =>
          event.phoneNumberId ? [event.phoneNumberId] : [],
        );
        const connections = await db.whatsAppConnection.findMany({
          where: { phoneNumberId: { in: phoneNumberIds }, enabled: true },
          select: { businessId: true, phoneNumberId: true },
        });
        const connectionByPhoneNumberId = new Map(
          connections.map((connection) => [
            connection.phoneNumberId,
            connection.businessId,
          ]),
        );
        for (const event of events) {
          const businessId = event.phoneNumberId
            ? connectionByPhoneNumberId.get(event.phoneNumberId)
            : undefined;
          const intentResult = event.text?.trim()
            ? await intentProvider.classify(event.text.trim().toLowerCase())
            : {
                intent: 'UNKNOWN' as const,
                confidence: 0,
                source: 'rules' as const,
              };
          await db.$transaction(async (transaction) => {
            await transaction.webhookEvent.upsert({
              where: { providerEventId: event.providerEventId },
              create: {
                provider: 'meta',
                providerEventId: event.providerEventId,
                eventType: `message:${event.messageType}`,
                businessId: businessId ?? null,
                phoneNumberId: event.phoneNumberId,
                senderPhone: event.senderPhone,
                messageType: event.messageType,
                textBody: event.text,
                payloadHash,
              },
              update: {},
            });
            if (!businessId) return;
            const existingMessage = await transaction.message.findUnique({
              where: { providerMessageId: event.providerEventId },
              select: { id: true },
            });
            if (existingMessage) return;
            const customer = await transaction.customer.upsert({
              where: {
                businessId_phone: {
                  businessId,
                  phone: event.senderPhone,
                },
              },
              create: {
                businessId,
                phone: event.senderPhone,
              },
              update: {},
            });
            let conversation = await transaction.conversation.findFirst({
              where: {
                businessId,
                customerId: customer.id,
                status: ConversationStatus.OPEN,
              },
              orderBy: { lastMessageAt: 'desc' },
            });
            if (!conversation)
              conversation = await transaction.conversation.create({
                data: {
                  businessId,
                  customerId: customer.id,
                  status: ConversationStatus.OPEN,
                },
              });
            await transaction.message.upsert({
              where: { providerMessageId: event.providerEventId },
              create: {
                businessId,
                conversationId: conversation.id,
                providerMessageId: event.providerEventId,
                direction: MessageDirection.INBOUND,
                messageType: event.messageType,
                textBody: event.text,
                status: MessageStatus.RECEIVED,
              },
              update: {},
            });
            await transaction.conversation.update({
              where: { id: conversation.id },
              data: { lastMessageAt: new Date() },
            });
            if (
              conversation.status === ConversationStatus.OPEN &&
              event.text?.trim()
            ) {
              const normalizedText = event.text.trim().toLowerCase();
              const lastOutbound = await transaction.message.findFirst({
                where: {
                  conversationId: conversation.id,
                  direction: MessageDirection.OUTBOUND,
                },
                orderBy: { createdAt: 'desc' },
                select: { textBody: true },
              });
              const services = await transaction.service.findMany({
                where: { businessId, enabled: true },
                orderBy: { name: 'asc' },
                select: {
                  id: true,
                  name: true,
                  durationMinutes: true,
                  priceMinor: true,
                },
              });
              const intent = intentResult.intent;
              const bookingIntent = intent === 'BOOKING';
              const bookingPrompt = lastOutbound?.textBody?.startsWith(
                'Sure — which service',
              );
              const datePrompt = lastOutbound?.textBody?.startsWith('Great —');
              const rescheduleDatePrompt = lastOutbound?.textBody?.startsWith(
                'I found an upcoming appointment',
              );
              const slotPrompt = lastOutbound?.textBody?.startsWith(
                'Available times for',
              );
              const confirmationPrompt = lastOutbound?.textBody?.startsWith(
                'Please confirm your booking',
              );
              const cancellationPrompt = lastOutbound?.textBody?.startsWith(
                'I found an upcoming appointment',
              );
              const optOutRequest =
                /^(stop|unsubscribe|opt out|do not message)$/i.test(
                  normalizedText,
                );
              const optInRequest = /^(start|subscribe|opt in)$/i.test(
                normalizedText,
              );
              const pendingService = conversation.pendingServiceId
                ? services.find(
                    (service) => service.id === conversation.pendingServiceId,
                  )
                : undefined;
              const selectedService = datePrompt
                ? services.find((service) =>
                    lastOutbound?.textBody
                      ?.toLowerCase()
                      .includes(service.name.toLowerCase()),
                  )
                : rescheduleDatePrompt
                  ? pendingService
                  : bookingPrompt
                    ? services.find((service) =>
                        normalizedText.includes(service.name.toLowerCase()),
                      )
                    : undefined;
              let replyText: string | null = null;
              if (optOutRequest || optInRequest) {
                await transaction.customer.update({
                  where: { id: customer.id },
                  data: { optedOut: optOutRequest },
                });
                await transaction.conversation.update({
                  where: { id: conversation.id },
                  data: {
                    pendingAction: null,
                    pendingAppointmentId: null,
                    pendingServiceId: null,
                    pendingStaffId: null,
                    pendingDate: null,
                    pendingStartsAt: null,
                    pendingEndsAt: null,
                  },
                });
                replyText = optOutRequest
                  ? 'You have been opted out of appointment reminders. Reply START if you want to receive them again.'
                  : 'Appointment reminders are enabled again.';
              } else if (
                cancellationPrompt &&
                conversation.pendingAction === 'CANCEL' &&
                conversation.pendingAppointmentId &&
                /^(yes|y|confirm|confirmed)$/i.test(normalizedText)
              ) {
                const cancelled = await transaction.appointment.updateMany({
                  where: {
                    id: conversation.pendingAppointmentId,
                    businessId,
                    customerId: customer.id,
                    status: { in: unavailableAppointmentStatuses },
                  },
                  data: { status: AppointmentStatus.CANCELLED },
                });
                replyText = cancelled.count
                  ? 'Your appointment has been cancelled.'
                  : 'That appointment is no longer active. A team member can help if needed.';
                await transaction.conversation.update({
                  where: { id: conversation.id },
                  data: { pendingAction: null, pendingAppointmentId: null },
                });
              } else if (
                cancellationPrompt &&
                conversation.pendingAction === 'CANCEL'
              ) {
                replyText = 'Please reply YES to confirm the cancellation.';
              } else if (
                confirmationPrompt &&
                conversation.pendingAction === 'RESCHEDULE' &&
                conversation.pendingAppointmentId &&
                conversation.pendingServiceId &&
                conversation.pendingStaffId &&
                conversation.pendingStartsAt &&
                conversation.pendingEndsAt &&
                /^(yes|y|confirm|confirmed)$/i.test(normalizedText)
              ) {
                const conflict = await transaction.appointment.findFirst({
                  where: {
                    id: { not: conversation.pendingAppointmentId },
                    staffId: conversation.pendingStaffId,
                    startsAt: { lt: conversation.pendingEndsAt },
                    endsAt: { gt: conversation.pendingStartsAt },
                    status: { in: unavailableAppointmentStatuses },
                  },
                  select: { id: true },
                });
                if (conflict) {
                  replyText =
                    'That new slot was just taken. Please choose another time.';
                  await transaction.conversation.update({
                    where: { id: conversation.id },
                    data: {
                      pendingStaffId: null,
                      pendingStartsAt: null,
                      pendingEndsAt: null,
                    },
                  });
                } else {
                  await transaction.appointment.update({
                    where: { id: conversation.pendingAppointmentId },
                    data: { status: AppointmentStatus.CANCELLED },
                  });
                  await transaction.appointment.create({
                    data: {
                      businessId,
                      customerId: customer.id,
                      serviceId: conversation.pendingServiceId,
                      staffId: conversation.pendingStaffId,
                      startsAt: conversation.pendingStartsAt,
                      endsAt: conversation.pendingEndsAt,
                      status: AppointmentStatus.CONFIRMED,
                      source: 'whatsapp',
                    },
                  });
                  replyText =
                    'Your appointment has been rescheduled successfully.';
                  await transaction.conversation.update({
                    where: { id: conversation.id },
                    data: {
                      pendingServiceId: null,
                      pendingStaffId: null,
                      pendingDate: null,
                      pendingStartsAt: null,
                      pendingEndsAt: null,
                      pendingAction: null,
                      pendingAppointmentId: null,
                    },
                  });
                }
              } else if (
                confirmationPrompt &&
                conversation.pendingStaffId &&
                conversation.pendingStartsAt &&
                conversation.pendingEndsAt &&
                /^(yes|y|confirm|confirmed)$/i.test(normalizedText)
              ) {
                const conflict = await transaction.appointment.findFirst({
                  where: {
                    staffId: conversation.pendingStaffId,
                    startsAt: { lt: conversation.pendingEndsAt },
                    endsAt: { gt: conversation.pendingStartsAt },
                    status: { in: unavailableAppointmentStatuses },
                  },
                  select: { id: true },
                });
                if (conflict) {
                  replyText =
                    'That slot was just taken. Please choose another time.';
                  await transaction.conversation.update({
                    where: { id: conversation.id },
                    data: {
                      pendingStaffId: null,
                      pendingStartsAt: null,
                      pendingEndsAt: null,
                    },
                  });
                } else {
                  await transaction.appointment.create({
                    data: {
                      businessId,
                      customerId: customer.id,
                      serviceId: conversation.pendingServiceId!,
                      staffId: conversation.pendingStaffId,
                      startsAt: conversation.pendingStartsAt,
                      endsAt: conversation.pendingEndsAt,
                      status: AppointmentStatus.CONFIRMED,
                      source: 'whatsapp',
                    },
                  });
                  replyText =
                    'Your appointment is confirmed. We look forward to seeing you!';
                  await transaction.conversation.update({
                    where: { id: conversation.id },
                    data: {
                      pendingServiceId: null,
                      pendingStaffId: null,
                      pendingDate: null,
                      pendingStartsAt: null,
                      pendingEndsAt: null,
                      pendingAction: null,
                      pendingAppointmentId: null,
                    },
                  });
                }
              } else if (
                slotPrompt &&
                pendingService &&
                conversation.pendingDate
              ) {
                const availability = await findAvailabilitySlots(
                  businessId,
                  conversation.pendingDate,
                  pendingService.id,
                );
                const selectedSlot = availability?.slots.find((slot) =>
                  normalizedText.includes(
                    formatSlotTime(
                      slot.startAt,
                      availability.timezone,
                    ).toLowerCase(),
                  ),
                );
                if (selectedSlot) {
                  await transaction.conversation.update({
                    where: { id: conversation.id },
                    data: {
                      pendingStaffId: selectedSlot.staffId,
                      pendingStartsAt: new Date(selectedSlot.startAt),
                      pendingEndsAt: new Date(selectedSlot.endAt),
                    },
                  });
                  replyText = `Please confirm your booking for ${pendingService.name} on ${conversation.pendingDate} at ${formatSlotTime(selectedSlot.startAt, availability!.timezone)} with ${selectedSlot.staffName}. Reply YES to confirm.`;
                } else {
                  replyText =
                    'Please reply with one of the available times shown.';
                }
              } else if (rescheduleDatePrompt && selectedService) {
                const dateMatch = normalizedText.match(/\b\d{4}-\d{2}-\d{2}\b/);
                if (!dateMatch) {
                  replyText = 'Please provide the new date using YYYY-MM-DD.';
                } else if (!isValidDateOnly(dateMatch[0])) {
                  replyText = 'That date is not valid. Please use YYYY-MM-DD.';
                } else {
                  const availability = await findAvailabilitySlots(
                    businessId,
                    dateMatch[0],
                    selectedService.id,
                  );
                  await transaction.conversation.update({
                    where: { id: conversation.id },
                    data: { pendingDate: dateMatch[0] },
                  });
                  replyText = availability?.slots.length
                    ? `Available times for ${selectedService.name} on ${dateMatch[0]}:\n${availability.slots
                        .slice(0, 8)
                        .map(
                          (slot) =>
                            `• ${formatSlotTime(slot.startAt, availability.timezone)} — ${slot.staffName}`,
                        )
                        .join('\n')}`
                    : `I could not find an available ${selectedService.name} slot on ${dateMatch[0]}. Please choose another date.`;
                }
              } else if (datePrompt && selectedService) {
                const dateMatch = normalizedText.match(/\b\d{4}-\d{2}-\d{2}\b/);
                if (!dateMatch) {
                  replyText = `Great — ${selectedService.name} selected. What date would you prefer? Please use YYYY-MM-DD.`;
                } else if (!isValidDateOnly(dateMatch[0])) {
                  replyText = 'That date is not valid. Please use YYYY-MM-DD.';
                } else {
                  const availability = await findAvailabilitySlots(
                    businessId,
                    dateMatch[0],
                    selectedService.id,
                  );
                  await transaction.conversation.update({
                    where: { id: conversation.id },
                    data: {
                      pendingServiceId: selectedService.id,
                      pendingDate: dateMatch[0],
                      pendingStaffId: null,
                      pendingStartsAt: null,
                      pendingEndsAt: null,
                    },
                  });
                  replyText = availability?.slots.length
                    ? `Available times for ${selectedService.name} on ${dateMatch[0]}:\n${availability.slots
                        .slice(0, 8)
                        .map(
                          (slot) =>
                            `• ${formatSlotTime(slot.startAt, availability.timezone)} — ${slot.staffName}`,
                        )
                        .join('\n')}`
                    : `I could not find an available ${selectedService.name} slot on ${dateMatch[0]}. Please choose another date.`;
                }
              } else if (bookingPrompt && selectedService) {
                await transaction.conversation.update({
                  where: { id: conversation.id },
                  data: {
                    pendingServiceId: selectedService.id,
                    pendingDate: null,
                    pendingStaffId: null,
                    pendingStartsAt: null,
                    pendingEndsAt: null,
                  },
                });
                replyText = `Great — ${selectedService.name} selected. What date would you prefer? Please use YYYY-MM-DD.`;
              } else if (bookingPrompt) {
                replyText = services.length
                  ? `Please reply with one of these services: ${services
                      .map((service) => service.name)
                      .join(', ')}.`
                  : null;
              } else if (bookingIntent) {
                replyText = services.length
                  ? `Sure — which service would you like to book?\n${services
                      .map(
                        (service) =>
                          `• ${service.name} (${service.durationMinutes} min, ₹${(service.priceMinor / 100).toFixed(0)})`,
                      )
                      .join('\n')}`
                  : 'I can help with a booking, but the salon has not added any services yet.';
              } else {
                if (intent === 'GREETING') {
                  replyText = 'Hello! How can I help you today?';
                } else if (intent === 'AVAILABILITY') {
                  replyText =
                    'Sure — which service and date would you like me to check?';
                } else if (intent === 'CANCEL') {
                  const upcomingAppointment =
                    await transaction.appointment.findFirst({
                      where: {
                        businessId,
                        customerId: customer.id,
                        startsAt: { gt: new Date() },
                        status: { in: unavailableAppointmentStatuses },
                      },
                      select: {
                        id: true,
                        startsAt: true,
                        service: { select: { name: true } },
                        staff: { select: { name: true } },
                      },
                      orderBy: { startsAt: 'asc' },
                    });
                  if (!upcomingAppointment) {
                    replyText =
                      'I could not find an upcoming appointment to cancel.';
                  } else {
                    const business = await transaction.business.findUnique({
                      where: { id: businessId },
                      select: { timezone: true },
                    });
                    await transaction.conversation.update({
                      where: { id: conversation.id },
                      data: {
                        pendingAction: 'CANCEL',
                        pendingAppointmentId: upcomingAppointment.id,
                      },
                    });
                    replyText = `I found an upcoming appointment for ${upcomingAppointment.service.name} with ${upcomingAppointment.staff.name} at ${formatSlotTime(upcomingAppointment.startsAt.toISOString(), business?.timezone ?? 'Asia/Kolkata')}. Reply YES to confirm cancellation.`;
                  }
                } else if (intent === 'RESCHEDULE') {
                  const upcomingAppointment =
                    await transaction.appointment.findFirst({
                      where: {
                        businessId,
                        customerId: customer.id,
                        startsAt: { gt: new Date() },
                        status: { in: unavailableAppointmentStatuses },
                      },
                      select: {
                        id: true,
                        serviceId: true,
                        startsAt: true,
                        service: { select: { name: true } },
                        staff: { select: { name: true } },
                      },
                      orderBy: { startsAt: 'asc' },
                    });
                  if (!upcomingAppointment) {
                    replyText =
                      'I could not find an upcoming appointment to reschedule.';
                  } else {
                    const business = await transaction.business.findUnique({
                      where: { id: businessId },
                      select: { timezone: true },
                    });
                    await transaction.conversation.update({
                      where: { id: conversation.id },
                      data: {
                        pendingAction: 'RESCHEDULE',
                        pendingAppointmentId: upcomingAppointment.id,
                        pendingServiceId: upcomingAppointment.serviceId,
                        pendingDate: null,
                        pendingStaffId: null,
                        pendingStartsAt: null,
                        pendingEndsAt: null,
                      },
                    });
                    replyText = `I found an upcoming ${upcomingAppointment.service.name} appointment with ${upcomingAppointment.staff.name} at ${formatSlotTime(upcomingAppointment.startsAt.toISOString(), business?.timezone ?? 'Asia/Kolkata')}. What new date would you prefer? Please use YYYY-MM-DD.`;
                  }
                } else if (intent === 'HOURS') {
                  const hours = await transaction.workingHour.findMany({
                    where: { staff: { businessId } },
                    select: {
                      dayOfWeek: true,
                      startTime: true,
                      endTime: true,
                      staff: { select: { name: true } },
                    },
                    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
                  });
                  replyText = formatBusinessHoursReply(
                    hours.map((hour) => ({
                      ...hour,
                      staffName: hour.staff.name,
                    })),
                  );
                } else {
                  const faqs = await transaction.faq.findMany({
                    where: { businessId, enabled: true },
                    orderBy: { createdAt: 'asc' },
                  });
                  const matchingFaq = faqs.find((faq) =>
                    faq.keywords.some((keyword) =>
                      normalizedText.includes(keyword.toLowerCase()),
                    ),
                  );
                  if (intentResult.confidence < 0.6 && !matchingFaq) {
                    await transaction.conversation.update({
                      where: { id: conversation.id },
                      data: { status: ConversationStatus.HANDOFF },
                    });
                    replyText =
                      'I’m not fully sure how to help with that. I’ve asked a team member to take over this conversation.';
                  } else {
                    replyText =
                      matchingFaq?.answer ??
                      (intent === 'SERVICES'
                        ? services.length
                          ? `We offer: ${services
                              .map(
                                (service) =>
                                  `${service.name} (${service.durationMinutes} min)`,
                              )
                              .join(', ')}.`
                          : 'The salon has not added any services yet.'
                        : intent === 'PRICING'
                          ? services.length
                            ? services
                                .map(
                                  (service) =>
                                    `${service.name}: ₹${(service.priceMinor / 100).toFixed(0)}`,
                                )
                                .join('\n')
                            : 'The salon has not added service prices yet.'
                          : intent === 'HUMAN'
                            ? 'I can ask a team member to take over this conversation. Please reply HUMAN or use the dashboard handoff action.'
                            : null);
                  }
                }
              }
              if (replyText)
                await transaction.message.create({
                  data: {
                    businessId,
                    conversationId: conversation.id,
                    direction: MessageDirection.OUTBOUND,
                    messageType: 'text',
                    textBody: replyText,
                    status: MessageStatus.QUEUED,
                  },
                });
            }
            await transaction.webhookEvent.update({
              where: { providerEventId: event.providerEventId },
              data: { status: 'PROCESSED', processedAt: new Date() },
            });
          });
        }
      }
      request.log.info({ eventCount: events.length }, 'Meta webhook received');
      return reply.send({ received: true, eventCount: events.length });
    },
  );

  app.post<{
    Params: { businessId: string };
    Body: { senderPhone: string; text: string; messageType?: string };
  }>(
    '/v1/businesses/:businessId/dev/simulate-whatsapp',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      if (process.env.NODE_ENV === 'production')
        return reply.code(404).send({ error: 'not_found' });
      const senderPhone = request.body.senderPhone?.trim();
      const text = request.body.text?.trim();
      if (!senderPhone || !text)
        return reply
          .code(400)
          .send({ error: 'sender_phone_and_text_required' });

      const providerMessageId = `dev-${randomUUID()}`;
      const intentResult = await intentProvider.classify(text.toLowerCase());
      const conversation = await db.$transaction(async (transaction) => {
        const customer = await transaction.customer.upsert({
          where: {
            businessId_phone: {
              businessId: request.params.businessId,
              phone: senderPhone,
            },
          },
          create: { businessId: request.params.businessId, phone: senderPhone },
          update: {},
        });
        let openConversation = await transaction.conversation.findFirst({
          where: {
            businessId: request.params.businessId,
            customerId: customer.id,
            status: ConversationStatus.OPEN,
          },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (!openConversation)
          openConversation = await transaction.conversation.create({
            data: {
              businessId: request.params.businessId,
              customerId: customer.id,
              status: ConversationStatus.OPEN,
            },
          });
        await transaction.message.create({
          data: {
            businessId: request.params.businessId,
            conversationId: openConversation.id,
            providerMessageId,
            direction: MessageDirection.INBOUND,
            messageType: request.body.messageType?.trim() || 'text',
            textBody: text,
            status: MessageStatus.RECEIVED,
          },
        });
        await transaction.conversation.update({
          where: { id: openConversation.id },
          data: { lastMessageAt: new Date() },
        });
        if (openConversation.status === ConversationStatus.OPEN) {
          const normalizedText = text.toLowerCase();
          const lastOutbound = await transaction.message.findFirst({
            where: {
              conversationId: openConversation.id,
              direction: MessageDirection.OUTBOUND,
            },
            orderBy: { createdAt: 'desc' },
            select: { textBody: true },
          });
          const services = await transaction.service.findMany({
            where: { businessId: request.params.businessId, enabled: true },
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              durationMinutes: true,
              priceMinor: true,
            },
          });
          const intent = intentResult.intent;
          const bookingIntent = intent === 'BOOKING';
          const bookingPrompt = lastOutbound?.textBody?.startsWith(
            'Sure — which service',
          );
          const datePrompt = lastOutbound?.textBody?.startsWith('Great —');
          const rescheduleDatePrompt = lastOutbound?.textBody?.startsWith(
            'I found an upcoming',
          );
          const slotPrompt = lastOutbound?.textBody?.startsWith(
            'Available times for',
          );
          const confirmationPrompt = lastOutbound?.textBody?.startsWith(
            'Please confirm your booking',
          );
          const cancellationPrompt = lastOutbound?.textBody?.startsWith(
            'I found an upcoming appointment',
          );
          const optOutRequest =
            /^(stop|unsubscribe|opt out|do not message)$/i.test(normalizedText);
          const optInRequest = /^(start|subscribe|opt in)$/i.test(
            normalizedText,
          );
          const pendingService = openConversation.pendingServiceId
            ? services.find(
                (service) => service.id === openConversation.pendingServiceId,
              )
            : undefined;
          const selectedService = datePrompt
            ? services.find((service) =>
                lastOutbound?.textBody
                  ?.toLowerCase()
                  .includes(service.name.toLowerCase()),
              )
            : rescheduleDatePrompt
              ? pendingService
              : bookingPrompt
                ? services.find((service) =>
                    normalizedText.includes(service.name.toLowerCase()),
                  )
                : undefined;
          let replyText: string | null = null;
          if (optOutRequest || optInRequest) {
            await transaction.customer.update({
              where: { id: customer.id },
              data: { optedOut: optOutRequest },
            });
            await transaction.conversation.update({
              where: { id: openConversation.id },
              data: {
                pendingAction: null,
                pendingAppointmentId: null,
                pendingServiceId: null,
                pendingStaffId: null,
                pendingDate: null,
                pendingStartsAt: null,
                pendingEndsAt: null,
              },
            });
            replyText = optOutRequest
              ? 'You have been opted out of appointment reminders. Reply START if you want to receive them again.'
              : 'Appointment reminders are enabled again.';
          } else if (
            cancellationPrompt &&
            openConversation.pendingAction === 'CANCEL' &&
            openConversation.pendingAppointmentId &&
            /^(yes|y|confirm|confirmed)$/i.test(normalizedText)
          ) {
            const cancelled = await transaction.appointment.updateMany({
              where: {
                id: openConversation.pendingAppointmentId,
                businessId: request.params.businessId,
                customerId: customer.id,
                status: { in: unavailableAppointmentStatuses },
              },
              data: { status: AppointmentStatus.CANCELLED },
            });
            replyText = cancelled.count
              ? 'Your appointment has been cancelled.'
              : 'That appointment is no longer active. A team member can help if needed.';
            await transaction.conversation.update({
              where: { id: openConversation.id },
              data: { pendingAction: null, pendingAppointmentId: null },
            });
          } else if (
            cancellationPrompt &&
            openConversation.pendingAction === 'CANCEL'
          ) {
            replyText = 'Please reply YES to confirm the cancellation.';
          } else if (
            confirmationPrompt &&
            openConversation.pendingAction === 'RESCHEDULE' &&
            openConversation.pendingAppointmentId &&
            openConversation.pendingServiceId &&
            openConversation.pendingStaffId &&
            openConversation.pendingStartsAt &&
            openConversation.pendingEndsAt &&
            /^(yes|y|confirm|confirmed)$/i.test(normalizedText)
          ) {
            const conflict = await transaction.appointment.findFirst({
              where: {
                id: { not: openConversation.pendingAppointmentId },
                staffId: openConversation.pendingStaffId,
                startsAt: { lt: openConversation.pendingEndsAt },
                endsAt: { gt: openConversation.pendingStartsAt },
                status: { in: unavailableAppointmentStatuses },
              },
              select: { id: true },
            });
            if (conflict) {
              replyText =
                'That new slot was just taken. Please choose another time.';
              await transaction.conversation.update({
                where: { id: openConversation.id },
                data: {
                  pendingStaffId: null,
                  pendingStartsAt: null,
                  pendingEndsAt: null,
                },
              });
            } else {
              await transaction.appointment.update({
                where: { id: openConversation.pendingAppointmentId },
                data: { status: AppointmentStatus.CANCELLED },
              });
              await transaction.appointment.create({
                data: {
                  businessId: request.params.businessId,
                  customerId: customer.id,
                  serviceId: openConversation.pendingServiceId,
                  staffId: openConversation.pendingStaffId,
                  startsAt: openConversation.pendingStartsAt,
                  endsAt: openConversation.pendingEndsAt,
                  status: AppointmentStatus.CONFIRMED,
                  source: 'whatsapp',
                },
              });
              replyText = 'Your appointment has been rescheduled successfully.';
              await transaction.conversation.update({
                where: { id: openConversation.id },
                data: {
                  pendingServiceId: null,
                  pendingStaffId: null,
                  pendingDate: null,
                  pendingStartsAt: null,
                  pendingEndsAt: null,
                  pendingAction: null,
                  pendingAppointmentId: null,
                },
              });
            }
          } else if (
            confirmationPrompt &&
            openConversation.pendingStaffId &&
            openConversation.pendingStartsAt &&
            openConversation.pendingEndsAt &&
            /^(yes|y|confirm|confirmed)$/i.test(normalizedText)
          ) {
            const conflict = await transaction.appointment.findFirst({
              where: {
                staffId: openConversation.pendingStaffId,
                startsAt: { lt: openConversation.pendingEndsAt },
                endsAt: { gt: openConversation.pendingStartsAt },
                status: { in: unavailableAppointmentStatuses },
              },
              select: { id: true },
            });
            if (conflict) {
              replyText =
                'That slot was just taken. Please choose another time.';
              await transaction.conversation.update({
                where: { id: openConversation.id },
                data: {
                  pendingStaffId: null,
                  pendingStartsAt: null,
                  pendingEndsAt: null,
                },
              });
            } else {
              await transaction.appointment.create({
                data: {
                  businessId: request.params.businessId,
                  customerId: customer.id,
                  serviceId: openConversation.pendingServiceId!,
                  staffId: openConversation.pendingStaffId,
                  startsAt: openConversation.pendingStartsAt,
                  endsAt: openConversation.pendingEndsAt,
                  status: AppointmentStatus.CONFIRMED,
                  source: 'whatsapp',
                },
              });
              replyText =
                'Your appointment is confirmed. We look forward to seeing you!';
              await transaction.conversation.update({
                where: { id: openConversation.id },
                data: {
                  pendingServiceId: null,
                  pendingStaffId: null,
                  pendingDate: null,
                  pendingStartsAt: null,
                  pendingEndsAt: null,
                  pendingAction: null,
                  pendingAppointmentId: null,
                },
              });
            }
          } else if (
            slotPrompt &&
            pendingService &&
            openConversation.pendingDate
          ) {
            const availability = await findAvailabilitySlots(
              request.params.businessId,
              openConversation.pendingDate,
              pendingService.id,
            );
            const selectedSlot = availability?.slots.find((slot) =>
              normalizedText.includes(
                formatSlotTime(
                  slot.startAt,
                  availability.timezone,
                ).toLowerCase(),
              ),
            );
            if (selectedSlot) {
              await transaction.conversation.update({
                where: { id: openConversation.id },
                data: {
                  pendingStaffId: selectedSlot.staffId,
                  pendingStartsAt: new Date(selectedSlot.startAt),
                  pendingEndsAt: new Date(selectedSlot.endAt),
                },
              });
              replyText = `Please confirm your booking for ${pendingService.name} on ${openConversation.pendingDate} at ${formatSlotTime(selectedSlot.startAt, availability!.timezone)} with ${selectedSlot.staffName}. Reply YES to confirm.`;
            } else {
              replyText = 'Please reply with one of the available times shown.';
            }
          } else if (rescheduleDatePrompt && selectedService) {
            const dateMatch = normalizedText.match(/\b\d{4}-\d{2}-\d{2}\b/);
            if (!dateMatch) {
              replyText = 'Please provide the new date using YYYY-MM-DD.';
            } else if (!isValidDateOnly(dateMatch[0])) {
              replyText = 'That date is not valid. Please use YYYY-MM-DD.';
            } else {
              const availability = await findAvailabilitySlots(
                request.params.businessId,
                dateMatch[0],
                selectedService.id,
              );
              await transaction.conversation.update({
                where: { id: openConversation.id },
                data: { pendingDate: dateMatch[0] },
              });
              replyText = availability?.slots.length
                ? `Available times for ${selectedService.name} on ${dateMatch[0]}:\n${availability.slots
                    .slice(0, 8)
                    .map(
                      (slot) =>
                        `• ${formatSlotTime(slot.startAt, availability.timezone)} — ${slot.staffName}`,
                    )
                    .join('\n')}`
                : `I could not find an available ${selectedService.name} slot on ${dateMatch[0]}. Please choose another date.`;
            }
          } else if (datePrompt && selectedService) {
            const dateMatch = normalizedText.match(/\b\d{4}-\d{2}-\d{2}\b/);
            if (!dateMatch) {
              replyText = `Great — ${selectedService.name} selected. What date would you prefer? Please use YYYY-MM-DD.`;
            } else if (!isValidDateOnly(dateMatch[0])) {
              replyText = 'That date is not valid. Please use YYYY-MM-DD.';
            } else {
              const availability = await findAvailabilitySlots(
                request.params.businessId,
                dateMatch[0],
                selectedService.id,
              );
              await transaction.conversation.update({
                where: { id: openConversation.id },
                data: {
                  pendingServiceId: selectedService.id,
                  pendingDate: dateMatch[0],
                  pendingStaffId: null,
                  pendingStartsAt: null,
                  pendingEndsAt: null,
                },
              });
              replyText = availability?.slots.length
                ? `Available times for ${selectedService.name} on ${dateMatch[0]}:\n${availability.slots
                    .slice(0, 8)
                    .map(
                      (slot) =>
                        `• ${formatSlotTime(slot.startAt, availability.timezone)} — ${slot.staffName}`,
                    )
                    .join('\n')}`
                : `I could not find an available ${selectedService.name} slot on ${dateMatch[0]}. Please choose another date.`;
            }
          } else if (bookingPrompt && selectedService) {
            await transaction.conversation.update({
              where: { id: openConversation.id },
              data: {
                pendingServiceId: selectedService.id,
                pendingDate: null,
                pendingStaffId: null,
                pendingStartsAt: null,
                pendingEndsAt: null,
              },
            });
            replyText = `Great — ${selectedService.name} selected. What date would you prefer? Please use YYYY-MM-DD.`;
          } else if (bookingPrompt) {
            replyText = services.length
              ? `Please reply with one of these services: ${services
                  .map((service) => service.name)
                  .join(', ')}.`
              : null;
          } else if (bookingIntent) {
            replyText = services.length
              ? `Sure — which service would you like to book?\n${services
                  .map(
                    (service) =>
                      `• ${service.name} (${service.durationMinutes} min, ₹${(service.priceMinor / 100).toFixed(0)})`,
                  )
                  .join('\n')}`
              : 'I can help with a booking, but the salon has not added any services yet.';
          } else {
            if (intent === 'GREETING') {
              replyText = 'Hello! How can I help you today?';
            } else if (intent === 'AVAILABILITY') {
              replyText =
                'Sure — which service and date would you like me to check?';
            } else if (intent === 'CANCEL') {
              const upcomingAppointment =
                await transaction.appointment.findFirst({
                  where: {
                    businessId: request.params.businessId,
                    customerId: customer.id,
                    startsAt: { gt: new Date() },
                    status: { in: unavailableAppointmentStatuses },
                  },
                  select: {
                    id: true,
                    startsAt: true,
                    service: { select: { name: true } },
                    staff: { select: { name: true } },
                  },
                  orderBy: { startsAt: 'asc' },
                });
              if (!upcomingAppointment) {
                replyText =
                  'I could not find an upcoming appointment to cancel.';
              } else {
                const business = await transaction.business.findUnique({
                  where: { id: request.params.businessId },
                  select: { timezone: true },
                });
                await transaction.conversation.update({
                  where: { id: openConversation.id },
                  data: {
                    pendingAction: 'CANCEL',
                    pendingAppointmentId: upcomingAppointment.id,
                  },
                });
                replyText = `I found an upcoming appointment for ${upcomingAppointment.service.name} with ${upcomingAppointment.staff.name} at ${formatSlotTime(upcomingAppointment.startsAt.toISOString(), business?.timezone ?? 'Asia/Kolkata')}. Reply YES to confirm cancellation.`;
              }
            } else if (intent === 'RESCHEDULE') {
              const upcomingAppointment =
                await transaction.appointment.findFirst({
                  where: {
                    businessId: request.params.businessId,
                    customerId: customer.id,
                    startsAt: { gt: new Date() },
                    status: { in: unavailableAppointmentStatuses },
                  },
                  select: {
                    id: true,
                    serviceId: true,
                    startsAt: true,
                    service: { select: { name: true } },
                    staff: { select: { name: true } },
                  },
                  orderBy: { startsAt: 'asc' },
                });
              if (!upcomingAppointment) {
                replyText =
                  'I could not find an upcoming appointment to reschedule.';
              } else {
                const business = await transaction.business.findUnique({
                  where: { id: request.params.businessId },
                  select: { timezone: true },
                });
                await transaction.conversation.update({
                  where: { id: openConversation.id },
                  data: {
                    pendingAction: 'RESCHEDULE',
                    pendingAppointmentId: upcomingAppointment.id,
                    pendingServiceId: upcomingAppointment.serviceId,
                    pendingDate: null,
                    pendingStaffId: null,
                    pendingStartsAt: null,
                    pendingEndsAt: null,
                  },
                });
                replyText = `I found an upcoming ${upcomingAppointment.service.name} appointment with ${upcomingAppointment.staff.name} at ${formatSlotTime(upcomingAppointment.startsAt.toISOString(), business?.timezone ?? 'Asia/Kolkata')}. What new date would you prefer? Please use YYYY-MM-DD.`;
              }
            } else if (intent === 'HOURS') {
              const hours = await transaction.workingHour.findMany({
                where: { staff: { businessId: request.params.businessId } },
                select: {
                  dayOfWeek: true,
                  startTime: true,
                  endTime: true,
                  staff: { select: { name: true } },
                },
                orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
              });
              replyText = formatBusinessHoursReply(
                hours.map((hour) => ({ ...hour, staffName: hour.staff.name })),
              );
            } else {
              const faqs = await transaction.faq.findMany({
                where: { businessId: request.params.businessId, enabled: true },
                orderBy: { createdAt: 'asc' },
              });
              const matchingFaq = faqs.find((faq) =>
                faq.keywords.some((keyword) =>
                  normalizedText.includes(keyword.toLowerCase()),
                ),
              );
              if (intentResult.confidence < 0.6 && !matchingFaq) {
                await transaction.conversation.update({
                  where: { id: openConversation.id },
                  data: { status: ConversationStatus.HANDOFF },
                });
                replyText =
                  'I’m not fully sure how to help with that. I’ve asked a team member to take over this conversation.';
              } else {
                replyText =
                  matchingFaq?.answer ??
                  (intent === 'SERVICES'
                    ? services.length
                      ? `We offer: ${services
                          .map(
                            (service) =>
                              `${service.name} (${service.durationMinutes} min)`,
                          )
                          .join(', ')}.`
                      : 'The salon has not added any services yet.'
                    : intent === 'PRICING'
                      ? services.length
                        ? services
                            .map(
                              (service) =>
                                `${service.name}: ₹${(service.priceMinor / 100).toFixed(0)}`,
                            )
                            .join('\n')
                        : 'The salon has not added service prices yet.'
                      : intent === 'HUMAN'
                        ? 'I can ask a team member to take over this conversation. Please reply HUMAN or use the dashboard handoff action.'
                        : null);
              }
            }
          }
          if (replyText)
            await transaction.message.create({
              data: {
                businessId: request.params.businessId,
                conversationId: openConversation.id,
                direction: MessageDirection.OUTBOUND,
                messageType: 'text',
                textBody: replyText,
                status: MessageStatus.QUEUED,
              },
            });
        }
        return openConversation;
      });
      return reply.code(201).send({
        simulated: true,
        providerMessageId,
        conversationId: conversation.id,
      });
    },
  );

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const origin = `http://${request.headers.host ?? 'localhost'}`;
      const authRequest = new Request(new URL(request.url, origin), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(authRequest);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  app.get('/v1/me/businesses', async (request, reply) => {
    const userId = options.resolveUserId
      ? await options.resolveUserId(request)
      : ((
          await auth.api.getSession({
            headers: fromNodeHeaders(request.headers),
          })
        )?.user.id ?? null);
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });
    const memberships = await db.membership.findMany({
      where: { userId },
      select: {
        role: true,
        business: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map(({ business, role }) => ({ ...business, role }));
  });

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/whatsapp-connections',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return db.whatsAppConnection.findMany({
        where: { businessId: request.params.businessId },
        select: {
          id: true,
          phoneNumberId: true,
          displayPhoneNumber: true,
          enabled: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    },
  );

  app.put<{
    Params: { businessId: string };
    Body: { phoneNumberId: string; displayPhoneNumber?: string };
  }>(
    '/v1/businesses/:businessId/whatsapp-connections',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const phoneNumberId = request.body.phoneNumberId?.trim();
      if (!phoneNumberId)
        return reply.code(400).send({ error: 'invalid_phone_number_id' });
      const existing = await db.whatsAppConnection.findUnique({
        where: { phoneNumberId },
        select: { businessId: true },
      });
      if (existing && existing.businessId !== membership.businessId)
        return reply
          .code(409)
          .send({ error: 'phone_number_already_connected' });
      return db.whatsAppConnection.upsert({
        where: { phoneNumberId },
        create: {
          businessId: membership.businessId,
          phoneNumberId,
          displayPhoneNumber: request.body.displayPhoneNumber?.trim() || null,
          enabled: true,
        },
        update: {
          displayPhoneNumber: request.body.displayPhoneNumber?.trim() || null,
          enabled: true,
        },
      });
    },
  );

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/conversations',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return db.conversation.findMany({
        where: { businessId: request.params.businessId },
        orderBy: { lastMessageAt: 'desc' },
        include: {
          customer: { select: { displayName: true, phone: true } },
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 50,
            select: {
              id: true,
              direction: true,
              messageType: true,
              textBody: true,
              status: true,
              createdAt: true,
            },
          },
        },
      });
    },
  );

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/outbound-queue',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return db.message.findMany({
        where: {
          businessId: request.params.businessId,
          direction: MessageDirection.OUTBOUND,
          status: MessageStatus.QUEUED,
        },
        orderBy: { createdAt: 'asc' },
        include: {
          conversation: {
            select: { id: true, customer: { select: { phone: true } } },
          },
        },
      });
    },
  );

  app.post<{
    Params: { businessId: string; conversationId: string };
  }>(
    '/v1/businesses/:businessId/conversations/:conversationId/handoff',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const changed = await db.conversation.updateMany({
        where: {
          id: request.params.conversationId,
          businessId: membership.businessId,
          status: { not: ConversationStatus.CLOSED },
        },
        data: { status: ConversationStatus.HANDOFF },
      });
      if (changed.count)
        await recordAudit({
          businessId: membership.businessId,
          actorUserId: membership.userId,
          action: 'conversation.handoff',
          entityType: 'conversation',
          entityId: request.params.conversationId,
        });
      return changed.count
        ? { status: ConversationStatus.HANDOFF }
        : reply.code(404).send({ error: 'conversation_not_found' });
    },
  );

  app.post<{
    Params: { businessId: string; conversationId: string };
  }>(
    '/v1/businesses/:businessId/conversations/:conversationId/resume',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const changed = await db.conversation.updateMany({
        where: {
          id: request.params.conversationId,
          businessId: membership.businessId,
          status: ConversationStatus.HANDOFF,
        },
        data: { status: ConversationStatus.OPEN },
      });
      if (changed.count)
        await recordAudit({
          businessId: membership.businessId,
          actorUserId: membership.userId,
          action: 'conversation.resumed',
          entityType: 'conversation',
          entityId: request.params.conversationId,
        });
      return changed.count
        ? { status: ConversationStatus.OPEN }
        : reply.code(404).send({ error: 'handoff_conversation_not_found' });
    },
  );

  app.post<{
    Params: { businessId: string; conversationId: string };
    Body: { text: string };
  }>(
    '/v1/businesses/:businessId/conversations/:conversationId/messages',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const text = request.body.text?.trim();
      if (!text)
        return reply.code(400).send({ error: 'message_text_required' });
      const result = await db.$transaction(async (transaction) => {
        const conversation = await transaction.conversation.findFirst({
          where: {
            id: request.params.conversationId,
            businessId: membership.businessId,
          },
          select: { id: true, status: true },
        });
        if (!conversation) return { error: 'conversation_not_found' as const };
        if (conversation.status !== ConversationStatus.HANDOFF)
          return { error: 'conversation_not_in_handoff' as const };
        const message = await transaction.message.create({
          data: {
            businessId: membership.businessId,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            messageType: 'text',
            textBody: text,
            status: MessageStatus.QUEUED,
          },
        });
        await transaction.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date() },
        });
        return { message };
      });
      if ('error' in result)
        return reply
          .code(result.error === 'conversation_not_found' ? 404 : 409)
          .send({ error: result.error });
      await recordAudit({
        businessId: membership.businessId,
        actorUserId: membership.userId,
        action: 'conversation.manual_reply_queued',
        entityType: 'conversation',
        entityId: request.params.conversationId,
      });
      return reply.code(201).send(result.message);
    },
  );

  app.patch<{
    Params: { businessId: string; id: string };
    Body: {
      status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
      providerMessageId?: string;
    };
  }>(
    '/v1/businesses/:businessId/outbound-queue/:id',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const changed = await db.message.updateMany({
        where: {
          id: request.params.id,
          businessId: membership.businessId,
          direction: MessageDirection.OUTBOUND,
          status: MessageStatus.QUEUED,
        },
        data: {
          status: request.body.status,
          ...(request.body.providerMessageId
            ? { providerMessageId: request.body.providerMessageId }
            : {}),
        },
      });
      return changed.count
        ? { updated: true }
        : reply.code(404).send({ error: 'queued_message_not_found' });
    },
  );

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/faqs',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return db.faq.findMany({
        where: { businessId: request.params.businessId },
        orderBy: { createdAt: 'asc' },
      });
    },
  );

  app.post<{
    Params: { businessId: string };
    Body: { question: string; answer: string; keywords: string[] };
  }>('/v1/businesses/:businessId/faqs', async (request, reply) => {
    const membership = await authorize(
      request,
      reply,
      request.params.businessId,
    );
    if (!membership) return;
    if (!['OWNER', 'MANAGER'].includes(membership.role))
      return reply.code(403).send({ error: 'insufficient_permissions' });
    const question = request.body.question?.trim();
    const answer = request.body.answer?.trim();
    const keywords = Array.isArray(request.body.keywords)
      ? [
          ...new Set(
            request.body.keywords
              .map((keyword) => keyword.trim().toLowerCase())
              .filter(Boolean),
          ),
        ]
      : [];
    if (!question || !answer || keywords.length === 0)
      return reply.code(400).send({ error: 'invalid_faq' });
    return reply.code(201).send(
      await db.faq.create({
        data: {
          businessId: membership.businessId,
          question,
          answer,
          keywords,
          enabled: true,
        },
      }),
    );
  });

  app.patch<{
    Params: { businessId: string; id: string };
    Body: {
      question?: string;
      answer?: string;
      keywords?: string[];
      enabled?: boolean;
    };
  }>('/v1/businesses/:businessId/faqs/:id', async (request, reply) => {
    const membership = await authorize(
      request,
      reply,
      request.params.businessId,
    );
    if (!membership) return;
    if (!['OWNER', 'MANAGER'].includes(membership.role))
      return reply.code(403).send({ error: 'insufficient_permissions' });
    const { question, answer, keywords, enabled } = request.body;
    const normalizedKeywords = keywords
      ? [
          ...new Set(
            keywords
              .map((keyword) => keyword.trim().toLowerCase())
              .filter(Boolean),
          ),
        ]
      : undefined;
    if (
      (question !== undefined && !question.trim()) ||
      (answer !== undefined && !answer.trim()) ||
      (normalizedKeywords !== undefined && normalizedKeywords.length === 0)
    )
      return reply.code(400).send({ error: 'invalid_faq' });
    const changed = await db.faq.updateMany({
      where: { id: request.params.id, businessId: membership.businessId },
      data: {
        ...(question !== undefined ? { question: question.trim() } : {}),
        ...(answer !== undefined ? { answer: answer.trim() } : {}),
        ...(normalizedKeywords !== undefined
          ? { keywords: normalizedKeywords }
          : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
    });
    return changed.count
      ? { updated: true }
      : reply.code(404).send({ error: 'faq_not_found' });
  });

  app.delete<{ Params: { businessId: string; id: string } }>(
    '/v1/businesses/:businessId/faqs/:id',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const removed = await db.faq.deleteMany({
        where: { id: request.params.id, businessId: membership.businessId },
      });
      return removed.count
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'faq_not_found' });
    },
  );

  app.patch<{
    Params: { businessId: string; id: string };
    Body: { optedOut: boolean };
  }>(
    '/v1/businesses/:businessId/customers/:id/consent',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      if (typeof request.body.optedOut !== 'boolean')
        return reply.code(400).send({ error: 'invalid_consent' });
      const changed = await db.customer.updateMany({
        where: {
          id: request.params.id,
          businessId: membership.businessId,
        },
        data: { optedOut: request.body.optedOut },
      });
      if (changed.count)
        await recordAudit({
          businessId: membership.businessId,
          actorUserId: membership.userId,
          action: 'customer.consent.updated',
          entityType: 'customer',
          entityId: request.params.id,
          metadata: { optedOut: request.body.optedOut },
        });
      return changed.count
        ? { updated: true, optedOut: request.body.optedOut }
        : reply.code(404).send({ error: 'customer_not_found' });
    },
  );

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/reminder-jobs',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return db.reminderJob.findMany({
        where: { businessId: request.params.businessId },
        orderBy: { scheduledFor: 'asc' },
        take: 100,
        select: {
          id: true,
          appointmentId: true,
          kind: true,
          scheduledFor: true,
          status: true,
          attempts: true,
          sentAt: true,
          lastError: true,
          appointment: {
            select: {
              startsAt: true,
              status: true,
              customer: {
                select: { phone: true, displayName: true, optedOut: true },
              },
              service: { select: { name: true } },
            },
          },
        },
      });
    },
  );

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/message-templates',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return db.messageTemplate.findMany({
        where: { businessId: request.params.businessId },
        orderBy: { createdAt: 'asc' },
      });
    },
  );

  app.post<{
    Params: { businessId: string };
    Body: {
      name: string;
      language?: string;
      category?: string;
      bodyPreview: string;
      providerTemplateId?: string;
      status?:
        'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'DISABLED';
    };
  }>('/v1/businesses/:businessId/message-templates', async (request, reply) => {
    const membership = await authorize(
      request,
      reply,
      request.params.businessId,
    );
    if (!membership) return;
    if (!['OWNER', 'MANAGER'].includes(membership.role))
      return reply.code(403).send({ error: 'insufficient_permissions' });
    const name = request.body.name?.trim();
    const bodyPreview = request.body.bodyPreview?.trim();
    if (!name || !bodyPreview)
      return reply.code(400).send({ error: 'invalid_message_template' });
    const created = await db.messageTemplate.create({
      data: {
        businessId: membership.businessId,
        name,
        language: request.body.language?.trim() || 'en_US',
        category: request.body.category?.trim() || 'UTILITY',
        bodyPreview,
        providerTemplateId: request.body.providerTemplateId?.trim() || null,
        status: request.body.status ?? 'DRAFT',
      },
    });
    await recordAudit({
      businessId: membership.businessId,
      actorUserId: membership.userId,
      action: 'message_template.created',
      entityType: 'message_template',
      entityId: created.id,
      metadata: { name: created.name, status: created.status },
    });
    return reply.code(201).send(created);
  });

  app.patch<{
    Params: { businessId: string; id: string };
    Body: {
      bodyPreview?: string;
      providerTemplateId?: string | null;
      status?:
        'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'DISABLED';
      enabled?: boolean;
    };
  }>(
    '/v1/businesses/:businessId/message-templates/:id',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      if (
        request.body.bodyPreview !== undefined &&
        !request.body.bodyPreview.trim()
      )
        return reply.code(400).send({ error: 'invalid_message_template' });
      const changed = await db.messageTemplate.updateMany({
        where: { id: request.params.id, businessId: membership.businessId },
        data: {
          ...(request.body.bodyPreview !== undefined
            ? { bodyPreview: request.body.bodyPreview.trim() }
            : {}),
          ...(request.body.providerTemplateId !== undefined
            ? {
                providerTemplateId:
                  request.body.providerTemplateId?.trim() || null,
              }
            : {}),
          ...(request.body.status !== undefined
            ? { status: request.body.status }
            : {}),
          ...(request.body.enabled !== undefined
            ? { enabled: request.body.enabled }
            : {}),
        },
      });
      if (changed.count)
        await recordAudit({
          businessId: membership.businessId,
          actorUserId: membership.userId,
          action: 'message_template.updated',
          entityType: 'message_template',
          entityId: request.params.id,
          metadata: {
            status: request.body.status ?? null,
            enabled: request.body.enabled ?? null,
          },
        });
      return changed.count
        ? { updated: true }
        : reply.code(404).send({ error: 'message_template_not_found' });
    },
  );

  app.get<{
    Params: { businessId: string };
    Querystring: { limit?: number };
  }>('/v1/businesses/:businessId/audit-logs', async (request, reply) => {
    if (!(await authorize(request, reply, request.params.businessId))) return;
    return db.auditLog.findMany({
      where: { businessId: request.params.businessId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(request.query.limit ?? 50, 1), 200),
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        createdAt: true,
        actor: { select: { email: true, name: true } },
      },
    });
  });

  async function authorize(
    request: { headers: IncomingHttpHeaders },
    reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    businessId: string,
  ) {
    const userId = options.resolveUserId
      ? await options.resolveUserId(request)
      : ((
          await auth.api.getSession({
            headers: fromNodeHeaders(request.headers),
          })
        )?.user.id ?? null);
    if (!userId) {
      reply.code(401).send({ error: 'unauthenticated' });
      return null;
    }
    const membership = await getMembership(db, { userId, businessId });
    if (!membership) {
      reply.code(403).send({ error: 'business_access_denied' });
      return null;
    }
    return membership;
  }

  async function resolveActorUserId(request: { headers: IncomingHttpHeaders }) {
    return options.resolveUserId
      ? await options.resolveUserId(request)
      : ((
          await auth.api.getSession({
            headers: fromNodeHeaders(request.headers),
          })
        )?.user.id ?? null);
  }

  async function recordAudit(input: {
    businessId?: string;
    actorUserId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: Prisma.InputJsonObject;
  }) {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      action: input.action,
      entityType: input.entityType,
      ...(input.businessId ? { businessId: input.businessId } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await db.auditLog.create({
      data,
    });
  }

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/services',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return createServiceRepository(db, request.params.businessId).list();
    },
  );

  app.post<{
    Params: { businessId: string };
    Body: { name: string; durationMinutes: number; priceMinor: number };
  }>('/v1/businesses/:businessId/services', async (request, reply) => {
    const membership = await authorize(
      request,
      reply,
      request.params.businessId,
    );
    if (!membership) return;
    if (!['OWNER', 'MANAGER'].includes(membership.role))
      return reply.code(403).send({ error: 'insufficient_permissions' });
    const { name, durationMinutes, priceMinor } = request.body;
    if (
      !name?.trim() ||
      !Number.isInteger(durationMinutes) ||
      durationMinutes < 1 ||
      !Number.isInteger(priceMinor) ||
      priceMinor < 0
    )
      return reply.code(400).send({ error: 'invalid_service' });
    return reply.code(201).send(
      await createServiceRepository(db, membership.businessId).create({
        name: name.trim(),
        durationMinutes,
        priceMinor,
        enabled: true,
      }),
    );
  });

  app.get<{ Params: { businessId: string } }>(
    '/v1/businesses/:businessId/staff',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      return createStaffRepository(db, request.params.businessId).list();
    },
  );

  app.post<{ Params: { businessId: string }; Body: { name: string } }>(
    '/v1/businesses/:businessId/staff',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const name = request.body.name?.trim();
      if (!name) return reply.code(400).send({ error: 'invalid_staff' });
      return reply.code(201).send(
        await createStaffRepository(db, membership.businessId).create({
          name,
          enabled: true,
        }),
      );
    },
  );

  app.patch<{
    Params: { businessId: string; id: string };
    Body: {
      name?: string;
      durationMinutes?: number;
      priceMinor?: number;
      enabled?: boolean;
    };
  }>('/v1/businesses/:businessId/services/:id', async (request, reply) => {
    const membership = await authorize(
      request,
      reply,
      request.params.businessId,
    );
    if (!membership) return;
    if (!['OWNER', 'MANAGER'].includes(membership.role))
      return reply.code(403).send({ error: 'insufficient_permissions' });
    const { name, durationMinutes, priceMinor, enabled } = request.body;
    if (
      (name !== undefined && !name.trim()) ||
      (durationMinutes !== undefined &&
        (!Number.isInteger(durationMinutes) || durationMinutes < 1)) ||
      (priceMinor !== undefined &&
        (!Number.isInteger(priceMinor) || priceMinor < 0))
    )
      return reply.code(400).send({ error: 'invalid_service' });
    const changed = await createServiceRepository(
      db,
      membership.businessId,
    ).update(request.params.id, {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      ...(priceMinor !== undefined ? { priceMinor } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    return changed
      ? { updated: true }
      : reply.code(404).send({ error: 'service_not_found' });
  });

  app.delete<{ Params: { businessId: string; id: string } }>(
    '/v1/businesses/:businessId/services/:id',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const removed = await createServiceRepository(
        db,
        membership.businessId,
      ).remove(request.params.id);
      return removed
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'service_not_found' });
    },
  );

  app.patch<{
    Params: { businessId: string; id: string };
    Body: { name?: string; enabled?: boolean };
  }>('/v1/businesses/:businessId/staff/:id', async (request, reply) => {
    const membership = await authorize(
      request,
      reply,
      request.params.businessId,
    );
    if (!membership) return;
    if (!['OWNER', 'MANAGER'].includes(membership.role))
      return reply.code(403).send({ error: 'insufficient_permissions' });
    const { name, enabled } = request.body;
    if (name !== undefined && !name.trim())
      return reply.code(400).send({ error: 'invalid_staff' });
    const changed = await createStaffRepository(
      db,
      membership.businessId,
    ).update(request.params.id, {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    return changed
      ? { updated: true }
      : reply.code(404).send({ error: 'staff_not_found' });
  });

  app.delete<{ Params: { businessId: string; id: string } }>(
    '/v1/businesses/:businessId/staff/:id',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const removed = await createStaffRepository(
        db,
        membership.businessId,
      ).remove(request.params.id);
      return removed
        ? reply.code(204).send()
        : reply.code(404).send({ error: 'staff_not_found' });
    },
  );

  app.get<{ Params: { businessId: string; staffId: string } }>(
    '/v1/businesses/:businessId/staff/:staffId/working-hours',
    async (request, reply) => {
      if (!(await authorize(request, reply, request.params.businessId))) return;
      const staff = await db.staff.findFirst({
        where: {
          id: request.params.staffId,
          businessId: request.params.businessId,
        },
        select: { id: true },
      });
      if (!staff) return reply.code(404).send({ error: 'staff_not_found' });
      return db.workingHour.findMany({
        where: { staffId: staff.id },
        orderBy: { dayOfWeek: 'asc' },
      });
    },
  );

  app.put<{
    Params: { businessId: string; staffId: string };
    Body: {
      hours: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
    };
  }>(
    '/v1/businesses/:businessId/staff/:staffId/working-hours',
    async (request, reply) => {
      const membership = await authorize(
        request,
        reply,
        request.params.businessId,
      );
      if (!membership) return;
      if (!['OWNER', 'MANAGER'].includes(membership.role))
        return reply.code(403).send({ error: 'insufficient_permissions' });
      const staff = await db.staff.findFirst({
        where: {
          id: request.params.staffId,
          businessId: request.params.businessId,
        },
        select: { id: true },
      });
      if (!staff) return reply.code(404).send({ error: 'staff_not_found' });
      const hours = request.body.hours ?? [];
      const valid =
        hours.length <= 7 &&
        hours.every(
          ({ dayOfWeek, startTime, endTime }) =>
            Number.isInteger(dayOfWeek) &&
            dayOfWeek >= 0 &&
            dayOfWeek <= 6 &&
            /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) &&
            /^([01]\d|2[0-3]):[0-5]\d$/.test(endTime) &&
            startTime < endTime,
        );
      if (
        !valid ||
        new Set(hours.map(({ dayOfWeek }) => dayOfWeek)).size !== hours.length
      )
        return reply.code(400).send({ error: 'invalid_working_hours' });
      return db.$transaction(async (transaction) => {
        await transaction.workingHour.deleteMany({
          where: { staffId: staff.id },
        });
        if (hours.length)
          await transaction.workingHour.createMany({
            data: hours.map((hour) => ({ ...hour, staffId: staff.id })),
          });
        return transaction.workingHour.findMany({
          where: { staffId: staff.id },
          orderBy: { dayOfWeek: 'asc' },
        });
      });
    },
  );

  app.get<{
    Params: { businessId: string };
    Querystring: { date?: string; serviceId?: string; staffId?: string };
  }>('/v1/businesses/:businessId/availability', async (request, reply) => {
    if (!(await authorize(request, reply, request.params.businessId))) return;
    const { date, serviceId, staffId } = request.query;
    if (!date || !isValidDateOnly(date) || !serviceId) {
      return reply.code(400).send({ error: 'date_and_service_required' });
    }

    const business = await db.business.findUnique({
      where: { id: request.params.businessId },
      select: { id: true, timezone: true },
    });
    const service = await db.service.findFirst({
      where: {
        id: serviceId,
        businessId: request.params.businessId,
        enabled: true,
      },
      select: { id: true, name: true, durationMinutes: true },
    });
    if (!business || !service)
      return reply.code(404).send({ error: 'service_not_found' });

    const requestedStaff = staffId
      ? await db.staff.findFirst({
          where: {
            id: staffId,
            businessId: business.id,
            enabled: true,
          },
          select: { id: true, name: true },
        })
      : null;
    if (staffId && !requestedStaff)
      return reply.code(404).send({ error: 'staff_not_found' });

    const staff = requestedStaff
      ? [requestedStaff]
      : await db.staff.findMany({
          where: { businessId: business.id, enabled: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        });
    const dayStart = localDateTimeToUtc(date, '00:00', business.timezone);
    const nextDate = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
    const results: Array<{
      staffId: string;
      staffName: string;
      startAt: string;
      endAt: string;
    }> = [];

    for (const member of staff) {
      const [workingHours, timeOff, appointments] = await Promise.all([
        db.workingHour.findMany({
          where: { staffId: member.id, dayOfWeek },
          orderBy: { startTime: 'asc' },
        }),
        db.timeOff.findMany({
          where: {
            staffId: member.id,
            startsAt: { lt: nextDate },
            endsAt: { gt: dayStart },
          },
        }),
        db.appointment.findMany({
          where: {
            staffId: member.id,
            startsAt: { lt: nextDate },
            endsAt: { gt: dayStart },
            status: { in: unavailableAppointmentStatuses },
          },
          select: { startsAt: true, endsAt: true },
        }),
      ]);

      for (const hours of workingHours) {
        const startMinutes = minutesFromTime(hours.startTime);
        const endMinutes = minutesFromTime(hours.endTime);
        for (
          let start = startMinutes;
          start + service.durationMinutes <= endMinutes;
          start += 30
        ) {
          const startAt = new Date(
            localDateTimeToUtc(
              date,
              `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
              business.timezone,
            ),
          );
          const endAt = new Date(
            startAt.getTime() + service.durationMinutes * 60 * 1000,
          );
          const overlaps = [...timeOff, ...appointments].some(
            (blocked) => startAt < blocked.endsAt && endAt > blocked.startsAt,
          );
          if (!overlaps)
            results.push({
              staffId: member.id,
              staffName: member.name,
              startAt: startAt.toISOString(),
              endAt: endAt.toISOString(),
            });
        }
      }
    }

    return { date, service, slots: results };
  });

  app.get<{
    Params: { businessId: string };
    Querystring: { from?: string; to?: string };
  }>('/v1/businesses/:businessId/appointments', async (request, reply) => {
    if (!(await authorize(request, reply, request.params.businessId))) return;
    const from = request.query.from ? new Date(request.query.from) : new Date();
    const to = request.query.to
      ? new Date(request.query.to)
      : new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from >= to
    )
      return reply.code(400).send({ error: 'invalid_appointment_range' });
    return db.appointment.findMany({
      where: {
        businessId: request.params.businessId,
        startsAt: { gte: from, lt: to },
      },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        customer: { select: { displayName: true, phone: true } },
        service: { select: { name: true } },
        staff: { select: { name: true } },
      },
      orderBy: { startsAt: 'asc' },
    });
  });

  app.post<{
    Params: { businessId: string };
    Body: {
      customerPhone: string;
      customerName?: string;
      serviceId: string;
      staffId: string;
      startsAt: string;
    };
  }>('/v1/businesses/:businessId/appointments', async (request, reply) => {
    const membership = await authorize(
      request,
      reply,
      request.params.businessId,
    );
    if (!membership) return;
    if (!['OWNER', 'MANAGER'].includes(membership.role))
      return reply.code(403).send({ error: 'insufficient_permissions' });

    const { customerPhone, customerName, serviceId, staffId, startsAt } =
      request.body;
    const start = new Date(startsAt);
    if (
      !customerPhone?.trim() ||
      !serviceId ||
      !staffId ||
      Number.isNaN(start.getTime()) ||
      start <= new Date()
    )
      return reply.code(400).send({ error: 'invalid_appointment' });

    const business = await db.business.findUnique({
      where: { id: request.params.businessId },
      select: { id: true, timezone: true },
    });
    const service = await db.service.findFirst({
      where: {
        id: serviceId,
        businessId: request.params.businessId,
        enabled: true,
      },
      select: { id: true, durationMinutes: true },
    });
    const staffMember = await db.staff.findFirst({
      where: {
        id: staffId,
        businessId: request.params.businessId,
        enabled: true,
      },
      select: { id: true },
    });
    if (!business || !service)
      return reply.code(404).send({ error: 'service_not_found' });
    if (!staffMember) return reply.code(404).send({ error: 'staff_not_found' });

    const end = new Date(start.getTime() + service.durationMinutes * 60 * 1000);
    const localStart = localParts(start, business.timezone);
    const localEnd = localParts(end, business.timezone);
    if (localStart.date !== localEnd.date)
      return reply.code(400).send({ error: 'appointment_outside_hours' });
    const dayOfWeek = new Date(`${localStart.date}T00:00:00Z`).getUTCDay();
    const workingHour = await db.workingHour.findFirst({
      where: { staffId: staffMember.id, dayOfWeek },
    });
    if (
      !workingHour ||
      localStart.time < workingHour.startTime ||
      localEnd.time > workingHour.endTime
    )
      return reply.code(400).send({ error: 'appointment_outside_hours' });

    const timeOff = await db.timeOff.findFirst({
      where: {
        staffId: staffMember.id,
        startsAt: { lt: end },
        endsAt: { gt: start },
      },
      select: { id: true },
    });
    if (timeOff) return reply.code(409).send({ error: 'staff_unavailable' });

    try {
      const result = await db.$transaction(
        async (transaction) => {
          const conflict = await transaction.appointment.findFirst({
            where: {
              staffId: staffMember.id,
              startsAt: { lt: end },
              endsAt: { gt: start },
              status: { in: unavailableAppointmentStatuses },
            },
            select: { id: true },
          });
          if (conflict) return null;
          const customer = await transaction.customer.upsert({
            where: {
              businessId_phone: {
                businessId: business.id,
                phone: customerPhone.trim(),
              },
            },
            create: {
              businessId: business.id,
              phone: customerPhone.trim(),
              displayName: customerName?.trim() || null,
            },
            update: {
              ...(customerName?.trim()
                ? { displayName: customerName.trim() }
                : {}),
            },
          });
          return transaction.appointment.create({
            data: {
              businessId: business.id,
              customerId: customer.id,
              serviceId: service.id,
              staffId: staffMember.id,
              startsAt: start,
              endsAt: end,
              status: AppointmentStatus.CONFIRMED,
              source: 'dashboard',
            },
          });
        },
        { isolationLevel: 'Serializable' },
      );
      if (!result) return reply.code(409).send({ error: 'slot_unavailable' });
      const actorUserId = await resolveActorUserId(request);
      await recordAudit({
        businessId: business.id,
        ...(actorUserId ? { actorUserId } : {}),
        action: 'appointment.created',
        entityType: 'appointment',
        entityId: result.id,
        metadata: { source: 'dashboard' },
      });
      return reply.code(201).send(result);
    } catch (cause: unknown) {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'P2034'
      )
        return reply.code(409).send({ error: 'slot_unavailable' });
      throw cause;
    }
  });

  return app;
}
