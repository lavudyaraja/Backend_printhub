// Backblaze B2 object storage (S3-compatible) — the ONLY file store.
// Files live in B2 purely as a temporary buffer: an uploaded document sits here
// until it is printed (or the TTL sweeper fires), then it is deleted. Nothing is
// retained long-term. Preview page images are cached under "<fileKey>_page_N.png".
//
// Env: B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APP_KEY
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = process.env.B2_BUCKET || "";

export function storageConfigured() {
  return !!(process.env.B2_ENDPOINT && process.env.B2_KEY_ID && process.env.B2_APP_KEY && BUCKET);
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (!storageConfigured()) {
    throw new Error(
      "[storage] Backblaze B2 is not configured. Set B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APP_KEY."
    );
  }
  if (!_client) {
    _client = new S3Client({
      endpoint: process.env.B2_ENDPOINT,
      region: process.env.B2_REGION || "us-east-005",
      credentials: {
        accessKeyId: process.env.B2_KEY_ID!,
        secretAccessKey: process.env.B2_APP_KEY!,
      },
      forcePathStyle: true, // B2's S3 API expects path-style addressing
    });
  }
  return _client;
}

export async function putObject(key: string, body: Buffer, contentType?: string) {
  await client().send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType })
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

// Short-lived signed GET URL — the IoT agent downloads the file directly from B2.
export async function presignGet(key: string, expiresSeconds = 600): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: expiresSeconds,
  });
}

export async function deleteKeys(keys: string[]) {
  if (!keys.length) return;
  await client().send(
    new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } })
  );
}

// Delete an original file plus all of its cached preview pages.
export async function deleteFileAndPreviews(fileKey: string) {
  const previewKeys = await listKeys(`${fileKey}_page_`);
  await deleteKeys([fileKey, ...previewKeys]);
}

async function listKeys(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await client().send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token })
    );
    for (const o of res.Contents || []) if (o.Key) out.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}
