-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "companyId" TEXT,
    "refreshTokenHash" TEXT NOT NULL,
    "refreshSalt" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "userAgent" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserSession" ("companyId", "createdAt", "expiresAt", "id", "refreshTokenHash", "revokedAt", "userAgent", "userId") SELECT "companyId", "createdAt", "expiresAt", "id", "refreshTokenHash", "revokedAt", "userAgent", "userId" FROM "UserSession";
DROP TABLE "UserSession";
ALTER TABLE "new_UserSession" RENAME TO "UserSession";
CREATE UNIQUE INDEX "UserSession_refreshTokenHash_key" ON "UserSession"("refreshTokenHash");
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

