import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";

const createSchema = z.object({
  title: z.string().min(1).max(120),
  question: z.string().min(1).max(2000),
  // V2 — outbound search configuration. All optional; uploaded_only +
  // empty providers preserve V1 behaviour for clients that don't pass
  // anything.
  searchScope: z.enum(["uploaded_only", "outbound", "hybrid"]).optional(),
  searchProviders: z
    .array(z.enum(["openalex", "arxiv", "exa"]))
    .max(3)
    .optional(),
  searchYearStart: z.number().int().min(1900).max(2100).optional(),
  searchYearEnd: z.number().int().min(1900).max(2100).optional(),
}).refine(
  (data) =>
    !data.searchYearStart ||
    !data.searchYearEnd ||
    data.searchYearStart <= data.searchYearEnd,
  { message: "searchYearStart must be <= searchYearEnd" },
);

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // V2 — coerce outbound mode without explicit providers to a safe default.
  // The runs-start route enforces "outbound needs at least one provider";
  // setting OpenAlex + arXiv here lets the user pick a search scope at
  // create-time without thinking about provider selection. Exa stays opt-in
  // because it needs an API key.
  const data = { ...parsed.data, ownerId: user.id };
  if (
    (data.searchScope === "outbound" || data.searchScope === "hybrid") &&
    (!data.searchProviders || data.searchProviders.length === 0)
  ) {
    data.searchProviders = ["openalex", "arxiv"];
  }

  const project = await db.project.create({ data });
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
