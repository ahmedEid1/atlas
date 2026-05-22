# Atlas M1: Workspace Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Atlas project skeleton — auth, database, object storage, durable jobs, and an end-to-end "upload a PDF, see parsed markdown" loop. By the end, a signed-in user can create a project, upload a PDF, and watch its status transition from `PENDING` → `PARSING` → `PARSED`.

**Architecture:** Next.js 16 App Router monolith. Clerk for auth (with `proxy.ts` middleware, webhook-synced to Postgres). Prisma v7 over Postgres for relational state. MinIO (S3-compatible) for blob storage in dev; same SDK targets real S3/Hetzner Object Storage in prod. Trigger.dev v4 for durable jobs, with the Python extension running marker-pdf for PDF → markdown. Local dev orchestrated by docker-compose.

**Tech Stack:** Next.js 16, TypeScript (strict), Tailwind v4 + shadcn/ui, Clerk, Prisma v7, Postgres 16 (docker-compose), MinIO (docker-compose), `@aws-sdk/client-s3`, Trigger.dev v4 + `@trigger.dev/build/extensions/python`, marker-pdf (Python), Vitest (unit + integration), Playwright (e2e), Zod.

**Reference spec:** `agentic-ai/atlas/docs/superpowers/specs/2026-05-22-atlas-design.md`. This plan implements M1 from §12 of the spec only.

---

## File map

**Created in this milestone:**
```
agentic-ai/atlas/
├── package.json
├── tsconfig.json
├── next.config.ts
├── proxy.ts                    # Clerk middleware (Next 16 location)
├── postcss.config.mjs
├── tailwind.config.ts          # only theme tokens — Tailwind v4 uses @theme inline
├── components.json             # shadcn registry config
├── docker-compose.yml          # Postgres + MinIO for local dev
├── .env.example
├── README.md
├── trigger.config.ts
├── vitest.config.ts
├── playwright.config.ts
├── prisma/
│   └── schema.prisma
├── python/
│   ├── parse_pdf.py
│   └── requirements.txt
├── trigger/
│   └── parse-pdf.ts
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   ├── page.tsx                            # landing
│   ├── sign-in/[[...sign-in]]/page.tsx
│   ├── sign-up/[[...sign-up]]/page.tsx
│   ├── dashboard/page.tsx                  # project list
│   ├── projects/[id]/page.tsx              # project workspace
│   └── api/
│       ├── webhooks/clerk/route.ts         # user.created → DB
│       ├── projects/route.ts               # POST create, GET list
│       ├── projects/[id]/route.ts          # GET one
│       └── corpus/upload/route.ts          # POST multipart
├── components/
│   ├── ui/                                 # shadcn-generated primitives
│   ├── projects/
│   │   ├── project-list.tsx
│   │   ├── new-project-dialog.tsx
│   │   └── upload-button.tsx
│   └── corpus/
│       └── corpus-item-list.tsx
├── lib/
│   ├── env.ts                              # Zod-validated process.env
│   ├── db.ts                               # PrismaClient singleton
│   ├── auth.ts                             # auth() + getOrCreateUser()
│   ├── object-store.ts                     # S3 client + putObject/getSignedUrl
│   └── trigger-client.ts                   # typed task references
└── tests/
    ├── lib/
    │   ├── env.test.ts
    │   └── object-store.test.ts
    ├── api/
    │   ├── projects.test.ts
    │   └── corpus-upload.test.ts
    ├── trigger/
    │   └── parse-pdf.test.ts
    └── e2e/
        └── upload-flow.spec.ts
```

**Files have one clear responsibility.** `lib/auth.ts` is the only place that calls Clerk's `auth()`. `lib/db.ts` is the only place that constructs a `PrismaClient`. `lib/object-store.ts` is the only place that touches S3. Each API route is a thin handler that calls these libs.

---

## Conventions

- **TDD**: every behaviour starts with a failing test. Steps marked **"Write the failing test"** must be run with `pnpm vitest run <path>` and observed RED before the implementation step.
- **Commits**: at the end of each task. Conventional commit prefix: `feat:`, `chore:`, `test:`, `docs:`.
- **Package manager**: `pnpm`. Lockfile committed.
- **Strict TypeScript**: `"strict": true`, `"noUncheckedIndexedAccess": true`.
- **No `any`** in committed code — explain in PR comment if unavoidable.
- **Run the typechecker** (`pnpm tsc --noEmit`) before every commit.

---

## Task 0: Project scaffolding

**Files:**
- Create: `agentic-ai/atlas/` (project root)
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `tailwind.config.ts`, `.gitignore`, `.env.example`, `README.md`

- [ ] **Step 1: Create the project directory and initialise git**

```bash
cd "E:/2026/building with AI/agentic-ai/atlas"
git init
echo "node_modules/`n.next/`n.env`n.env.local`n.trigger/`ncoverage/`nplaywright-report/`ntest-results/`n*.log" > .gitignore
```

- [ ] **Step 2: Initialise Next.js 16 with TS + Tailwind v4 (non-interactive)**

```bash
pnpm create next-app@latest . --typescript --tailwind --app --src-dir=false --eslint --import-alias "@/*" --no-turbopack --skip-install
pnpm install
```

Verify `package.json` shows `"next": "^16"` and `"tailwindcss": "^4"`.

- [ ] **Step 3: Tighten `tsconfig.json`**

Open `tsconfig.json` and ensure these compiler options exist:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "moduleResolution": "bundler",
    "paths": { "@/*": ["./*"] }
  }
}
```

- [ ] **Step 4: Run typecheck and dev server to confirm baseline works**

```bash
pnpm tsc --noEmit
pnpm dev
```

Expected: typecheck passes; `http://localhost:3000` shows the Next default page.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold next.js 16 + ts + tailwind v4"
```

---

## Task 1: Local infrastructure (docker-compose)

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`
- Modify: `README.md` (quickstart section)

- [ ] **Step 1: Write `docker-compose.yml` for Postgres + MinIO**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: atlas
      POSTGRES_PASSWORD: atlas_dev_pw
      POSTGRES_DB: atlas
    ports:
      - "5432:5432"
    volumes:
      - atlas_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U atlas"]
      interval: 5s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: atlas
      MINIO_ROOT_PASSWORD: atlas_dev_pw
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - atlas_minio:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  atlas_pg:
  atlas_minio:
