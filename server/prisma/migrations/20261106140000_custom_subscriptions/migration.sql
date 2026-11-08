-- DropIndex
DROP INDEX "SubscriptionPlan_code_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SubscriptionPlan";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "monthlyAmount" DECIMAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "durationMonths" INTEGER NOT NULL DEFAULT 1,
    "maxWarehouses" INTEGER,
    "maxUsers" INTEGER,
    "maxDrivers" INTEGER,
    "maxVehicles" INTEGER,
    "maxDeliveriesMonth" INTEGER,
    "gpsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "status" TEXT NOT NULL DEFAULT 'TRIAL',
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" DATETIME NOT NULL,
    "graceEndsAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Subscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Subscription" ("companyId", "createdAt", "endsAt", "graceEndsAt", "id", "isCurrent", "startsAt", "status", "updatedAt") SELECT "companyId", "createdAt", "endsAt", "graceEndsAt", "id", "isCurrent", "startsAt", "status", "updatedAt" FROM "Subscription";
DROP TABLE "Subscription";
ALTER TABLE "new_Subscription" RENAME TO "Subscription";
CREATE INDEX "Subscription_companyId_isCurrent_idx" ON "Subscription"("companyId", "isCurrent");
CREATE INDEX "Subscription_status_endsAt_idx" ON "Subscription"("status", "endsAt");
CREATE TABLE "new_SubscriptionInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "monthlyAmount" DECIMAL NOT NULL DEFAULT 0,
    "durationMonths" INTEGER NOT NULL DEFAULT 1,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "amount" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNPAID',
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" DATETIME,
    CONSTRAINT "SubscriptionInvoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SubscriptionInvoice" ("amount", "companyId", "currency", "id", "issuedAt", "number", "paidAt", "periodEnd", "periodStart", "status", "subscriptionId") SELECT "amount", "companyId", "currency", "id", "issuedAt", "number", "paidAt", "periodEnd", "periodStart", "status", "subscriptionId" FROM "SubscriptionInvoice";
DROP TABLE "SubscriptionInvoice";
ALTER TABLE "new_SubscriptionInvoice" RENAME TO "SubscriptionInvoice";
CREATE UNIQUE INDEX "SubscriptionInvoice_number_key" ON "SubscriptionInvoice"("number");
CREATE INDEX "SubscriptionInvoice_companyId_idx" ON "SubscriptionInvoice"("companyId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

