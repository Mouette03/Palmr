import { LocalStorageProvider } from "../../providers/local-storage.provider";
import { StorageProvider } from "../../types/storage";

export class FileService {
  private storageProvider: StorageProvider;
  private localProvider: LocalStorageProvider;

  constructor() {
    this.localProvider = new LocalStorageProvider();
    this.storageProvider = this.localProvider;
  }

  /**
   * Save a raw stream to disk (upload handler).
   * For simple uploads: saves directly to uploads dir.
   * For multipart parts: saves to temp dir and returns ETag.
   */
  async saveStreamToFile(
    stream: NodeJS.ReadableStream,
    objectName: string,
    uploadId?: string,
    partNumber?: number
  ): Promise<{ etag?: string }> {
    return await this.localProvider.saveStreamToFile(stream, objectName, uploadId, partNumber);
  }

  async getPresignedPutUrl(objectName: string, expires: number = 3600): Promise<string> {
    return await this.storageProvider.getPresignedPutUrl(objectName, expires);
  }

  async getPresignedGetUrl(objectName: string, expires: number = 3600, fileName?: string): Promise<string> {
    return await this.storageProvider.getPresignedGetUrl(objectName, expires, fileName);
  }

  async deleteObject(objectName: string): Promise<void> {
    try {
      await this.storageProvider.deleteObject(objectName);
    } catch (err) {
      console.error("Error deleting object:", err);
      throw err;
    }
  }

  async getObjectStream(objectName: string): Promise<NodeJS.ReadableStream> {
    try {
      return await this.storageProvider.getObjectStream(objectName);
    } catch (err) {
      console.error("Error getting object stream:", err);
      throw err;
    }
  }

  // Multipart upload methods
  async createMultipartUpload(objectName: string): Promise<string> {
    return await this.storageProvider.createMultipartUpload(objectName);
  }

  async getPresignedPartUrl(
    objectName: string,
    uploadId: string,
    partNumber: number,
    expires: number = 3600
  ): Promise<string> {
    return await this.storageProvider.getPresignedPartUrl(objectName, uploadId, partNumber, expires);
  }

  async completeMultipartUpload(
    objectName: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>
  ): Promise<void> {
    await this.storageProvider.completeMultipartUpload(objectName, uploadId, parts);
  }

  async abortMultipartUpload(objectName: string, uploadId: string): Promise<void> {
    await this.storageProvider.abortMultipartUpload(objectName, uploadId);
  }
}