```

- [ ] **Step 2: Write `.env.example`**

```bash
# Database (matches docker-compose)
DATABASE_URL="postgresql://atlas:atlas_dev_pw@localhost:5432/atlas"
DIRECT_DATABASE_URL="postgresql://atlas:atlas_dev_pw@localhost:5432/atlas"

# Object store (MinIO locally; swap endpoint for prod S3)
S3_ENDPOINT="http://localhost:9000"
S3_REGION="us-east-1"
S3_ACCESS_KEY_ID="atlas"
S3_SECRET_ACCESS_KEY="atlas_dev_pw"
S3_BUCKET="atlas-corpus"
S3_FORCE_PATH_STYLE="true"

# Clerk — fill in from https://dashboard.clerk.com
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."
CLERK_SECRET_KEY="sk_test_..."
CLERK_WEBHOOK_SIGNING_SECRET="whsec_..."

# Trigger.dev — fill in from https://cloud.trigger.dev
TRIGGER_PROJECT_REF="proj_..."
TRIGGER_SECRET_KEY="tr_dev_..."
```

- [ ] **Step 3: Start the stack and verify**

```bash
docker compose up -d
docker compose ps
```

Expected: both services `healthy`. Open `http://localhost:9001` and log in with `atlas` / `atlas_dev_pw` to confirm MinIO console works. Then create the bucket:

```bash
docker compose exec minio mc alias set local http://localhost:9000 atlas atlas_dev_pw
docker compose exec minio mc mb local/atlas-corpus
```

- [ ] **Step 4: Update README with quickstart**

Add to `README.md`:

````markdown
## Quickstart (local dev)

```bash
cp .env.example .env       # fill in Clerk + Trigger.dev keys
docker compose up -d       # Postgres + MinIO
pnpm install
pnpm prisma migrate dev    # runs after Task 2
pnpm dev                   # Next.js on :3000
pnpm dev:trigger           # Trigger.dev worker (runs after Task 6)
```
````

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example README.md
git commit -m "chore: add postgres + minio docker-compose for local dev"
```

---

## Task 2: Environment validation (`lib/env.ts`)

**Files:**
- Create: `lib/env.ts`
- Create: `tests/lib/env.test.ts`
- Modify: `package.json` (add Zod + Vitest)

- [ ] **Step 1: Install dependencies**

```bash
pnpm add zod
pnpm add -D vitest @vitest/coverage-v8
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    coverage: { reporter: ["text", "html"] },
    setupFiles: [],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
```

Add to `package.json` scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 3: Write the failing test**

`tests/lib/env.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("env", () => {
  let original: NodeJS.ProcessEnv;

  beforeEach(() => {
    original = { ...process.env };
  });

  afterEach(() => {
    process.env = original;
  });

  it("parses a valid env successfully", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/d";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "a";
    process.env.S3_SECRET_ACCESS_KEY = "b";
    process.env.S3_BUCKET = "atlas-corpus";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_x";

    const { env } = await import("@/lib/env");
    expect(env.DATABASE_URL).toContain("postgresql");
    expect(env.S3_BUCKET).toBe("atlas-corpus");
  });

  it("throws on missing required var", async () => {
    delete process.env.DATABASE_URL;
    await expect(import("@/lib/env?2")).rejects.toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 4: Run test, verify it fails**

```bash
pnpm vitest run tests/lib/env.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/env'`.

- [ ] **Step 5: Implement `lib/env.ts`**

```ts
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),

  TRIGGER_PROJECT_REF: z.string().optional(),
  TRIGGER_SECRET_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment:\n${issues}`);
}

export const env = parsed.data;
```

- [ ] **Step 6: Run test, verify it passes**

```bash
pnpm vitest run tests/lib/env.test.ts
```

Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add lib/env.ts tests/lib/env.test.ts vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat: zod-validated env loader"
```

---

## Task 3: Database schema and Prisma client

**Files:**
- Create: `prisma/schema.prisma`
- Create: `lib/db.ts`
- Modify: `package.json` (Prisma scripts)

- [ ] **Step 1: Install Prisma v7**

```bash
pnpm add @prisma/client@^7
pnpm add -D prisma@^7
pnpm prisma init --datasource-provider postgresql
```

Replace the generated `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../app/generated/prisma"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_DATABASE_URL")
}

model User {
  id        String   @id @default(cuid())
  clerkId   String   @unique
  email     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  projects  Project[]

  @@index([clerkId])
}

enum CorpusItemKind {
  PDF
  URL
  NOTE
}

enum CorpusItemStatus {
  PENDING
  PARSING
  PARSED
  FAILED
}

model Project {
  id          String   @id @default(cuid())
  ownerId     String
  owner       User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  title       String
  question    String   @db.Text
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  corpus      CorpusItem[]

  @@index([ownerId])
}

model CorpusItem {
  id              String           @id @default(cuid())
  projectId       String
  project         Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)
  kind            CorpusItemKind
  status          CorpusItemStatus @default(PENDING)
  source          String           // blob key for PDF, URL for URL, "" for NOTE
  rawText         String?          @db.Text
  parsedMarkdown  String?          @db.Text
  failureReason   String?
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  @@index([projectId])
  @@index([status])
}
```

- [ ] **Step 2: Run the first migration**

```bash
pnpm prisma migrate dev --name init
```

Expected: migration applied; client generated at `app/generated/prisma`.

- [ ] **Step 3: Implement `lib/db.ts` singleton**

```ts
import { PrismaClient } from "@/app/generated/prisma";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```

- [ ] **Step 4: Smoke-test the client manually**

```bash
pnpm tsx -e "import('./lib/db').then(async ({ db }) => { console.log(await db.user.count()); process.exit(0); })"
```

Expected: prints `0`. (Install `tsx`: `pnpm add -D tsx` if missing.)

- [ ] **Step 5: Commit**

```bash
git add prisma/ lib/db.ts package.json pnpm-lock.yaml app/generated/
git commit -m "feat: prisma v7 schema for users, projects, corpus items"
```

---

## Task 4: Clerk authentication and webhook sync

**Files:**
- Create: `proxy.ts` (Clerk middleware — Next 16 location)
- Create: `app/sign-in/[[...sign-in]]/page.tsx`
- Create: `app/sign-up/[[...sign-up]]/page.tsx`
- Create: `app/api/webhooks/clerk/route.ts`
- Create: `lib/auth.ts`
- Create: `tests/api/clerk-webhook.test.ts`
- Modify: `app/layout.tsx` (add `<ClerkProvider>`)

- [ ] **Step 1: Install Clerk**

```bash
pnpm add @clerk/nextjs
```

- [ ] **Step 2: Wrap the app with `<ClerkProvider>`**

Replace `app/layout.tsx`:

```tsx
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Atlas",
  description: "Agentic research workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 3: Create `proxy.ts` with route matchers**

```ts
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes: landing, sign-in, sign-up, and the Clerk webhook
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/clerk",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
```

- [ ] **Step 4: Build sign-in / sign-up pages**

`app/sign-in/[[...sign-in]]/page.tsx`:

```tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="min-h-screen grid place-items-center">
      <SignIn />
    </div>
  );
}
```

`app/sign-up/[[...sign-up]]/page.tsx`:

```tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="min-h-screen grid place-items-center">
      <SignUp />
    </div>
  );
}
```

- [ ] **Step 5: Implement `lib/auth.ts`**

```ts
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";

