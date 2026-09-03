import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '@latex-workshop/config';
import { Readable } from 'node:stream';

export class ObjectStorage {
  readonly client: S3Client;
  readonly publicClient: S3Client;
  constructor(private readonly config: AppConfig) {
    const shared = {
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
    };
    this.client = new S3Client({ endpoint: config.S3_ENDPOINT, ...shared });
    this.publicClient = new S3Client({
      endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT,
      ...shared,
    });
  }

  async ensureBucket() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.S3_BUCKET }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.S3_BUCKET }));
    }
  }

  put(key: string, body: Uint8Array | string, contentType = 'application/octet-stream') {
    return this.client.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getBuffer(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
    );
    if (!result.Body) throw new Error('Object has no body');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async getStream(key: string, range?: string) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Range: range }),
    );
    return {
      stream: result.Body as Readable,
      contentLength: result.ContentLength,
      contentRange: result.ContentRange,
      contentType: result.ContentType,
      etag: result.ETag,
    };
  }

  delete(key: string) {
    return this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
  }

  async head(key: string) {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }),
    );
    return {
      size: result.ContentLength ?? 0,
      contentType: result.ContentType ?? 'application/octet-stream',
    };
  }

  presignPut(key: string, contentType: string, expiresIn = 300) {
    return getSignedUrl(
      this.publicClient,
      new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn },
    );
  }

  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const objects = (result.Contents ?? []).flatMap((object) =>
        object.Key ? [{ Key: object.Key }] : [],
      );
      if (objects.length)
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.S3_BUCKET,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
  }
}
