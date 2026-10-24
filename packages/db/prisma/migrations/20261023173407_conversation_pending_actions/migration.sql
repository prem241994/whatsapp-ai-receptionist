-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "pendingAction" TEXT,
ADD COLUMN     "pendingAppointmentId" UUID;