/**
 * Returns the DB User row for the current Clerk session,
 * creating one lazily if the webhook hasn't fired yet (race protection).
 */
export async function getCurrentUser() {
  const { userId } = await auth();
  if (!userId) return null;

  const existing = await db.user.findUnique({ where: { clerkId: userId } });
  if (existing) return existing;

  // Webhook race: create a placeholder. user.created webhook will reconcile email later.
  return db.user.create({
    data: { clerkId: userId, email: `${userId}@pending.local` },
  });
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}
```

- [ ] **Step 6: Write the failing webhook test**

`tests/api/clerk-webhook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock the Clerk verifier to bypass signature checks in unit tests.
vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      upsert: vi.fn().mockResolvedValue({ id: "u1" }),
      delete: vi.fn().mockResolvedValue({ id: "u1" }),
    },
  },
}));

import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { db } from "@/lib/db";

const buildReq = () =>
  new NextRequest("http://localhost/api/webhooks/clerk", {
    method: "POST",
    body: JSON.stringify({}),
  });

describe("POST /api/webhooks/clerk", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts a user on user.created", async () => {
    (verifyWebhook as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      type: "user.created",
      data: {
        id: "user_abc",
        email_addresses: [{ email_address: "a@b.com", id: "e1" }],
        primary_email_address_id: "e1",
      },
    });

    const { POST } = await import("@/app/api/webhooks/clerk/route");
    const res = await POST(buildReq());

    expect(res.status).toBe(200);
    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clerkId: "user_abc" },
        create: expect.objectContaining({ clerkId: "user_abc", email: "a@b.com" }),
      }),
    );
  });

  it("returns 400 on verification failure", async () => {
    (verifyWebhook as unknown as { mockRejectedValue: Function }).mockRejectedValue(
      new Error("bad signature"),
    );

    const { POST } = await import("@/app/api/webhooks/clerk/route");
    const res = await POST(buildReq());

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 7: Run test, verify it fails**

```bash
pnpm vitest run tests/api/clerk-webhook.test.ts
```

Expected: FAIL — route module doesn't exist.

- [ ] **Step 8: Implement `app/api/webhooks/clerk/route.ts`**

```ts
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

type UserEventData = {
  id: string;
  email_addresses: Array<{ id: string; email_address: string }>;
  primary_email_address_id: string | null;
};

function primaryEmail(data: UserEventData): string {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
  return primary?.email_address ?? data.email_addresses[0]?.email_address ?? `${data.id}@pending.local`;
}

export async function POST(req: NextRequest) {
  try {
    const evt = await verifyWebhook(req);

    if (evt.type === "user.created" || evt.type === "user.updated") {
      const data = evt.data as UserEventData;
      await db.user.upsert({
        where: { clerkId: data.id },
        create: { clerkId: data.id, email: primaryEmail(data) },
        update: { email: primaryEmail(data) },
      });
    } else if (evt.type === "user.deleted") {
      const data = evt.data as { id: string };
      await db.user.delete({ where: { clerkId: data.id } }).catch(() => null);
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[clerk webhook] verify failed", err);
    return new Response("bad signature", { status: 400 });
  }
}
```

- [ ] **Step 9: Run test, verify it passes**

```bash
pnpm vitest run tests/api/clerk-webhook.test.ts
```

Expected: PASS (both cases).

- [ ] **Step 10: Manual smoke**

Fill `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `.env` from your Clerk dashboard. Then:

```bash
pnpm dev
```

Visit `http://localhost:3000/sign-up`, create a test account, and verify in Clerk dashboard. The webhook secret will be configured at deploy time (M3); in dev the webhook simply isn't called.

- [ ] **Step 11: Commit**

```bash
git add proxy.ts app/layout.tsx app/sign-in app/sign-up app/api/webhooks lib/auth.ts tests/api/clerk-webhook.test.ts package.json pnpm-lock.yaml
git commit -m "feat: clerk auth + webhook sync to user table"
```

---

## Task 5: Object store (`lib/object-store.ts`)

**Files:**
- Create: `lib/object-store.ts`
- Create: `tests/lib/object-store.test.ts`

- [ ] **Step 1: Install AWS SDK**

```bash
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

- [ ] **Step 2: Write the failing test (integration test against running MinIO)**

`tests/lib/object-store.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

describe("object-store (integration)", () => {
  // Skip if MinIO is not running locally.
  beforeAll(async () => {
    const res = await fetch("http://localhost:9000/minio/health/live").catch(() => null);
    if (!res?.ok) {
      throw new Error("MinIO not reachable on :9000 — run `docker compose up -d`");
    }
  });

  it("puts and fetches an object", async () => {
    const { putObject, getObjectBytes } = await import("@/lib/object-store");
    const key = `test/${randomUUID()}.txt`;
    const bytes = new TextEncoder().encode("hello atlas");

    await putObject(key, bytes, "text/plain");
    const fetched = await getObjectBytes(key);

    expect(new TextDecoder().decode(fetched)).toBe("hello atlas");
  });

  it("returns a presigned GET URL", async () => {
    const { putObject, getSignedGetUrl } = await import("@/lib/object-store");
    const key = `test/${randomUUID()}.bin`;
    await putObject(key, new Uint8Array([1, 2, 3]), "application/octet-stream");

    const url = await getSignedGetUrl(key, 60);
    expect(url).toMatch(/^http:\/\/localhost:9000\/atlas-corpus\//);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Ensure `.env` is populated and `docker compose ps` shows MinIO healthy.

```bash
pnpm vitest run tests/lib/object-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/object-store.ts`**

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

const client = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
});

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`empty body for ${key}`);
  const arr = await res.Body.transformToByteArray();
  return arr;
}

export async function getSignedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
```

- [ ] **Step 5: Run test, verify it passes**

```bash
pnpm vitest run tests/lib/object-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/object-store.ts tests/lib/object-store.test.ts package.json pnpm-lock.yaml
git commit -m "feat: s3-compatible object store helper"
```

---

## Task 6: Project CRUD API

**Files:**
- Create: `app/api/projects/route.ts` (POST create, GET list)
- Create: `app/api/projects/[id]/route.ts` (GET one — owner-only)
- Create: `tests/api/projects.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/api/projects.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    project: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/projects", () => {
  it("creates a project for the current user", async () => {
    (requireUser as unknown as { mockResolvedValue: Function }).mockResolvedValue({ id: "u1" });
    (db.project.create as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "p1",
      title: "T",
      question: "Q",
      ownerId: "u1",
    });

    const { POST } = await import("@/app/api/projects/route");
    const req = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ title: "T", question: "Q" }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("p1");
    expect(db.project.create).toHaveBeenCalledWith({
      data: { title: "T", question: "Q", ownerId: "u1" },
    });
  });

  it("rejects invalid body", async () => {
    (requireUser as unknown as { mockResolvedValue: Function }).mockResolvedValue({ id: "u1" });
    const { POST } = await import("@/app/api/projects/route");
    const req = new NextRequest("http://localhost/api/projects", {
      method: "POST",
      body: JSON.stringify({ title: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/projects/[id]", () => {
  it("returns 404 when project belongs to another user", async () => {
    (requireUser as unknown as { mockResolvedValue: Function }).mockResolvedValue({ id: "u1" });
    (db.project.findUnique as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "p1",
      ownerId: "u2",
    });

    const { GET } = await import("@/app/api/projects/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/projects/p1"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns the project when owned", async () => {
    (requireUser as unknown as { mockResolvedValue: Function }).mockResolvedValue({ id: "u1" });
    (db.project.findUnique as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "p1",
      ownerId: "u1",
      title: "T",
      question: "Q",
    });

    const { GET } = await import("@/app/api/projects/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/projects/p1"), {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("p1");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
pnpm vitest run tests/api/projects.test.ts
```

Expected: FAIL — routes not found.

- [ ] **Step 3: Implement `app/api/projects/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

const createSchema = z.object({
  title: z.string().min(1).max(120),
  question: z.string().min(1).max(2000),
});

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const project = await db.project.create({
    data: { ...parsed.data, ownerId: user.id },
  });
  return NextResponse.json(project, { status: 201 });
}

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const projects = await db.project.findMany({
    where: { ownerId: user.id },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json(projects);
}
```

- [ ] **Step 4: Implement `app/api/projects/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.json(project);
}
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
pnpm vitest run tests/api/projects.test.ts
```

Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add app/api/projects tests/api/projects.test.ts
git commit -m "feat: project crud api with owner-scoped access"
```

---

## Task 7: PDF upload endpoint

**Files:**
- Create: `app/api/corpus/upload/route.ts`
- Create: `tests/api/corpus-upload.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/api/corpus-upload.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    project: { findUnique: vi.fn() },
    corpusItem: { create: vi.fn() },
  },
}));
vi.mock("@/lib/object-store", () => ({ putObject: vi.fn() }));
vi.mock("@/lib/trigger-client", () => ({ enqueueParsePdf: vi.fn() }));

import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { putObject } from "@/lib/object-store";
import { enqueueParsePdf } from "@/lib/trigger-client";

beforeEach(() => vi.clearAllMocks());

function buildPdfFormData(): FormData {
  const fd = new FormData();
  fd.set("projectId", "p1");
  fd.set(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "test.pdf", {
      type: "application/pdf",
    }),
  );
  return fd;
}

describe("POST /api/corpus/upload", () => {
  it("creates a PENDING corpus item, stores PDF, and enqueues parse task", async () => {
    (requireUser as unknown as { mockResolvedValue: Function }).mockResolvedValue({ id: "u1" });
    (db.project.findUnique as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "p1",
      ownerId: "u1",
    });
    (db.corpusItem.create as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "c1",
    });

    const { POST } = await import("@/app/api/corpus/upload/route");
    const fd = buildPdfFormData();
    const req = new NextRequest("http://localhost/api/corpus/upload", {
      method: "POST",
      body: fd as unknown as BodyInit,
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(putObject).toHaveBeenCalled();
    expect(db.corpusItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          kind: "PDF",
          status: "PENDING",
        }),
      }),
    );
    expect(enqueueParsePdf).toHaveBeenCalledWith("c1");
  });

  it("404s when the project does not belong to the user", async () => {
    (requireUser as unknown as { mockResolvedValue: Function }).mockResolvedValue({ id: "u1" });
    (db.project.findUnique as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "p1",
      ownerId: "u2",
    });

    const { POST } = await import("@/app/api/corpus/upload/route");
    const req = new NextRequest("http://localhost/api/corpus/upload", {
      method: "POST",
      body: buildPdfFormData() as unknown as BodyInit,
    });
    expect((await POST(req)).status).toBe(404);
  });

  it("rejects non-PDF mimetypes", async () => {
    (requireUser as unknown as { mockResolvedValue: Function }).mockResolvedValue({ id: "u1" });
    (db.project.findUnique as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "p1",
      ownerId: "u1",
    });

    const fd = new FormData();
    fd.set("projectId", "p1");
    fd.set("file", new File([new Uint8Array([1])], "x.txt", { type: "text/plain" }));

    const { POST } = await import("@/app/api/corpus/upload/route");
    const req = new NextRequest("http://localhost/api/corpus/upload", {
      method: "POST",
      body: fd as unknown as BodyInit,
    });
    expect((await POST(req)).status).toBe(415);
  });
});
```

- [ ] **Step 2: Stub `lib/trigger-client.ts` (real wiring in Task 9)**

```ts
// Stub for Task 7; replaced with real Trigger.dev wiring in Task 9.
export async function enqueueParsePdf(corpusItemId: string): Promise<void> {
  console.log(`[stub] would enqueue parse-pdf for ${corpusItemId}`);
}
```

- [ ] **Step 3: Run test, verify it fails**

```bash
pnpm vitest run tests/api/corpus-upload.test.ts
```

Expected: FAIL — route not found.

- [ ] **Step 4: Implement `app/api/corpus/upload/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { putObject } from "@/lib/object-store";
import { enqueueParsePdf } from "@/lib/trigger-client";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const form = await req.formData();
  const projectId = form.get("projectId");
  const file = form.get("file");

  if (typeof projectId !== "string" || !(file instanceof File)) {
    return new NextResponse("Bad request", { status: 400 });
  }

  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.ownerId !== user.id) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (file.type !== "application/pdf") {
    return new NextResponse("Unsupported media type", { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return new NextResponse("Payload too large", { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const key = `corpus/${projectId}/${randomUUID()}.pdf`;
  await putObject(key, bytes, "application/pdf");

  const item = await db.corpusItem.create({
    data: {
      projectId,
      kind: "PDF",
      status: "PENDING",
      source: key,
    },
  });

  await enqueueParsePdf(item.id);

  return NextResponse.json(item, { status: 201 });
}

export const runtime = "nodejs"; // needs Node for fs/streams
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
pnpm vitest run tests/api/corpus-upload.test.ts
```

Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add app/api/corpus lib/trigger-client.ts tests/api/corpus-upload.test.ts
git commit -m "feat: pdf upload endpoint (with stubbed trigger enqueue)"
```

---

## Task 8: Python parser (`python/parse_pdf.py`)

**Files:**
- Create: `python/parse_pdf.py`
- Create: `python/requirements.txt`
- Create: `python/.venv` (gitignored)

- [ ] **Step 1: Write `python/requirements.txt`**

```text
marker-pdf==1.6.*
boto3==1.34.*
```

- [ ] **Step 2: Set up the local venv**

```bash
cd python
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..
```

Add `python/.venv/` to `.gitignore`.

- [ ] **Step 3: Write `python/parse_pdf.py`**

Takes three positional args: `bucket in_key out_key`. Returns a single JSON line on stdout.

```python
"""Parse a PDF from S3 to markdown using marker-pdf and write the result back.

Invocation:
    python parse_pdf.py <bucket> <in_key> <out_key>

Stdout (single line):
    {"ok": true, "out_key": "...", "page_count": N, "char_count": N}
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

import boto3

from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        region_name=os.environ["S3_REGION"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
    )


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(json.dumps({"ok": False, "error": "usage: parse_pdf.py <bucket> <in_key> <out_key>"}), file=sys.stderr)
        return 2

    bucket, in_key, out_key = argv[1], argv[2], argv[3]

    s3 = _s3()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        local_in = tmp.name
    s3.download_file(bucket, in_key, local_in)

    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(local_in)
    text, _ext, _images = text_from_rendered(rendered)

    s3.put_object(
        Bucket=bucket,
        Key=out_key,
        Body=text.encode("utf-8"),
        ContentType="text/markdown",
    )

    page_count = len(getattr(rendered, "metadata", {}).get("page_stats", []) or [])
    print(json.dumps({"ok": True, "out_key": out_key, "page_count": page_count, "char_count": len(text)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
```

- [ ] **Step 4: Smoke-test manually with a real PDF**

Upload any short PDF (e.g. an arXiv paper, 2 pages) to MinIO via the console at `localhost:9001`, into bucket `atlas-corpus` with key `test-input.pdf`. Then export the env vars and run:

```powershell
$env:S3_ENDPOINT="http://localhost:9000"
$env:S3_REGION="us-east-1"
$env:S3_ACCESS_KEY_ID="atlas"
$env:S3_SECRET_ACCESS_KEY="atlas_dev_pw"
cd python
.\.venv\Scripts\python.exe parse_pdf.py atlas-corpus test-input.pdf test-output.md
```

Expected: prints `{"ok": true, ...}` to stdout. The first run downloads marker model weights (~2 GB) — be patient. Verify `test-output.md` appears in MinIO.

- [ ] **Step 5: Commit**

```bash
git add python/ .gitignore
git commit -m "feat: marker-pdf parser script"
```

---

## Task 9: Trigger.dev v4 setup and `parse-pdf` task

**Files:**
- Create: `trigger.config.ts`
- Create: `trigger/parse-pdf.ts`
- Create: `tests/trigger/parse-pdf.test.ts`
- Modify: `lib/trigger-client.ts` (replace stub)
- Modify: `package.json` scripts (`dev:trigger`)

- [ ] **Step 1: Install Trigger.dev**

```bash
pnpm add @trigger.dev/sdk@^4
pnpm add -D @trigger.dev/build@^4 @trigger.dev/cli@^4
```

Add scripts to `package.json`:

```json
{
  "scripts": {
    "dev:trigger": "trigger dev",
    "trigger:deploy": "trigger deploy"
  }
}
```

- [ ] **Step 2: Create `trigger.config.ts` with Python extension**

```ts
import { defineConfig } from "@trigger.dev/sdk";
import { pythonExtension } from "@trigger.dev/build/extensions/python";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./trigger"],
  runtime: "node",
  logLevel: "info",
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30000, randomize: true },
  },
  build: {
    extensions: [
      pythonExtension({
        scripts: ["./python/**/*.py"],
        requirementsFile: "./python/requirements.txt",
        devPythonBinaryPath: "./python/.venv/Scripts/python.exe",
      }),
      prismaExtension({
        schema: "prisma/schema.prisma",
        version: "7.0.0",
        directUrlEnvVarName: "DIRECT_DATABASE_URL",
      }),
    ],
  },
});
```

- [ ] **Step 3: Write the failing test**

`tests/trigger/parse-pdf.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@trigger.dev/sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@trigger.dev/sdk");
  return {
    ...actual,
    schemaTask: (cfg: { run: (payload: unknown) => Promise<unknown> }) => cfg,
    python: {
      runScript: vi.fn().mockResolvedValue({
        stdout: JSON.stringify({ ok: true, out_key: "corpus/p1/c1.md", page_count: 3, char_count: 1234 }),
        stderr: "",
        exitCode: 0,
      }),
    },
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    corpusItem: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/object-store", () => ({
  getObjectBytes: vi.fn().mockResolvedValue(new TextEncoder().encode("# parsed markdown")),
}));

import { db } from "@/lib/db";

beforeEach(() => vi.clearAllMocks());

describe("parse-pdf task", () => {
  it("transitions PENDING → PARSING → PARSED with parsed markdown", async () => {
    (db.corpusItem.findUnique as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "c1",
      projectId: "p1",
      source: "corpus/p1/c1.pdf",
      status: "PENDING",
    });

    const mod = await import("@/trigger/parse-pdf");
    await mod.parsePdfTask.run({ corpusItemId: "c1" });

    const updateCalls = (db.corpusItem.update as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);

    const statuses = updateCalls.map((c) => (c[0] as { data: { status: string } }).data.status);
    expect(statuses[0]).toBe("PARSING");
    expect(statuses.at(-1)).toBe("PARSED");

    const finalCall = updateCalls.at(-1) as [{ data: { parsedMarkdown: string } }];
    expect(finalCall[0].data.parsedMarkdown).toBe("# parsed markdown");
  });

  it("marks FAILED with reason on python error", async () => {
    (db.corpusItem.findUnique as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      id: "c2",
      projectId: "p1",
      source: "corpus/p1/c2.pdf",
      status: "PENDING",
    });

    const sdk = await import("@trigger.dev/sdk");
    (sdk.python.runScript as unknown as { mockResolvedValue: Function }).mockResolvedValue({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    });

    const mod = await import("@/trigger/parse-pdf");
    await expect(mod.parsePdfTask.run({ corpusItemId: "c2" })).rejects.toThrow(/python/i);

    const updateCalls = (db.corpusItem.update as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const statuses = updateCalls.map((c) => (c[0] as { data: { status: string } }).data.status);
    expect(statuses.at(-1)).toBe("FAILED");
  });
});
```

- [ ] **Step 4: Run test, verify it fails**

```bash
pnpm vitest run tests/trigger/parse-pdf.test.ts
```

Expected: FAIL — `trigger/parse-pdf` not found.

- [ ] **Step 5: Implement `trigger/parse-pdf.ts`**

```ts
import { schemaTask, python, logger, metadata } from "@trigger.dev/sdk";
import { z } from "zod";
import { db } from "@/lib/db";

export const parsePdfTask = schemaTask({
  id: "parse-pdf",
  schema: z.object({ corpusItemId: z.string() }),
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000, maxTimeoutInMs: 30000 },
  machine: { preset: "large-1x" }, // marker needs RAM
  maxDuration: 600,
  run: async ({ corpusItemId }) => {
    const item = await db.corpusItem.findUnique({ where: { id: corpusItemId } });
    if (!item) throw new Error(`CorpusItem ${corpusItemId} not found`);
    if (item.kind !== "PDF") throw new Error(`Expected PDF, got ${item.kind}`);

    await db.corpusItem.update({
      where: { id: corpusItemId },
      data: { status: "PARSING", failureReason: null },
    });
    metadata.set("status", "parsing");

    const outKey = `${item.source.replace(/\.pdf$/, "")}.md`;
    const bucket = process.env.S3_BUCKET ?? "";

    try {
      const result = await python.runScript("./python/parse_pdf.py", [bucket, item.source, outKey]);

      if (result.exitCode !== 0) {
        logger.error("python parser failed", { stderr: result.stderr });
        throw new Error(`python parser exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`);
      }

      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        out_key: string;
        page_count: number;
        char_count: number;
      };

      // Pull the markdown back out of S3 and store it on the row (small enough for M1).
      const { getObjectBytes } = await import("@/lib/object-store");
      const md = new TextDecoder().decode(await getObjectBytes(parsed.out_key));

      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: { status: "PARSED", parsedMarkdown: md },
      });
      metadata.set("status", "parsed").set("pageCount", parsed.page_count);

      return { ok: true, pageCount: parsed.page_count, charCount: parsed.char_count };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await db.corpusItem.update({
        where: { id: corpusItemId },
        data: { status: "FAILED", failureReason: reason.slice(0, 1000) },
      });
      throw err;
    }
  },
});
```

- [ ] **Step 6: Replace the stub in `lib/trigger-client.ts`**

```ts
import { tasks } from "@trigger.dev/sdk";
import type { parsePdfTask } from "@/trigger/parse-pdf";

export async function enqueueParsePdf(corpusItemId: string): Promise<void> {
  await tasks.trigger<typeof parsePdfTask>("parse-pdf", { corpusItemId });
}
```

- [ ] **Step 7: Run tests, verify they pass**

```bash
pnpm vitest run tests/trigger/parse-pdf.test.ts
```

Expected: PASS (both cases).

- [ ] **Step 8: Manual end-to-end smoke**

In one terminal:
```bash
pnpm dev
```

In another:
```bash
pnpm dev:trigger
```

The Trigger.dev CLI will prompt to log in and select your project. Once running, sign in to Atlas at `localhost:3000`, create a project (we'll add UI in Task 10 — for now use the API directly with `curl`), and upload a PDF. Watch the Trigger.dev dashboard show the task moving through `PARSING` → `PARSED`.

- [ ] **Step 9: Commit**

```bash
git add trigger.config.ts trigger/ lib/trigger-client.ts tests/trigger/parse-pdf.test.ts package.json pnpm-lock.yaml
git commit -m "feat: durable parse-pdf task via trigger.dev + python/marker"
```

---

## Task 10: Minimal UI

**Files:**
- Create: `app/page.tsx` (landing, replace default)
- Create: `app/dashboard/page.tsx`
- Create: `app/projects/[id]/page.tsx`
- Create: `components/projects/project-list.tsx`
- Create: `components/projects/new-project-dialog.tsx`
- Create: `components/corpus/upload-button.tsx`
- Create: `components/corpus/corpus-item-list.tsx`
- Modify: `app/layout.tsx` (header with user button)

- [ ] **Step 1: Install shadcn primitives we need**

```bash
pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button input label textarea dialog card badge skeleton sonner
```

- [ ] **Step 2: Replace `app/page.tsx` with a landing page**

```tsx
import Link from "next/link";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="max-w-2xl text-center space-y-6">
        <h1 className="text-4xl font-semibold tracking-tight">Atlas</h1>
        <p className="text-lg text-muted-foreground">
          A GDPR-safe agentic workspace for systematic literature reviews.
        </p>
        <div className="flex gap-3 justify-center">
          <SignedOut>
            <Button asChild><Link href="/sign-up">Get started</Link></Button>
            <Button asChild variant="outline"><Link href="/sign-in">Sign in</Link></Button>
          </SignedOut>
          <SignedIn>
            <Button asChild><Link href="/dashboard">Open dashboard</Link></Button>
          </SignedIn>
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Build the dashboard (server component)**

`app/dashboard/page.tsx`:

```tsx
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { ProjectList } from "@/components/projects/project-list";
import { NewProjectDialog } from "@/components/projects/new-project-dialog";

export default async function DashboardPage() {
  const user = await requireUser();
  const projects = await db.project.findMany({
    where: { ownerId: user.id },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your projects</h1>
        <NewProjectDialog />
      </header>
      <ProjectList projects={projects} />
    </main>
  );
}
```

`components/projects/project-list.tsx`:

```tsx
import Link from "next/link";
import { Card } from "@/components/ui/card";

type Project = { id: string; title: string; question: string; updatedAt: Date };

export function ProjectList({ projects }: { projects: Project[] }) {
  if (projects.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No projects yet. Create your first review above.</p>
    );
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {projects.map((p) => (
        <li key={p.id}>
          <Link href={`/projects/${p.id}`}>
            <Card className="p-5 hover:bg-accent transition">
              <h2 className="font-medium">{p.title}</h2>
              <p className="text-sm text-muted-foreground line-clamp-2 mt-1">{p.question}</p>
              <p className="text-xs text-muted-foreground mt-3">
                Updated {new Date(p.updatedAt).toLocaleDateString()}
              </p>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

`components/projects/new-project-dialog.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function NewProjectDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    startTransition(async () => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, question }),
      });
      if (!res.ok) return;
      const project = (await res.json()) as { id: string };
      setOpen(false);
      router.push(`/projects/${project.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>New project</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New SLR project</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="question">Research question</Label>
            <Textarea id="question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={4} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={isPending || !title || !question}>
            {isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Build the project workspace page**

`app/projects/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { UploadButton } from "@/components/corpus/upload-button";
import { CorpusItemList } from "@/components/corpus/corpus-item-list";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const project = await db.project.findUnique({
    where: { id },
    include: { corpus: { orderBy: { createdAt: "desc" } } },
  });
  if (!project || project.ownerId !== user.id) notFound();

  return (
    <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{project.title}</h1>
        <p className="text-muted-foreground mt-1">{project.question}</p>
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Corpus</h2>
          <UploadButton projectId={project.id} />
        </div>
        <CorpusItemList items={project.corpus} />
      </section>
    </main>
  );
}
```

`components/corpus/upload-button.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function UploadButton({ projectId }: { projectId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("projectId", projectId);
    fd.set("file", file);
    const res = await fetch("/api/corpus/upload", { method: "POST", body: fd });
    setBusy(false);
    if (res.ok) router.refresh();
  }

  return (
    <>
      <input ref={inputRef} type="file" accept="application/pdf" hidden onChange={onPick} />
      <Button onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? "Uploading…" : "Upload PDF"}
      </Button>
    </>
  );
}
```

`components/corpus/corpus-item-list.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Item = {
  id: string;
  source: string;
  status: "PENDING" | "PARSING" | "PARSED" | "FAILED";
  parsedMarkdown: string | null;
  failureReason: string | null;
};

const STATUS_VARIANT: Record<Item["status"], "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "outline",
  PARSING: "secondary",
  PARSED: "default",
  FAILED: "destructive",
};

export function CorpusItemList({ items }: { items: Item[] }) {
  const router = useRouter();

  // Poll while any item is still pending or parsing — M1 keeps it simple.
  // M3 swaps this for Trigger.dev realtime subscriptions.
  useEffect(() => {
    const anyActive = items.some((i) => i.status === "PENDING" || i.status === "PARSING");
    if (!anyActive) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [items, router]);

  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">No documents yet. Upload a PDF to get started.</p>;
  }

  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.id}>
          <ItemCard item={it} />
        </li>
      ))}
    </ul>
  );
}

function ItemCard({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="font-mono text-xs truncate">{item.source}</p>
          {item.failureReason && (
            <p className="text-destructive text-xs mt-1">{item.failureReason}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={STATUS_VARIANT[item.status]}>{item.status.toLowerCase()}</Badge>
          {item.status === "PARSED" && (
            <button className="text-sm underline" onClick={() => setOpen((v) => !v)}>
              {open ? "Hide" : "View"}
            </button>
          )}
        </div>
      </div>
      {open && item.parsedMarkdown && (
        <pre className="mt-4 max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
          {item.parsedMarkdown}
        </pre>
      )}
    </Card>
  );
}
```

- [ ] **Step 5: Add the header to `app/layout.tsx`**

Replace the existing layout's `<body>` content:

```tsx
import { ClerkProvider, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="min-h-screen bg-background text-foreground antialiased">
          <header className="border-b">
            <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
              <Link href="/" className="font-semibold">Atlas</Link>
              <div>
                <SignedIn><UserButton /></SignedIn>
                <SignedOut>
                  <Link href="/sign-in" className="text-sm underline">Sign in</Link>
                </SignedOut>
              </div>
            </div>
          </header>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
```

- [ ] **Step 6: Manual smoke**

```bash
pnpm dev          # one terminal
pnpm dev:trigger  # another terminal
```

Sign up → land on `/dashboard` → "New project" → fill in → upload a PDF → watch the badge cycle `pending → parsing → parsed` (polling) → click "View" to see the markdown.

- [ ] **Step 7: Commit**

```bash
git add app/ components/ components.json
git commit -m "feat: minimal ui for projects + corpus upload"
```

---

## Task 11: End-to-end Playwright test

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/upload-flow.spec.ts`
- Modify: `package.json` scripts

- [ ] **Step 1: Install Playwright**

```bash
pnpm add -D @playwright/test
pnpm playwright install chromium
```

Add to `package.json` scripts:

```json
{
  "scripts": {
    "test:e2e": "playwright test"
  }
}
```

- [ ] **Step 2: Configure Playwright**

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
```

- [ ] **Step 3: Write the upload-flow spec**

This is a documentation-quality smoke test, intentionally tolerant about Clerk's hosted UI (which evolves). It assumes you've created a Clerk test user via the dashboard and stored credentials in `.env.test`.

`.env.test` (add to `.gitignore`):

```bash
E2E_EMAIL="atlas-e2e+clerk_test@example.com"
E2E_PASSWORD="atlas_dev_pw_e2e_only"
```

`tests/e2e/upload-flow.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import path from "node:path";
import "dotenv/config";

test("a signed-in user can create a project and upload a PDF", async ({ page }) => {
  // 1. Sign in via Clerk-hosted UI
  await page.goto("/sign-in");
  await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL!);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL("/dashboard", { timeout: 30_000 });

  // 2. Create a new project
  await page.getByRole("button", { name: /new project/i }).click();
  const title = `E2E ${Date.now()}`;
  await page.getByLabel(/title/i).fill(title);
  await page.getByLabel(/research question/i).fill("Does X improve Y in software engineering?");
  await page.getByRole("button", { name: /^create$/i }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 10_000 });

  // 3. Upload a fixture PDF
  const pdfPath = path.resolve(__dirname, "fixtures/short.pdf");
  await page.getByRole("button", { name: /upload pdf/i }).click();
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(pdfPath);

  // 4. Watch status transition
  const statusBadge = page.getByText(/^(pending|parsing)$/i);
  await expect(statusBadge).toBeVisible({ timeout: 5_000 });

  // Parsing can take ~30s on first marker run (model weights cached after that)
  await expect(page.getByText(/^parsed$/i)).toBeVisible({ timeout: 120_000 });

  // 5. Inspect parsed markdown
  await page.getByRole("button", { name: /^view$/i }).click();
  const codeBlock = page.locator("pre").first();
  await expect(codeBlock).toBeVisible();
  await expect(codeBlock).not.toBeEmpty();
});
```

- [ ] **Step 4: Provide a fixture PDF**

Place any short (<5 MB) PDF at `tests/e2e/fixtures/short.pdf`. The repo `.gitignore` should NOT exclude `tests/`. Suggestion: grab a 2-page arXiv abstract.

- [ ] **Step 5: Run the e2e test**

Ensure dev + trigger workers are running, MinIO is healthy, and `.env.test` is populated. Then:

```bash
pnpm test:e2e
```

Expected: PASS. (First run may take 60–120 s while marker loads model weights.)

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests/e2e/ package.json pnpm-lock.yaml .gitignore
git commit -m "test: e2e upload flow with playwright"
```

---

## Task 12: M1 release

**Files:**
- Modify: `README.md` (final M1 quickstart)
- Create: `docs/blog/01-foundations.md` (draft, unpublished)
- Tag: `v0.1.0-m1`

- [ ] **Step 1: Polish the README**

Replace the placeholder `README.md` with a real one:

````markdown
# Atlas

> GDPR-safe agentic workspace for systematic literature reviews.

**Status:** M1 (foundations). [Full design spec](docs/superpowers/specs/2026-05-22-atlas-design.md).

## What's in M1
- Clerk auth + webhook-synced user table
- Project workspace with PDF upload
- Durable PDF → Markdown parsing via Trigger.dev + marker-pdf
- Postgres + Prisma v7 schema; MinIO for local blob storage
- Vitest unit/integration + Playwright e2e

## Quickstart

```bash
cp .env.example .env       # fill in Clerk + Trigger.dev keys
docker compose up -d       # postgres + minio
pnpm install
pnpm prisma migrate dev
pnpm dev                   # next.js on :3000
pnpm dev:trigger           # durable worker (separate terminal)
```

## Roadmap
- M2: Single-node summarisation + Langfuse traces
- M3: Full agent loop (planner → retriever → assessor → drafter) + HITL gates
- M4: Critic + cite_check + eval harness v1
- M5: Authenticated MCP server
- M6: Public launch

See [`docs/superpowers/specs/`](docs/superpowers/specs/) for the design spec and [`docs/superpowers/plans/`](docs/superpowers/plans/) for milestone plans.

## License
MIT
````

- [ ] **Step 2: Draft the first blog post**

`docs/blog/01-foundations.md`:

```markdown
# Atlas, week one: foundations

Why I'm building Atlas, and what week-one scaffolding looks like for a production-minded agentic app.

- Why SLR as the v1 niche
- The "boring" infra choices: Clerk, Prisma, Postgres, Trigger.dev, MinIO
- Why marker-pdf via Trigger.dev's Python extension (vs hosted SaaS parsers)
- TDD for full-stack: what's testable, what isn't
- What's next: summarisation + Langfuse in M2
```

(This is a placeholder skeleton — the prose is written for publication after M1 ships.)

- [ ] **Step 3: Run the full test suite one last time**

```bash
pnpm tsc --noEmit
pnpm test
pnpm test:e2e
```

Expected: all green.

- [ ] **Step 4: Tag the release**

```bash
git add README.md docs/blog/
git commit -m "docs: m1 readme + blog skeleton"
git tag -a v0.1.0-m1 -m "M1: workspace foundation"
```

- [ ] **Step 5: Push to GitHub (creates the public repo)**

```bash
gh repo create ahmedEid1/atlas --public --source=. --description "GDPR-safe agentic workspace for systematic literature reviews" --push
git push --tags
```

- [ ] **Step 6: Sanity-check the public repo**

```bash
gh repo view ahmedEid1/atlas --web
```

Verify the README renders, the v0.1.0-m1 release tag shows, and the spec + plan are visible under `docs/superpowers/`.

---

## Definition of done for M1

- [ ] All Vitest tests pass: `pnpm test`
- [ ] Typecheck passes: `pnpm tsc --noEmit`
- [ ] Playwright e2e passes: `pnpm test:e2e`
- [ ] Manual flow works locally: sign up → create project → upload PDF → see parsed markdown
- [ ] `v0.1.0-m1` tag pushed to GitHub
- [ ] README quickstart is followable by a stranger
- [ ] Blog post skeleton exists at `docs/blog/01-foundations.md`
- [ ] No `any` types, no TODO comments, no commented-out code in the diff
