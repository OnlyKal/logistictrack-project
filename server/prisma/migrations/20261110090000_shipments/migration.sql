-- Expéditions (messagerie) : nouvelles tables, aucune table existante modifiée.
-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "trackingToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "senderName" TEXT NOT NULL,
    "senderPhone" TEXT NOT NULL,
    "senderEmail" TEXT,
    "recipientName" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "description" TEXT NOT NULL,
    "parcels" INTEGER NOT NULL DEFAULT 1,
    "weightKg" DECIMAL,
    "declaredValue" DECIMAL,
    "fee" DECIMAL NOT NULL DEFAULT 0,
    "paymentMode" TEXT NOT NULL DEFAULT 'SENDER',
    "feePaidAt" DATETIME,
    "instructions" TEXT,
    "originWarehouseId" TEXT NOT NULL,
    "destinationWarehouseId" TEXT NOT NULL,
    "currentWarehouseId" TEXT,
    "nextWarehouseId" TEXT,
    "transportInfo" TEXT,
    "pickedUpAt" DATETIME,
    "pickedUpBy" TEXT,
    "pickedUpPhone" TEXT,
    "pickedUpIdDocument" TEXT,
    "signatureFileId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Shipment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shipment_originWarehouseId_fkey" FOREIGN KEY ("originWarehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shipment_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shipment_currentWarehouseId_fkey" FOREIGN KEY ("currentWarehouseId") REFERENCES "Warehouse" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Shipment_nextWarehouseId_fkey" FOREIGN KEY ("nextWarehouseId") REFERENCES "Warehouse" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "warehouseId" TEXT,
    "place" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "userId" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_trackingNumber_key" ON "Shipment"("trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_trackingToken_key" ON "Shipment"("trackingToken");

-- CreateIndex
CREATE INDEX "Shipment_companyId_status_idx" ON "Shipment"("companyId", "status");

-- CreateIndex
CREATE INDEX "Shipment_companyId_currentWarehouseId_status_idx" ON "Shipment"("companyId", "currentWarehouseId", "status");

-- CreateIndex
CREATE INDEX "Shipment_companyId_nextWarehouseId_status_idx" ON "Shipment"("companyId", "nextWarehouseId", "status");

-- CreateIndex
CREATE INDEX "Shipment_companyId_createdAt_idx" ON "Shipment"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_companyId_number_key" ON "Shipment"("companyId", "number");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_occurredAt_idx" ON "ShipmentEvent"("shipmentId", "occurredAt");

