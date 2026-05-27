import { ImageResponse } from "next/og";

// Next.js Metadata Files: this file is picked up by the framework and used
// as the root-level Open Graph image. The exported `size` + `contentType`
// tell Next.js what HTTP headers and og:image:width / og:image:height to
// emit; the default export is invoked at request time to render the PNG.

export const runtime = "edge";
export const alt = "Thoth — Agentic systematic literature reviews";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand hex literals — mirror the OKLCH tokens declared in app/globals.css.
// ImageResponse (Satori) can't read CSS variables, so keep these in sync if
// the brand palette changes (see docs/brand.md).
const PAPYRUS = "#FAF7F0";
const BLUE_INK = "#0F1F4D";
const BLUE = "#1E3A8A";
const GOLD = "#C9A961";
const STONE = "#5F574E";
const RULE = "#E5DDC9";

export default function Image() {
  // Satori — the renderer behind ImageResponse — is strict about CSS:
  // every element needs an explicit `display`, generic font families
  // are unreliable without a registered font, and complex letter-spacing
  // can silently zero the response. Keep the JSX conservative.
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: "100%",
          height: "100%",
          padding: 80,
          backgroundColor: PAPYRUS,
          color: BLUE_INK,
        }}
      >
        {/* Eyebrow */}
        <div style={{ display: "flex", alignItems: "center", color: STONE, fontSize: 22 }}>
          <div style={{ display: "flex", width: 36, height: 2, backgroundColor: GOLD, marginRight: 16 }} />
          <div style={{ display: "flex" }}>AGENTIC SYSTEMATIC LITERATURE REVIEWS</div>
        </div>

        {/* Wordmark + tagline */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 240,
              fontWeight: 700,
              color: BLUE_INK,
              lineHeight: 1,
            }}
          >
            Thoth
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 40,
              color: BLUE_INK,
              lineHeight: 1.25,
              maxWidth: 940,
            }}
          >
            Drafts evidence-grounded reviews — and verifies every cited claim against the source paper before you read the draft.
          </div>
        </div>

        {/* Footer */}
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
          <div style={{ display: "flex" }}>
            cite_check post-pass · MCP-registered · $0/mo deploy
          </div>
          <div style={{ display: "flex", color: BLUE, fontWeight: 700 }}>
            thoth-slr.vercel.app
          </div>
        </div>
      </div>
    ),
    size,
  );
}
