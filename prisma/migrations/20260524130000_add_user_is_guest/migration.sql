-- Add User.isGuest flag for anonymous sample-data sessions
ALTER TABLE "User" ADD COLUMN "isGuest" BOOLEAN NOT NULL DEFAULT false;

-- Index for the nightly cleanup query (guests older than 24h)
CREATE INDEX "User_isGuest_createdAt_idx" ON "User"("isGuest", "createdAt");
