CREATE TABLE "whatsapp_connections" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "webhook_events" ADD COLUMN "businessId" UUID;
ALTER TABLE "webhook_events" ADD COLUMN "phoneNumberId" TEXT;

CREATE UNIQUE INDEX "whatsapp_connections_phoneNumberId_key" ON "whatsapp_connections"("phoneNumberId");
CREATE INDEX "whatsapp_connections_businessId_enabled_idx" ON "whatsapp_connections"("businessId", "enabled");
CREATE INDEX "webhook_events_businessId_receivedAt_idx" ON "webhook_events"("businessId", "receivedAt");

ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
