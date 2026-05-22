import { describe, it, expect } from "vitest";
import { ClaimsSchema, buildExtractClaimsRequest } from "@/lib/prompts/extract-claims";

describe("ClaimsSchema", () => {
  it("parses a list of categorised claims", () => {
    const valid = {
      claims: [
        { text: "Pair programming reduced defects by 15%.", category: "finding" },
        { text: "Sample was 200 industry developers.", category: "methodology" },
      ],
    };
    expect(ClaimsSchema.parse(valid)).toEqual(valid);
  });

  it("rejects unknown category", () => {
    expect(() =>
      ClaimsSchema.parse({ claims: [{ text: "x", category: "weird" }] }),
    ).toThrow();
  });
});

describe("buildExtractClaimsRequest", () => {
  it("caches the paper markdown and references the user question", () => {
    const req = buildExtractClaimsRequest({
      question: "Does pair programming help?",
      paperMarkdown: "# Title\n\nBody.",
    });
    expect(req.system).toHaveLength(2);
    const [instr, paperBlock] = req.system;
    expect(instr?.text).toMatch(/extract/i);
    expect(paperBlock?.text).toContain("# Title");
    expect(paperBlock?.cache_control).toEqual({ type: "ephemeral" });
    const [userMsg] = req.messages;
    expect(JSON.stringify(userMsg?.content)).toContain("Does pair programming help?");
  });
});
