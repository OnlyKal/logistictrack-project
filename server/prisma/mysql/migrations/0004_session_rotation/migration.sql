-- AlterTable
ALTER TABLE `UserSession` ADD COLUMN `generation` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `refreshSalt` VARCHAR(191) NULL;

