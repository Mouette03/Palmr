/**
 * Local Filesystem Storage Provider
 *
 * Replaces the S3/MinIO provider with a simple local filesystem implementation.
 * Files are stored in /app/server/uploads/{objectName}.
 *
 * Upload flow:
 * - Simple upload: PUT /api/files/upload?objectName=xxx (via Next.js proxy)
 * - Multipart: create session → upload parts → assemble
 *
 * Download flow:
 * - GET /api/files/download?objectName=xxx (via Next.js proxy → backend stream)
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Transform } from "stream";
import { pipeline } from "stream";
import { promisify } from "util";

import { directoriesConfig } from "../config/directories.config";
import { StorageProvider } from "../types/storage";

const pipelineAsync = promisify(pipeline);

export class LocalStorageProvider implements StorageProvider {
  /**
   * Resolve objectName to an absolute file path under the uploads directory.
   * Prevents path traversal attacks.
   */
  private getFilePath(objectName: string): string {
    const safeName = objectName.replace(/\.\./g, "_").replace(/^\/+/, "");
    return path.join(directoriesConfig.uploads, safeName);
  }

  /**
   * Resolve temp directory for a multipart upload session.
   */
  private getTempPartDir(uploadId: string): string {
    return path.join(directoriesConfig.tempUploads, `multipart-${uploadId}`);
  }

  /**
   * Returns a relative URL that the browser will call via the Next.js proxy.
   * The Next.js proxy at /api/files/upload forwards to PUT /files/upload on the backend.
   */
  async getPresignedPutUrl(objectName: string, _expires: number): Promise<string> {
    return `/api/files/upload?objectName=${encodeURIComponent(objectName)}`;
  }

  /**
   * Returns a relative URL for downloading.
   * The Next.js proxy at /api/files/download forwards to GET /files/download on the backend.
   */
  async getPresignedGetUrl(objectName: string, _expires: number, _fileName?: string): Promise<string> {
    return `/api/files/download?objectName=${encodeURIComponent(objectName)}`;
  }

  async deleteObject(objectName: string): Promise<void> {
    const filePath = this.getFilePath(objectName);
    try {
      await fsPromises.unlink(filePath);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async fileExists(objectName: string): Promise<boolean> {
    const filePath = this.getFilePath(objectName);
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async getObjectStream(objectName: string): Promise<NodeJS.ReadableStream> {
    const filePath = this.getFilePath(objectName);
    return fs.createReadStream(filePath);
  }

  /**
   * Initialize a multipart upload session.
   * Creates a temp directory identified by a UUID.
   */
  async createMultipartUpload(objectName: string): Promise<string> {
    const uploadId = crypto.randomUUID();
    const tempDir = this.getTempPartDir(uploadId);
    await fsPromises.mkdir(tempDir, { recursive: true });
    // Persist the target objectName in case we need it later
    await fsPromises.writeFile(path.join(tempDir, "_objectName"), objectName, "utf-8");
    return uploadId;
  }

  /**
   * Returns the URL to PUT a specific part to.
   * The URL includes uploadId and partNumber as query params so the backend can
   * save the part to the correct temp directory.
   */
  async getPresignedPartUrl(
    objectName: string,
    uploadId: string,
    partNumber: number,
    _expires: number
  ): Promise<string> {
    return (
      `/api/files/upload?objectName=${encodeURIComponent(objectName)}` +
      `&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`
    );
  }

  /**
   * Assemble all uploaded parts into the final file.
   * Parts are concatenated in PartNumber order.
   */
  async completeMultipartUpload(
    objectName: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>
  ): Promise<void> {
    const tempDir = this.getTempPartDir(uploadId);
    const finalPath = this.getFilePath(objectName);

    await fsPromises.mkdir(path.dirname(finalPath), { recursive: true });

    // Remove any incomplete previous attempt
    try {
      await fsPromises.unlink(finalPath);
    } catch {}

    const sortedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);

    for (const part of sortedParts) {
      const partPath = path.join(tempDir, `part-${part.PartNumber}`);
      const partData = await fsPromises.readFile(partPath);
      await fsPromises.appendFile(finalPath, partData);
    }

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }

  async abortMultipartUpload(_objectName: string, uploadId: string): Promise<void> {
    const tempDir = this.getTempPartDir(uploadId);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }

  /**
   * Save a raw stream to disk.
   * Used by the PUT /files/upload route handler.
   * For parts: saves to temp dir and returns the ETag (MD5 of content).
   * For simple uploads: saves directly to the uploads directory.
   */
  async saveStreamToFile(
    stream: NodeJS.ReadableStream,
    objectName: string,
    uploadId?: string,
    partNumber?: number
  ): Promise<{ etag?: string }> {
    const safeName = objectName.replace(/\.\./g, "_").replace(/^\/+/, "");

    if (uploadId !== undefined && partNumber !== undefined) {
      // Multipart part upload
      const tempDir = this.getTempPartDir(uploadId);
      await fsPromises.mkdir(tempDir, { recursive: true });
      const partPath = path.join(tempDir, `part-${partNumber}`);

      const hash = crypto.createHash("md5");
      const hashTransform = new Transform({
        transform(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null, data?: Buffer) => void) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });

      const writeStream = fs.createWriteStream(partPath);
      await pipelineAsync(stream, hashTransform, writeStream);

      const etag = '"' + hash.digest("hex") + '"';
      return { etag };
    } else {
      // Simple upload
      const filePath = path.join(directoriesConfig.uploads, safeName);
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

      const writeStream = fs.createWriteStream(filePath);
      await pipelineAsync(stream, writeStream);

      return {};
    }
  }
}
