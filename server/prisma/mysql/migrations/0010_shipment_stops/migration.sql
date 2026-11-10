-- Escales prévues des expéditions : nouvelle table, rien d'existant ne change.
-- CreateTable
CREATE TABLE `ShipmentStop` (
    `id` VARCHAR(191) NOT NULL,
    `shipmentId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL,
    `warehouseId` VARCHAR(191) NOT NULL,
    `arrivedAt` DATETIME(3) NULL,
    `departedAt` DATETIME(3) NULL,
    `skipped` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `ShipmentStop_shipmentId_position_key`(`shipmentId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ShipmentStop` ADD CONSTRAINT `ShipmentStop_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShipmentStop` ADD CONSTRAINT `ShipmentStop_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

