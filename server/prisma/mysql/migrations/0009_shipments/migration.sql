-- Expéditions (messagerie) : nouvelles tables, aucune table existante modifiée.
-- CreateTable
CREATE TABLE `Shipment` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `trackingNumber` VARCHAR(191) NOT NULL,
    `trackingToken` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'REGISTERED',
    `senderName` VARCHAR(191) NOT NULL,
    `senderPhone` VARCHAR(191) NOT NULL,
    `senderEmail` VARCHAR(191) NULL,
    `recipientName` VARCHAR(191) NOT NULL,
    `recipientPhone` VARCHAR(191) NOT NULL,
    `recipientEmail` VARCHAR(191) NULL,
    `description` VARCHAR(191) NOT NULL,
    `parcels` INTEGER NOT NULL DEFAULT 1,
    `weightKg` DECIMAL(18, 3) NULL,
    `declaredValue` DECIMAL(18, 2) NULL,
    `fee` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `paymentMode` VARCHAR(191) NOT NULL DEFAULT 'SENDER',
    `feePaidAt` DATETIME(3) NULL,
    `instructions` TEXT NULL,
    `originWarehouseId` VARCHAR(191) NOT NULL,
    `destinationWarehouseId` VARCHAR(191) NOT NULL,
    `currentWarehouseId` VARCHAR(191) NULL,
    `nextWarehouseId` VARCHAR(191) NULL,
    `transportInfo` VARCHAR(191) NULL,
    `pickedUpAt` DATETIME(3) NULL,
    `pickedUpBy` VARCHAR(191) NULL,
    `pickedUpPhone` VARCHAR(191) NULL,
    `pickedUpIdDocument` VARCHAR(191) NULL,
    `signatureFileId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Shipment_trackingNumber_key`(`trackingNumber`),
    UNIQUE INDEX `Shipment_trackingToken_key`(`trackingToken`),
    INDEX `Shipment_companyId_status_idx`(`companyId`, `status`),
    INDEX `Shipment_companyId_currentWarehouseId_status_idx`(`companyId`, `currentWarehouseId`, `status`),
    INDEX `Shipment_companyId_nextWarehouseId_status_idx`(`companyId`, `nextWarehouseId`, `status`),
    INDEX `Shipment_companyId_createdAt_idx`(`companyId`, `createdAt`),
    UNIQUE INDEX `Shipment_companyId_number_key`(`companyId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShipmentEvent` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `shipmentId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `warehouseId` VARCHAR(191) NULL,
    `place` VARCHAR(191) NULL,
    `isPublic` BOOLEAN NOT NULL DEFAULT true,
    `note` TEXT NULL,
    `userId` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShipmentEvent_shipmentId_occurredAt_idx`(`shipmentId`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_originWarehouseId_fkey` FOREIGN KEY (`originWarehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_destinationWarehouseId_fkey` FOREIGN KEY (`destinationWarehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_currentWarehouseId_fkey` FOREIGN KEY (`currentWarehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Shipment` ADD CONSTRAINT `Shipment_nextWarehouseId_fkey` FOREIGN KEY (`nextWarehouseId`) REFERENCES `Warehouse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShipmentEvent` ADD CONSTRAINT `ShipmentEvent_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `Shipment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

