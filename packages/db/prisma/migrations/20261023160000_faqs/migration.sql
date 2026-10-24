CREATE TABLE "faqs" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "keywords" TEXT[] NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "faqs_businessId_enabled_idx" ON "faqs"("businessId", "enabled");
ALTER TABLE "faqs" ADD CONSTRAINT "faqs_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
