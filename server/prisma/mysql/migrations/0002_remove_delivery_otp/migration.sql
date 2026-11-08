-- AlterTable
ALTER TABLE `CompanySettings` DROP COLUMN `requireOtp`;

-- AlterTable
ALTER TABLE `Delivery` DROP COLUMN `otpExpiresAt`,
    DROP COLUMN `otpHash`;

