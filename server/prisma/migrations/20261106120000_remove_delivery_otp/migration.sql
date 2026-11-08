-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CompanySettings" (
    "companyId" TEXT NOT NULL PRIMARY KEY,
    "stockStrategy" TEXT NOT NULL DEFAULT 'FIFO',
    "useLocations" BOOLEAN NOT NULL DEFAULT false,
    "driversCanRefuse" BOOLEAN NOT NULL DEFAULT true,
    "requireSignature" BOOLEAN NOT NULL DEFAULT true,
    "requirePhoto" BOOLEAN NOT NULL DEFAULT false,
    "requireRecipientName" BOOLEAN NOT NULL DEFAULT true,
    "requireGpsOnProof" BOOLEAN NOT NULL DEFAULT false,
    "requireQrOnLoad" BOOLEAN NOT NULL DEFAULT false,
    "gpsRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Kinshasa',
    "locale" TEXT NOT NULL DEFAULT 'fr',
    CONSTRAINT "CompanySettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_CompanySettings" ("companyId", "currency", "driversCanRefuse", "gpsRetentionDays", "locale", "requireGpsOnProof", "requirePhoto", "requireQrOnLoad", "requireRecipientName", "requireSignature", "stockStrategy", "timezone", "useLocations") SELECT "companyId", "currency", "driversCanRefuse", "gpsRetentionDays", "locale", "requireGpsOnProof", "requirePhoto", "requireQrOnLoad", "requireRecipientName", "requireSignature", "stockStrategy", "timezone", "useLocations" FROM "CompanySettings";
DROP TABLE "CompanySettings";
ALTER TABLE "new_CompanySettings" RENAME TO "CompanySettings";
CREATE TABLE "new_Delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT,
    "customerId" TEXT NOT NULL,
    "deliveryPointId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "driverId" TEXT,
    "vehicleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "driverResponse" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "scheduledAt" DATETIME,
    "instructions" TEXT,
    "justification" TEXT,
    "stockIssued" BOOLEAN NOT NULL DEFAULT false,
    "stockReturned" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "failureReason" TEXT,
    "failureComment" TEXT,
    "recipientName" TEXT,
    "recipientPhone" TEXT,
    "deliveredAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Delivery_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Delivery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Delivery_deliveryPointId_fkey" FOREIGN KEY ("deliveryPointId") REFERENCES "DeliveryPoint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Delivery_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Delivery_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Delivery_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Delivery" ("attempts", "companyId", "createdAt", "createdById", "customerId", "deliveredAt", "deliveryPointId", "driverId", "driverResponse", "failureComment", "failureReason", "id", "instructions", "justification", "number", "orderId", "priority", "recipientName", "recipientPhone", "scheduledAt", "status", "stockIssued", "stockReturned", "updatedAt", "vehicleId", "warehouseId") SELECT "attempts", "companyId", "createdAt", "createdById", "customerId", "deliveredAt", "deliveryPointId", "driverId", "driverResponse", "failureComment", "failureReason", "id", "instructions", "justification", "number", "orderId", "priority", "recipientName", "recipientPhone", "scheduledAt", "status", "stockIssued", "stockReturned", "updatedAt", "vehicleId", "warehouseId" FROM "Delivery";
DROP TABLE "Delivery";
ALTER TABLE "new_Delivery" RENAME TO "Delivery";
CREATE INDEX "Delivery_companyId_status_idx" ON "Delivery"("companyId", "status");
CREATE INDEX "Delivery_companyId_scheduledAt_idx" ON "Delivery"("companyId", "scheduledAt");
CREATE INDEX "Delivery_companyId_driverId_status_idx" ON "Delivery"("companyId", "driverId", "status");
CREATE UNIQUE INDEX "Delivery_companyId_number_key" ON "Delivery"("companyId", "number");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

