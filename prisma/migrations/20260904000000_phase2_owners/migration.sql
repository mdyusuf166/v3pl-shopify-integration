-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('VENDOR', 'THREEPL_CLIENT');

-- CreateEnum
CREATE TYPE "OwnerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedEmail" TEXT,
ADD COLUMN     "ownerId" TEXT;

-- CreateTable
CREATE TABLE "Owner" (
    "id" TEXT NOT NULL,
    "type" "OwnerType" NOT NULL,
    "code" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "notes" TEXT,
    "status" "OwnerStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Owner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Owner_code_key" ON "Owner"("code");

-- CreateIndex
CREATE INDEX "Owner_type_status_idx" ON "Owner"("type", "status");

-- CreateIndex
CREATE INDEX "Owner_businessName_idx" ON "Owner"("businessName");

-- CreateIndex
CREATE INDEX "User_ownerId_idx" ON "User"("ownerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Business rule (D-003 / D-037, hand-written): portal roles must belong to an owner,
-- staff roles must not. Prisma does not model CHECK constraints; keep this in sync manually.
ALTER TABLE "User" ADD CONSTRAINT "User_owner_role_check"
  CHECK ((("role" IN ('VENDOR', 'THREEPL_CLIENT')) AND ("ownerId" IS NOT NULL))
      OR (("role" NOT IN ('VENDOR', 'THREEPL_CLIENT')) AND ("ownerId" IS NULL)));
