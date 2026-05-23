import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: mocks.readdir,
  readFile: mocks.readFile,
}));

const validYaml = `
id: "000-test"
question: "Does X improve Y in adults?"
picoc:
  population: "Adults"
  intervention: "X"
  comparison: "Standard care"
  outcome: "Y"
  context: "Clinical trials"
papers:
  - id: "paper_001"
    title: "Effect of X on Y"
    summary: "RCT of X. 25% improvement at 6m."
    markdown: "# Effect\\n\\nFull text..."
expectedPapers:
  - "paper_001"
expectedClaims:
  - "X improves Y"
metadata:
  source: "Cochrane CDxxx"
  difficulty: "medium"
`;

describe("loadGolden", () => {
  it("loads + parses + validates all .yaml files in evals/golden/", async () => {
    mocks.readdir.mockResolvedValue(["000-test.yaml", "001-other.yaml", "README.md"]);
    mocks.readFile.mockResolvedValue(validYaml);

    const { loadGolden } = await import("@/lib/eval/golden-loader");
    const result = await loadGolden();
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("000-test");
  });

  it("ignores non-.yaml files", async () => {
    mocks.readdir.mockResolvedValue(["README.md", ".DS_Store"]);
    const { loadGolden } = await import("@/lib/eval/golden-loader");
    const result = await loadGolden();
    expect(result).toEqual([]);
  });

  it("throws with a clear file-attributing error when a YAML file fails validation", async () => {
    mocks.readdir.mockResolvedValue(["000-broken.yaml"]);
    mocks.readFile.mockResolvedValue("question: 'too short'"); // missing required fields
    const { loadGolden } = await import("@/lib/eval/golden-loader");
    await expect(loadGolden()).rejects.toThrow(/000-broken\.yaml/);
  });
});
