-- CreateTable
CREATE TABLE `MailSettings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `host` VARCHAR(191) NOT NULL,
    `port` INTEGER NOT NULL,
    `secure` BOOLEAN NOT NULL DEFAULT true,
    `user` VARCHAR(191) NOT NULL,
    `passwordEnc` TEXT NOT NULL,
    `fromAddress` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

