import "dotenv/config";
import { putObject, getObjectBytes, getSignedGetUrl } from "../lib/object-store";

async function main() {
  const key = `smoke-test/m3.5b-r2-${Date.now()}.txt`;
  const body = new TextEncoder().encode(
    "Hello from Atlas M3.5b R2 smoke test. If you're reading this, the round-trip works.",
  );

  console.log("→ PUT object:", key);
  const t0 = Date.now();
  await putObject(key, body, "text/plain");
  console.log(`  ✓ uploaded ${body.length} bytes in ${Date.now() - t0}ms`);

  console.log("→ GET object back:");
  const t1 = Date.now();
  const bytes = await getObjectBytes(key);
  console.log(`  ✓ downloaded ${bytes.length} bytes in ${Date.now() - t1}ms`);

  const text = new TextDecoder().decode(bytes);
  if (text !== new TextDecoder().decode(body)) {
    console.error("✗ FAIL: roundtrip text mismatch");
    process.exit(1);
  }
  console.log(`  ✓ roundtrip text matches`);

  console.log("→ Generate signed GET URL (60s TTL):");
  const url = await getSignedGetUrl(key, 60);
  console.log(`  ✓ URL: ${url.substring(0, 100)}...`);

  console.log("→ Fetch via signed URL (proves the URL works without auth headers):");
  const t2 = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`✗ FAIL: signed URL returned ${res.status}`);
    process.exit(1);
  }
  const fetched = await res.text();
  if (fetched !== text) {
    console.error("✗ FAIL: signed URL content mismatch");
    process.exit(1);
  }
  console.log(`  ✓ signed URL fetch succeeded in ${Date.now() - t2}ms`);

  console.log(`\n✓ R2 round-trip complete. Object left at ${key} (clean up manually if desired).`);
}

main().catch((err) => {
  console.error("✗ FAIL:", err);
  process.exit(1);
});
