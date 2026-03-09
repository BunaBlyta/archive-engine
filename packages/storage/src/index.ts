import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

const client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER ?? "archive_minio",
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? "archive_minio_secret",
  },
  forcePathStyle: true,
});

const BUCKET = process.env.MINIO_BUCKET ?? "archive-blobs";

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
  return response.Body as Readable;
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
  } catch {
    return false;
  }
}