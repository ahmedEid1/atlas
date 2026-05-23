import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

let _client: S3Client | null = null;

/**
 * Lazy S3 client — created on first use, not at module load. This lets build /
 * indexing tools (Trigger.dev deploy indexer, Next.js build, etc.) import this
 * module without env vars being set. Same lazy-init pattern as lib/db.ts +
 * lib/env.ts.
 */
function getClient(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
  return _client;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await getClient().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`empty body for ${key}`);
  return await res.Body.transformToByteArray();
}

export async function getSignedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
