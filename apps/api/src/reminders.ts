import {
  AppointmentStatus,
  ConversationStatus,
  MessageDirection,
  MessageStatus,
  ReminderJobStatus,
} from '@prisma/client';
import { db } from '@whatsapp-receptionist/db';

const reminderKind = '24_HOUR_APPOINTMENT';

function formatReminderDate(value: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: true,
  }).format(value);
}

export async function scheduleAppointmentReminders(options: {
  businessId?: string;
  now?: Date;
  horizonDays?: number;
}) {
  const now = options.now ?? new Date();
  const horizon = new Date(
    now.getTime() + (options.horizonDays ?? 30) * 24 * 60 * 60 * 1000,
  );
  const appointments = await db.appointment.findMany({
    where: {
      ...(options.businessId ? { businessId: options.businessId } : {}),
      status: AppointmentStatus.CONFIRMED,
      startsAt: { gt: now, lte: horizon },
      customer: { optedOut: false },
    },
    select: { id: true, businessId: true, startsAt: true },
  });
  let created = 0;
  for (const appointment of appointments) {
    const scheduledFor = new Date(
      Math.max(
        now.getTime(),
        appointment.startsAt.getTime() - 24 * 60 * 60 * 1000,
      ),
    );
    const existing = await db.reminderJob.findUnique({
      where: {
        appointmentId_kind: {
          appointmentId: appointment.id,
          kind: reminderKind,
        },
      },
      select: { id: true },
    });
    if (existing) continue;
    await db.reminderJob.create({
      data: {
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        kind: reminderKind,
        scheduledFor,
      },
    });
    created += 1;
  }
  return { examined: appointments.length, created };
}

export async function processReminderQueue(options: {
  limit?: number;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const jobs = await db.reminderJob.findMany({
    where: {
      status: ReminderJobStatus.PENDING,
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: 'asc' },
    take: Math.min(Math.max(options.limit ?? 20, 1), 100),
    include: {
      appointment: {
        include: {
          business: { select: { timezone: true } },
          customer: { select: { id: true, optedOut: true } },
          service: { select: { name: true } },
          staff: { select: { name: true } },
        },
      },
    },
  });
  let queued = 0;
  let cancelled = 0;
  let failed = 0;
  for (const job of jobs) {
    const claimed = await db.reminderJob.updateMany({
      where: { id: job.id, status: ReminderJobStatus.PENDING },
      data: {
        status: ReminderJobStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) continue;
    try {
      if (
        job.appointment.status !== AppointmentStatus.CONFIRMED ||
        job.appointment.customer.optedOut
      ) {
        await db.reminderJob.update({
          where: { id: job.id },
          data: { status: ReminderJobStatus.CANCELLED },
        });
        cancelled += 1;
        continue;
      }
      await db.$transaction(async (transaction) => {
        let conversation = await transaction.conversation.findFirst({
          where: {
            businessId: job.businessId,
            customerId: job.appointment.customer.id,
            status: ConversationStatus.OPEN,
          },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (!conversation) {
          conversation = await transaction.conversation.create({
            data: {
              businessId: job.businessId,
              customerId: job.appointment.customer.id,
              status: ConversationStatus.OPEN,
            },
          });
        }
        const body = `Reminder: you have a ${job.appointment.service.name} appointment with ${job.appointment.staff.name} on ${formatReminderDate(job.appointment.startsAt, job.appointment.business.timezone)}. Reply HUMAN if you need help.`;
        await transaction.message.create({
          data: {
            businessId: job.businessId,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            messageType: 'text',
            textBody: body,
            status: MessageStatus.QUEUED,
          },
        });
        await transaction.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date() },
        });
        await transaction.reminderJob.update({
          where: { id: job.id },
          data: { status: ReminderJobStatus.SENT, sentAt: new Date() },
        });
      });
      queued += 1;
    } catch (cause) {
      await db.reminderJob.update({
        where: { id: job.id },
        data: {
          status: ReminderJobStatus.FAILED,
          lastError: cause instanceof Error ? cause.message : 'unknown_error',
        },
      });
      failed += 1;
    }
  }
  return { examined: jobs.length, queued, cancelled, failed };
}
