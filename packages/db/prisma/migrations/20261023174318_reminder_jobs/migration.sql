-- CreateEnum
CREATE TYPE "ReminderJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "reminder_jobs" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "ReminderJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "customerId" UUID,

    CONSTRAINT "reminder_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminder_jobs_businessId_status_scheduledFor_idx" ON "reminder_jobs"("businessId", "status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_jobs_appointmentId_kind_key" ON "reminder_jobs"("appointmentId", "kind");

-- AddForeignKey
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_jobs" ADD CONSTRAINT "reminder_jobs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
