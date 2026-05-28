import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { TokenSpendBadge } from "@/components/runs/token-spend-badge";

const step = (input: number, output: number, cache = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cache,
});

describe("TokenSpendBadge", () => {
  // React inserts `<!-- -->` comment nodes between adjacent text children
  // when interpolated in JSX. Strip them so substring assertions are
  // resilient to that render detail.
  const stripComments = (html: string) => html.replace(/<!--\s*-->/g, "");

  it("sums input + output across steps and shows percentage of budget", () => {
    const html = stripComments(renderToString(
      TokenSpendBadge({
        steps: [step(1000, 500), step(2000, 1500)],
        budget: 10_000,
      }),
    ));
    // 10_000 hits the >=10_000 threshold so it renders as "10k".
    expect(html).toContain("5,000 / 10k tk");
    expect(html).toContain("50%");
    // Full unabbreviated value lives in the title attribute.
    expect(html).toContain("Billable: 5,000 of 10,000");
  });

  it("formats large counts with k suffix to keep the badge compact", () => {
    const html = stripComments(renderToString(
      TokenSpendBadge({
        steps: [step(100_000, 50_000)],
        budget: 400_000,
      }),
    ));
    expect(html).toContain("150k / 400k tk");
    expect(html).toContain("38%");
  });

  it("does NOT count cache-read tokens toward the budget (matches cost-cap.ts)", () => {
    const html = stripComments(renderToString(
      TokenSpendBadge({
        steps: [step(1000, 500, 99_999)],
        budget: 10_000,
      }),
    ));
    // cost-cap.ts sums in + out only; cache reads are free for the cap.
    // Billable: 1500, not 1500+99999. Budget is 10k so renders as "10k".
    expect(html).toContain("1,500 / 10k tk");
    expect(html).toContain("15%");
  });

  it("renders the warn color class when >= 80% of budget consumed", () => {
    const html = renderToString(
      TokenSpendBadge({
        steps: [step(80_000, 20_000)],
        budget: 100_000,
      }),
    );
    // 100% — should hit the warn threshold (>= 80).
    expect(html).toContain("var(--thoth-warn)");
  });

  it("renders the neutral stone class when well below the budget", () => {
    const html = renderToString(
      TokenSpendBadge({
        steps: [step(1000, 500)],
        budget: 400_000,
      }),
    );
    // <1% — neutral.
    expect(html).toContain("var(--thoth-stone)");
    expect(html).not.toContain("var(--thoth-warn)");
  });

  it("includes a title attribute with the full unabbreviated breakdown", () => {
    const html = renderToString(
      TokenSpendBadge({
        steps: [step(123_456, 7_890, 11)],
        budget: 400_000,
      }),
    );
    expect(html).toContain("Billable: 131,346");
    expect(html).toContain("in 123,456");
    expect(html).toContain("out 7,890");
    expect(html).toContain("cache 11");
  });

  it("omits the cache mention from the title when cache=0 (cleaner UI)", () => {
    const html = renderToString(
      TokenSpendBadge({
        steps: [step(100, 50)],
        budget: 1_000,
      }),
    );
    expect(html).not.toContain("cache");
  });
});
