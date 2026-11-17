-- AlterTable
ALTER TABLE "products" ADD COLUMN     "aiDraft" JSONB,
ADD COLUMN     "brandVersion" INTEGER,
ADD COLUMN     "visibleCharacteristics" TEXT[] DEFAULT ARRAY[]::TEXT[];
