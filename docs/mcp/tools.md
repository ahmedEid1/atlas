# Atlas MCP — Tools Reference

Atlas's MCP server exposes 3 read-only tools over your Atlas reviews.

Install URL: `https://atlas-sooty-delta.vercel.app/api/mcp/mcp`
Registry entry: [`io.github.ahmedEid1/atlas-research`](https://registry.modelcontextprotocol.io/v0.1/servers?search=atlas-research) on the official MCP Registry.

All tools require an OAuth 2.1 access token from Clerk (your MCP client
handles this automatically via Dynamic Client Registration).
All tools return data scoped to your authenticated user — you cannot
see other users' reviews.

---

## `list_reviews`

**Side-effects:** read-only · $0 · no LLM at call time

Lists every Atlas review run you own.

**Input:** _(none)_

**Output:**
```json
{
  "reviews": [
    {
      "id": "string",
      "projectId": "string",
      "projectName": "string",
      "researchQuestion": "string",
      "status": "PENDING | PLANNING | AWAITING_PLAN_APPROVAL | RETRIEVING | AWAITING_PAPERS_APPROVAL | ASSESSING | DRAFTING | COMPLETED | REJECTED | FAILED",
      "createdAt": "ISO-8601 datetime",
      "completedAt": "ISO-8601 datetime | null",
      "critiqueScore": "number 0..1 | null",
      "faithfulnessScore": "number 0..1 | null",
      "claimCount": "integer",
      "citationCount": "integer"
    }
  ]
}
```

---

## `get_review_draft`

**Side-effects:** read-only · $0 · no LLM at call time

Returns the full markdown draft of a completed Atlas review.

**Input:**
```json
{ "reviewId": "string (Run.id from list_reviews)" }
```

**Output:**
```json
{
  "reviewId": "string",
  "researchQuestion": "string",
  "status": "string",
  "draftMarkdown": "string (the full review.md)",
  "critiqueScore": "number 0..1 | null",
  "faithfulnessScore": "number 0..1 | null",
  "criticIterations": "integer (how many critic→revise loops ran)",
  "generatedAt": "ISO-8601 datetime"
}
```

**Errors:** `not_found` (404) when the review doesn't exist, isn't owned
by you, or hasn't produced a draft yet.

---

## `get_citation_audit`

**Side-effects:** read-only · $0 · no LLM at call time

Returns Atlas's per-claim cite_check audit for a completed review.
Every cited claim in the draft has a verdict —
`supported` / `unsupported` / `unclear` — with a reason and (when
available) a quoted excerpt from the supporting paper.

**Input:**
```json
{ "reviewId": "string" }
```

**Output:**
```json
{
  "reviewId": "string",
  "faithfulnessScore": "number 0..1 | null",
  "totalClaims": "integer",
  "supportedCount": "integer",
  "unsupportedCount": "integer",
  "unclearCount": "integer",
  "claims": [
    {
      "claimText": "string (extracted claim)",
      "citedPaperId": "string ([paper_id] from the draft)",
      "verdict": "supported | unsupported | unclear",
      "reason": "string (cite_check's reasoning)",
      "supportingSpan": "string | null (quoted text from the paper)"
    }
  ]
}
```

**Errors:** `not_found` (404) when the review doesn't exist or isn't
owned by you. Empty `claims` array when cite_check hasn't run yet.
