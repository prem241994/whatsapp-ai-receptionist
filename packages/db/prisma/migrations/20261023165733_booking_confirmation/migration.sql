-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "pendingEndsAt" TIMESTAMP(3),
ADD COLUMN     "pendingServiceId" UUID,
ADD COLUMN     "pendingStaffId" UUID,
ADD COLUMN     "pendingStartsAt" TIMESTAMP(3);
