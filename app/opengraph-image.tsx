import { ImageResponse } from "next/og";

// Next.js Metadata Files: this file is picked up by the framework and used
// as the root-level Open Graph image. The exported `size` + `contentType`
// tell Next.js what HTTP headers and og:image:width / og:image:height to
// emit; the default export is invoked at request time to render the PNG.
//
// Sharing https://thoth-slr.vercel.app now produces a 1200×630 card with
// the Thoth wordmark, tagline, and a one-line cite_check value-prop on the
// papyrus brand surface — replacing the SVG fallback that some crawlers
// (notably Slack's, depending on its current Unfurl rules) didn't render.

export const runtime = "edge";
export const alt = "Thoth — Agentic systematic literature reviews";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand hex literals — mirror the OKLCH tokens declared in app/globals.css.
// ImageResponse can't read CSS variables, so keep these in sync if the brand
// palette changes (see docs/brand.md).
const PAPYRUS = "#FAF7F0";
const BLUE_INK = "#0F1F4D";
const BLUE = "#1E3A8A";
const GOLD = "#C9A961";
const STONE = "#5F574E";
const RULE = "#E5DDC9";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: PAPYRUS,
          fontFamily: "sans-serif",
          color: BLUE_INK,
        }}
      >
        {/* Eyebrow */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: STONE,
          }}
        >
          <span style={{ width: 36, height: 2, background: GOLD }} />
          Agentic Systematic Literature Reviews
        </div>

        {/* Wordmark + tagline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize: 240,
              lineHeight: 0.95,
              fontWeight: 600,
              letterSpacing: -6,
              color: BLUE_INK,
            }}
          >
            Thoth
          </div>
          <div
            style={{
              fontSize: 40,
              lineHeight: 1.2,
              maxWidth: 940,
              color: BLUE_INK,
            }}
          >
            Drafts evidence-grounded reviews — and verifies{" "}
            <span style={{ color: BLUE, fontStyle: "italic" }}>every cited claim</span>{" "}
            against the source paper before you read the draft.
          </div>
        </div>

        {/* Footer chips */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${RULE}`,
            paddingTop: 28,
            fontSize: 22,
            color: STONE,
          }}
        >
          <div style={{ display: "flex", gap: 28 }}>
            <span>cite_check post-pass</span>
            <span style={{ color: RULE }}>·</span>
            <span>MCP-registered</span>
            <span style={{ color: RULE }}>·</span>
            <span>$0/mo deploy</span>
          </div>
          <div style={{ color: BLUE, fontWeight: 600 }}>thoth-slr.vercel.app</div>
        </div>
      </div>
    ),
    size,
  );
}
