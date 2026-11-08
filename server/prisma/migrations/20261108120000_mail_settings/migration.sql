-- CreateTable
CREATE TABLE "MailSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "user" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "fromAddress" TEXT,
    "updatedById" TEXT,
    "updatedAt" DATETIME NOT NULL
);

