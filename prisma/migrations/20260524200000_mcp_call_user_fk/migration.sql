-- Add a foreign-key + cascade from McpCall.userId to User.id.
-- Until now the column was a bare String with no FK so deleting a User
-- left orphan audit rows behind. Cascading the delete keeps the audit
-- log honest at the cost of losing the call history for the deleted
-- user — acceptable trade-off: the guest-cleanup cron deletes users
-- after 24h anyway, and orphan rows reference a userId that doesn't
-- resolve to anything useful.
ALTER TABLE "McpCall"
  ADD CONSTRAINT "McpCall_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
