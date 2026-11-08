-- DropForeignKey
ALTER TABLE `Subscription` DROP FOREIGN KEY `Subscription_planId_fkey`;

-- AlterTable
ALTER TABLE `Subscription` DROP COLUMN `billingCycle`,
    DROP COLUMN `planId`,
    ADD COLUMN `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    ADD COLUMN `durationMonths` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `gpsEnabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `graceDays` INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN `maxDeliveriesMonth` INTEGER NULL,
    ADD COLUMN `maxDrivers` INTEGER NULL,
    ADD COLUMN `maxUsers` INTEGER NULL,
    ADD COLUMN `maxVehicles` INTEGER NULL,
    ADD COLUMN `maxWarehouses` INTEGER NULL,
    ADD COLUMN `monthlyAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `SubscriptionInvoice` ADD COLUMN `discountPercent` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `durationMonths` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `monthlyAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE `SubscriptionPlan`;

