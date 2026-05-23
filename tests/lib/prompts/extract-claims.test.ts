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
  it("embeds the paper markdown in system and references the user question", () => {
    const req = buildExtractClaimsRequest({
      question: "Does pair programming help?",
      paperMarkdown: "# Title\n\nBody.",
    });
    expect(req.system).toMatch(/extract/i);
    expect(req.system).toContain("<paper>");
    expect(req.system).toContain("# Title");
    const [userMsg] = req.messages;
    expect(JSON.stringify(userMsg?.content)).toContain("Does pair programming help?");
  });
});
