-- AlterTable
ALTER TABLE `CompanySettings` ADD COLUMN `customerEmailDelivered` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `customerEmailEnRoute` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `customerEmailFailed` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Customer` ADD COLUMN `emailNotifications` BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE `EmailLog` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `kind` VARCHAR(191) NOT NULL,
    `recipient` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `error` TEXT NULL,
    `dedupeKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailLog_dedupeKey_key`(`dedupeKey`),
    INDEX `EmailLog_createdAt_idx`(`createdAt`),
    INDEX `EmailLog_companyId_createdAt_idx`(`companyId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

