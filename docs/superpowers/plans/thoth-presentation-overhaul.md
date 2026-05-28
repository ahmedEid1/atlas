# Thoth presentation overhaul — plan

**Goal:** Make the thoth repo *presentable* — a README and docs that read well for
**three audiences** (general visitors, recruiters/hiring managers, engineers),
backed by demo media (screenshots + feature GIFs from the live app), with deep
technical detail moved into a well-organised `docs/`, version aligned to **2.0.0**,
a refreshed GitHub description, and best-practice repo hygiene throughout.

Decisions locked with the maintainer:
- README: **design a polished one** (hero + tagline + top feature GIFs + 30-sec
  quickstart + audience-framed sections; deep detail → `docs/`).
- Media: capture the **live app** (`thoth-slr.vercel.app`) logged in via the e2e
  Clerk creds; Playwright records video; **install ffmpeg** → convert to GIFs.
- Version: **align everything to 2.0.0** + refresh the GitHub "About" description.

## Phase 0 — Capture infrastructure
- Install `ffmpeg` (video→GIF). Fallback if no sudo: a node GIF encoder
  (`@gif.js`/`gifenc`) or `ffmpeg-static` npm.
- Create `docs/assets/media/` for screenshots + GIFs (keep the repo's existing
  `docs/assets/` convention).
- Write a Playwright capture script (`scripts/capture-media.ts`) that reuses the
  e2e Clerk sign-in (`@clerk/testing`, EMAIL+SECRET from .env), records video
  (`recordVideo`) + takes full-page screenshots per feature. Use a fresh demo
  project so captures are clean; clean up after (mirror the e2e afterAll).

## Phase 1 — Capture demo media (the features to walk through)
1. Landing / showcase (the public `/` + `/showcase`).
2. Create a review → plan gate (HITL) approval.
3. Outbound discovery → discovery gate (search queries + discovered papers).
4. Papers gate (included papers approval).
5. Draft + **cite_check citation audit** (the differentiator — every claim
   verified against the source).
6. Connect via **MCP** (the connectors / tools surface).
7. Public **/evals** dashboard.
Produce: a clean PNG per feature + one walkthrough video → per-feature GIFs
(ffmpeg, optimized/looping, palette for size).

## Phase 2 — README redesign (audience-first, scannable)
- Hero: title + one-line tagline + cleaned badges + **live demo** link + the top
  walkthrough GIF.
- "What is Thoth" — plain-language problem→outcome (general/recruiter friendly).
- Feature highlights — each with its GIF/screenshot + one-line value.
- 30-second Quickstart (try the live demo / connect MCP / run locally).
- "For engineers" — concise architecture diagram/summary + **links into docs/**
  (no walls of text inline).
- Trim/move dense sections (Verified proofs detail, full Stack, Tests, LLM
  provider matrix, self-host) into `docs/`; keep README scannable (~120-150 lines).

## Phase 3 — docs/ best-practices reorg
- Ensure: `docs/architecture.md` (moved/expanded), MCP (exists), security
  (exists), self-host (exists), the moved-from-README detail, a docs index.
- Repo hygiene files: `LICENSE` (verify), `CONTRIBUTING.md`, `CHANGELOG.md`,
  `.github/` issue + PR templates. Each file clean + linked from README/docs.

## Phase 4 — Version + description + metadata
- Align version to **2.0.0** (README badge v1.0.1→2.0.0; fix stale "17-question"
  →"18", "654/657/666/676 tests" consistency, any other drifted numbers).
- `gh repo edit` — refresh **description** to the presentable tagline + add
  relevant **topics**.

## Phase 5 — Verify + ship
- `pnpm verify` after any code-touching change (app/page.tsx version strings,
  capture script). README/docs/media are non-code but keep the tree green.
- Commit + push incrementally per phase. Confirm media renders on GitHub.

## Risks / notes
- Hardest part is **automated Clerk login + video capture**; if the live-app
  login proves brittle, fall back to capturing against a local `pnpm dev`
  (still logged in) — the README/version/docs work proceeds regardless.
- ffmpeg install may need a fallback (ffmpeg-static) if no sudo.
- Keep all media optimized (GIF size) so the README stays light.
