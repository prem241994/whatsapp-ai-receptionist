CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "senderPhone" TEXT,
    "messageType" TEXT,
    "textBody" TEXT,
    "payloadHash" TEXT NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_events_providerEventId_key" ON "webhook_events"("providerEventId");
CREATE INDEX "webhook_events_provider_receivedAt_idx" ON "webhook_events"("provider", "receivedAt");
CREATE INDEX "webhook_events_senderPhone_receivedAt_idx" ON "webhook_events"("senderPhone", "receivedAt");
