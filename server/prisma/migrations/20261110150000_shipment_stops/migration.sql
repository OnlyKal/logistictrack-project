-- Escales prévues des expéditions : nouvelle table, rien d'existant ne change.
-- CreateTable
CREATE TABLE "ShipmentStop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shipmentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "arrivedAt" DATETIME,
    "departedAt" DATETIME,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ShipmentStop_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShipmentStop_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentStop_shipmentId_position_key" ON "ShipmentStop"("shipmentId", "position");

