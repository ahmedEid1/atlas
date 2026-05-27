# Thoth MCP — Tools Reference

Thoth's MCP server exposes 5 read-only tools over your Thoth reviews.

Install URL: `https://thoth-slr.vercel.app/api/mcp/mcp`
Registry entry: [`io.github.ahmedEid1/thoth`](https://registry.modelcontextprotocol.io/v0.1/servers?search=thoth) on the official MCP Registry.

All tools require an OAuth 2.1 access token from Clerk (your MCP client
handles this automatically via Dynamic Client Registration).
All tools return data scoped to your authenticated user — you cannot
see other users' reviews.

---

## `list_reviews`

**Side-effects:** read-only · $0 · no LLM at call time

Lists every Thoth review run you own.

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
      "critiqueScore": "number 1..5 (rubric weighted avg) | null",
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

Returns the full markdown draft of a completed Thoth review.

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
  "critiqueScore": "number 1..5 (rubric weighted avg) | null",
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

Returns Thoth's per-claim cite_check audit for a completed review.
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

---

## `list_discovered_papers` *(v2 outbound search)*

**Side-effects:** read-only · $0 · no LLM at call time

For outbound/hybrid v2 reviews, returns every paper the discoverer
surfaced across OpenAlex / arXiv / Exa — each with its initial
relevance score, whether the fetcher acquired the PDF, and the
screener's include/exclude verdict + reason.

Returns an empty `papers` list with `searchScope: "uploaded_only"`
when called on a v1 (uploaded-only) review.

**Input:**
```json
{ "reviewId": "string" }
```

**Output:**
```json
{
  "reviewId": "string",
  "searchScope": "uploaded_only | outbound | hybrid",
  "totalDiscovered": "integer",
  "totalScreenedIn": "integer",
  "totalScreenedOut": "integer",
  "papers": [
    {
      "discoveredPaperId": "string",
      "provider": "openalex | arxiv | exa",
      "externalId": "string (DOI / arXiv id / OpenAlex W-id)",
      "title": "string",
      "authors": "string[]",
      "publicationYear": "integer | null",
      "venue": "string | null",
      "citationCount": "integer | null",
      "oaUrl": "string | null (open-access PDF URL when known)",
      "accessStatus": "open | paywalled | unknown",
      "initialScore": "number 0..1 (discoverer's relevance heuristic)",
      "fetched": "boolean (true once the fetcher OCR'd the PDF)",
      "screening": {
        "include": "boolean",
        "relevanceScore": "number 0..1",
        "reason": "string (screener's reasoning)"
      } // or null if the screener hasn't run on this paper yet
    }
  ]
}
```

**Errors:** `not_found` (404) when the review doesn't exist or isn't
owned by you.

---

## `get_search_queries` *(v2 outbound search)*

**Side-effects:** read-only · $0 · no LLM at call time

For outbound/hybrid v2 reviews, returns the natural-language search
queries the discoverer LLM generated from the research question, the
provider set the run targeted, and any per-provider error messages
(e.g. "exa: missing API key" when Exa was selected without
`EXA_API_KEY`).

Returns empty `queries` with `searchScope: "uploaded_only"` when
called on a v1 review.

**Input:**
```json
{ "reviewId": "string" }
```

**Output:**
```json
{
  "reviewId": "string",
  "searchScope": "uploaded_only | outbound | hybrid",
  "searchProviders": "string[] (provider names enabled for the run)",
  "queries": "string[] (LLM-generated search queries)",
  "providerErrors": [
    {
      "nodeName": "discoverer",
      "failureReason": "string (e.g. 'partial: exa: missing API key')"
    }
  ]
}
```

**Errors:** `not_found` (404) when the review doesn't exist or isn't
owned by you.
