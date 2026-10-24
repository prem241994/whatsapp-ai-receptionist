-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DISABLED');

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en_US',
    "category" TEXT NOT NULL DEFAULT 'UTILITY',
    "bodyPreview" TEXT NOT NULL,
    "providerTemplateId" TEXT,
    "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appointmentId" UUID,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_templates_businessId_status_enabled_idx" ON "message_templates"("businessId", "status", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_businessId_name_language_key" ON "message_templates"("businessId", "name", "language");

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
