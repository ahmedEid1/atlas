import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import "dotenv/config";

// Probe MinIO at import time. When unreachable (the common case for a fresh
// `pnpm test` without `docker compose up -d`) skip the suite cleanly with a
// one-line note instead of failing — these are integration tests, the README
// documents the docker prerequisite, and a hard failure here misleads new
// contributors into thinking the codebase is broken.
const s3Endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9010";
const minioProbe = await fetch(`${s3Endpoint}/minio/health/live`).catch(() => null);
const minioReady = !!minioProbe?.ok;

if (!minioReady) {
  console.warn(
    `[object-store] MinIO not reachable at ${s3Endpoint} — skipping integration tests. ` +
      `Run \`docker compose up -d\` to enable.`,
  );
}

describe.skipIf(!minioReady)("object-store (integration)", () => {

  it("puts and fetches an object", async () => {
    const { putObject, getObjectBytes } = await import("@/lib/object-store");
    const key = `test/${randomUUID()}.txt`;
    const bytes = new TextEncoder().encode("hello thoth");

    await putObject(key, bytes, "text/plain");
    const fetched = await getObjectBytes(key);

    expect(new TextDecoder().decode(fetched)).toBe("hello thoth");
  });

  it("returns a presigned GET URL", async () => {
    const { putObject, getSignedGetUrl } = await import("@/lib/object-store");
    const key = `test/${randomUUID()}.bin`;
    await putObject(key, new Uint8Array([1, 2, 3]), "application/octet-stream");

    const url = await getSignedGetUrl(key, 60);
    const expectedPrefix = (process.env.S3_ENDPOINT ?? "http://localhost:9010") + "/thoth-corpus/";
    expect(url.startsWith(expectedPrefix)).toBe(true);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });
});
