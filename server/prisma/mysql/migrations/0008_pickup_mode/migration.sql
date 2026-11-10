-- Retrait en entrepôt : les livraisons existantes restent en livraison à domicile (HOME).
-- AlterTable
ALTER TABLE `Delivery` ADD COLUMN `availableAt` DATETIME(3) NULL,
    ADD COLUMN `heldAtWarehouseId` VARCHAR(191) NULL,
    ADD COLUMN `mode` VARCHAR(191) NOT NULL DEFAULT 'HOME',
    ADD COLUMN `pickupWarehouseId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Delivery_companyId_pickupWarehouseId_status_idx` ON `Delivery`(`companyId`, `pickupWarehouseId`, `status`);

-- AddForeignKey
ALTER TABLE `Delivery` ADD CONSTRAINT `Delivery_pickupWarehouseId_fkey` FOREIGN KEY (`pickupWarehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

