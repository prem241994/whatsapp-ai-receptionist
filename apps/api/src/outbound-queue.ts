import { MessageDirection, MessageStatus } from '@prisma/client';
import { db } from '@whatsapp-receptionist/db';
import { createMetaWhatsAppClient } from './integrations/whatsapp.js';

export async function processOutboundQueue(limit = 20) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) throw new Error('meta_outbound_not_configured');
  const queued = await db.message.findMany({
    where: {
      direction: MessageDirection.OUTBOUND,
      status: MessageStatus.QUEUED,
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 100),
    include: {
      conversation: { select: { customer: { select: { phone: true } } } },
    },
  });
  let sent = 0;
  let failed = 0;
  for (const message of queued) {
    const connection = await db.whatsAppConnection.findFirst({
      where: { businessId: message.businessId, enabled: true },
      select: { phoneNumberId: true },
    });
    if (!connection || !message.textBody) {
      await db.message.update({
        where: { id: message.id },
        data: { status: MessageStatus.FAILED },
      });
      failed += 1;
      continue;
    }
    try {
      const client = createMetaWhatsAppClient({
        accessToken,
        phoneNumberId: connection.phoneNumberId,
        ...(process.env.META_GRAPH_API_VERSION
          ? { graphApiVersion: process.env.META_GRAPH_API_VERSION }
          : {}),
      });
      const result = await client.sendText({
        to: message.conversation.customer.phone,
        body: message.textBody,
      });
      await db.message.update({
        where: { id: message.id },
        data: {
          providerMessageId: result.providerMessageId,
          status: MessageStatus.SENT,
        },
      });
      sent += 1;
    } catch {
      await db.message.update({
        where: { id: message.id },
        data: { status: MessageStatus.FAILED },
      });
      failed += 1;
    }
  }
  return { examined: queued.length, sent, failed };
}
