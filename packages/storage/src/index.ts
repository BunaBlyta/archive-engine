import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

function requireEnv(name: string, devDefault?: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV !== "production" && devDefault !== undefined) {
    return devDefault;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

const client = new S3Client({
  endpoint: requireEnv("MINIO_ENDPOINT", "http://localhost:9000"),
  region: "us-east-1",
  credentials: {
    accessKeyId: requireEnv("MINIO_ROOT_USER", "archive_minio"),
    secretAccessKey: requireEnv("MINIO_ROOT_PASSWORD", "archive_minio_secret"),
  },
  forcePathStyle: true,
});

const BUCKET = requireEnv("MINIO_BUCKET", "archive-blobs");

export async function putBlob(
  hash: string,
  stream: Readable,
  size: number,
  mimeType: string
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: hash,
      Body: stream,
      ContentLength: size,
      ContentType: mimeType,
    })
  );
}

export async function getBlob(hash: string): Promise<Readable> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: hash,
    })
  );
  if (!(response.Body instanceof Readable)) {
    throw new Error(`Unexpected response body type for blob: ${hash}`);
  }
  return response.Body;
}

export async function blobExists(hash: string): Promise<boolean> {
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: hash,
      })
    );
    return true;
  } catch (e: unknown) {
    if (
      e instanceof S3ServiceException &&
      (e.$metadata?.httpStatusCode === 404 ||
        e.name === "NotFound" ||
        e.name === "NoSuchKey")
    ) {
      return false;
    }
    throw e;
  }
}
