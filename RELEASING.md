# Releasing Atlas

This checklist applies to every Atlas release tag. Some items are
milestone-specific — read the section for the milestone you're shipping.

## Always do before tagging

- [ ] `pnpm tsc --noEmit` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm vitest run` — full suite green
- [ ] No uncommitted changes (`git status` clean)
- [ ] CHANGELOG entry added in `README.md` Roadmap
- [ ] `package.json` version bumped to match the tag

## MCP server (M5 / v0.7.0+) — manual smoke

Run this checklist on the **live deploy** before tagging any release that
touches `app/api/mcp/`, `lib/mcp/`, or `app/.well-known/`. ~5 minutes.

### Prerequisites
- [ ] Confirm **Dynamic Client Registration** is enabled in the Clerk
  Dashboard (Configure → OAuth Applications → "Dynamic client registration")

### Steps
- [ ] **Run the Playwright smoke** (covers the unauthenticated + metadata paths):
  ```bash
  pnpm playwright test tests/e2e/mcp-smoke.spec.ts --project=chromium
  ```
  Expected: all 3 tests PASS.

- [ ] **MCP Inspector full OAuth flow**:
  1. `npx @modelcontextprotocol/inspector`
  2. Set transport to "Streamable HTTP"
  3. URL: `https://atlas-sooty-delta.vercel.app/api/mcp/mcp`
  4. Click "Connect" — browser pops Clerk sign-in
  5. Sign in / sign up
  6. Expect: 3 tools appear in the left pane
  7. Click `list_reviews` → Call Tool → expect: JSON array of your reviews
  8. Pick a `reviewId` from step 7. Click `get_review_draft` → input
     `{"reviewId": "<id>"}` → Call Tool → expect: markdown body
  9. Click `get_citation_audit` → same `reviewId` → expect: per-claim
     verdicts with counts

- [ ] **Claude Desktop install** (proves the recruiter-demo path works):
  1. Claude Desktop → Settings → Developer → Edit Config → add an MCP server
     pointing at `https://atlas-sooty-delta.vercel.app/api/mcp/mcp`
  2. Restart Claude Desktop
  3. Sign in via the browser pop
  4. In a new conversation, ask: "List my Atlas reviews"
  5. Expect: Claude invokes `list_reviews` and renders the result

- [ ] **Verify the audit log** (Neon):
  ```sql
  SELECT "userId", "toolName", "status", "errorCode", "latencyMs", "createdAt"
  FROM "McpCall"
  ORDER BY "createdAt" DESC
  LIMIT 10;
  ```
  Expected: rows for each call you made above, with `status='OK'` and
  realistic latencies.

## After tagging

- [ ] `git tag -a v<version> -m "..."` and `git push origin v<version>`
- [ ] Create the GitHub release with the release notes
- [ ] Update `~/.claude/projects/E--2026-building-with-AI/memory/atlas_execution_state.md`
  with the new milestone row
- [ ] (M5 only) Open a PR to `github.com/modelcontextprotocol/registry`
  adding `atlas-research` (see registry README for entry format)
