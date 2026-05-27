import { describe, it, expect } from "vitest";
import {
  DiscoveredPaperSpecSchema,
  SearchProviderError,
} from "@/lib/search/types";

describe("DiscoveredPaperSpecSchema", () => {
  const validHit = {
    provider: "openalex",
    externalId: "10.1145/3641289.3641290",
    title: "On the effect of foo on bar",
    authors: ["A. Author", "B. Author"],
    abstract: "We study foo and find bar.",
    publicationYear: 2024,
    venue: "ICSE",
    citationCount: 42,
    oaUrl: "https://example.org/foo.pdf",
    accessStatus: "open",
    initialScore: 0.87,
  };

  it("accepts a fully-populated hit", () => {
    expect(DiscoveredPaperSpecSchema.safeParse(validHit).success).toBe(true);
  });

  it("accepts null on fields the provider couldn't return", () => {
    const sparse = {
      ...validHit,
      abstract: null,
      publicationYear: null,
      venue: null,
      citationCount: null,
      oaUrl: null,
      accessStatus: "unknown",
    };
    expect(DiscoveredPaperSpecSchema.safeParse(sparse).success).toBe(true);
  });

  it("rejects unknown provider names", () => {
    const r = DiscoveredPaperSpecSchema.safeParse({ ...validHit, provider: "scopus" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid accessStatus values", () => {
    const r = DiscoveredPaperSpecSchema.safeParse({ ...validHit, accessStatus: "embargoed" });
    expect(r.success).toBe(false);
  });

  it("rejects initialScore outside [0, 1]", () => {
    expect(DiscoveredPaperSpecSchema.safeParse({ ...validHit, initialScore: 1.5 }).success).toBe(false);
    expect(DiscoveredPaperSpecSchema.safeParse({ ...validHit, initialScore: -0.1 }).success).toBe(false);
  });

  it("rejects empty externalId / title", () => {
    expect(DiscoveredPaperSpecSchema.safeParse({ ...validHit, externalId: "" }).success).toBe(false);
    expect(DiscoveredPaperSpecSchema.safeParse({ ...validHit, title: "" }).success).toBe(false);
  });

  it("rejects oaUrl that isn't a URL", () => {
    expect(DiscoveredPaperSpecSchema.safeParse({ ...validHit, oaUrl: "not-a-url" }).success).toBe(false);
  });
});

describe("SearchProviderError", () => {
  it("prefixes the message with the provider name", () => {
    const e = new SearchProviderError("openalex", "rate limited");
    expect(e.message).toBe("[openalex] rate limited");
    expect(e.provider).toBe("openalex");
    expect(e.name).toBe("SearchProviderError");
  });

  it("preserves the underlying cause when given", () => {
    const root = new Error("ECONNRESET");
    const e = new SearchProviderError("arxiv", "transient network", root);
    expect(e.cause).toBe(root);
  });
});
