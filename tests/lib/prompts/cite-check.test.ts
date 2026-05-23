import { describe, it, expect } from "vitest";
import { CiteCheckPerCitationSchema, buildCiteCheckRequest } from "@/lib/prompts/cite-check";

describe("CiteCheckPerCitationSchema", () => {
  it("accepts a supported verdict with reason and excerpt", () => {
    const r = CiteCheckPerCitationSchema.safeParse({
      verdict: "supported",
      reason: "The paper's results section explicitly states a 25% pain reduction.",
      paperExcerpt: "Patients reported a 25% mean reduction in VAS pain score.",
    });
    expect(r.success).toBe(true);
  });

  it("accepts unclear and unsupported verdicts; excerpt optional", () => {
    const a = CiteCheckPerCitationSchema.safeParse({
      verdict: "unsupported",
      reason: "The paper studies acute pain only; the claim generalizes to chronic.",
    });
    const b = CiteCheckPerCitationSchema.safeParse({
      verdict: "unclear",
      reason: "Paper summary is too short to confirm or refute the claim.",
    });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });

  it("rejects unknown verdicts", () => {
    const r = CiteCheckPerCitationSchema.safeParse({
      verdict: "maybe",
      reason: "x".repeat(20),
    });
    expect(r.success).toBe(false);
  });

  it("rejects too-short reasons", () => {
    const r = CiteCheckPerCitationSchema.safeParse({
      verdict: "supported",
      reason: "yes",
    });
    expect(r.success).toBe(false);
  });
});

describe("buildCiteCheckRequest", () => {
  it("renders the paper summary, claim, and asks for structured JSON", () => {
    const req = buildCiteCheckRequest({
      claim: "CBT reduces chronic back pain at 6 months [c1].",
      paperId: "c1",
      paperSummary: "RCT comparing CBT to standard care. CBT group showed 30% pain reduction at 6m.",
    });
    expect(typeof req.system).toBe("string");
    expect(req.messages).toHaveLength(1);
    const userText = JSON.stringify(req.messages[0]?.content);
    expect(userText).toContain("c1");
    expect(userText).toContain("CBT reduces chronic back pain");
    expect(userText).toContain("RCT comparing CBT");
  });
});
