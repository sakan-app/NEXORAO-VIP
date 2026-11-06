-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "variantId" UUID;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "category" TEXT,
ADD COLUMN     "cjPid" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "shippingUsd" DECIMAL(12,2),
ADD COLUMN     "supplierPriceUsd" DECIMAL(12,2),
ADD COLUMN     "variantDims" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "cjVid" TEXT NOT NULL,
    "sku" TEXT,
    "options" JSONB NOT NULL,
    "size" TEXT,
    "color" TEXT,
    "supplierPriceUsd" DECIMAL(12,2) NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "weightG" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_cjVid_key" ON "ProductVariant"("cjVid");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_active_idx" ON "ProductVariant"("productId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Product_cjPid_key" ON "Product"("cjPid");

-- CreateIndex
CREATE INDEX "Product_category_active_idx" ON "Product"("category", "active");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Same protection as the other tables: no access through the Supabase Data API.
ALTER TABLE "ProductVariant" ENABLE ROW LEVEL SECURITY;
