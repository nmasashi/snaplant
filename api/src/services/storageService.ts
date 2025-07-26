import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';
import { v4 as uuidv4 } from 'uuid';
import { FILE_UPLOAD } from '../constants/validation';

export class StorageService {
  private blobServiceClient: BlobServiceClient;
  private containerName: string;
  private tempContainerName: string;

  constructor() {
    const connectionString = process.env.STORAGE_CONNECTION_STRING!;
    this.containerName = process.env.STORAGE_CONTAINER_NAME!;
    this.tempContainerName = process.env.TEMP_STORAGE_CONTAINER_NAME || 'temp';
    
    this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  }

  /**
   * 画像をBlobストレージにアップロードする
   * @param imageBuffer 画像データ
   * @param fileName ファイル名
   * @param contentType コンテンツタイプ
   * @returns アップロードされた画像のURL
   */
  async uploadImage(imageBuffer: Buffer, fileName: string, contentType: string): Promise<string> {
    try {
      // ユニークなファイル名を生成
      const uniqueFileName = this.generateUniqueFileName(fileName);
      
      // コンテナクライアントを取得
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      
      // ブロックBlobクライアントを取得
      const blockBlobClient: BlockBlobClient = containerClient.getBlockBlobClient(uniqueFileName);
      
      // 画像をアップロード
      await blockBlobClient.upload(imageBuffer, imageBuffer.length, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });
      
      // アップロードされた画像のURLを返す
      return blockBlobClient.url;
      
    } catch (error: any) {
      throw new Error(`画像のアップロードに失敗しました: ${error.message}`);
    }
  }

  /**
   * 画像を一時保存する
   * @param imageBuffer 画像データ
   * @param fileName ファイル名
   * @param contentType コンテンツタイプ
   * @returns アップロードされた一時画像のURL
   */
  async uploadImageToTemp(imageBuffer: Buffer, fileName: string, contentType: string): Promise<string> {
    try {
      // ユニークなファイル名を生成
      const uniqueFileName = this.generateUniqueFileName(fileName);
      
      // 一時コンテナクライアントを取得
      const containerClient = this.blobServiceClient.getContainerClient(this.tempContainerName);
      
      // ブロックBlobクライアントを取得
      const blockBlobClient: BlockBlobClient = containerClient.getBlockBlobClient(uniqueFileName);
      
      // 画像をアップロード
      await blockBlobClient.upload(imageBuffer, imageBuffer.length, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });
      
      // アップロードされた画像のURLを返す
      return blockBlobClient.url;
      
    } catch (error: any) {
      throw new Error(`一時画像のアップロードに失敗しました: ${error.message}`);
    }
  }

  /**
   * 一時保存した画像を永続保存に移動する
   * @param tempImageUrl 一時保存の画像URL
   * @returns 永続保存された画像のURL
   */
  async moveFromTempToPermanent(tempImageUrl: string): Promise<string> {
    try {
      // 一時ファイル名を抽出
      const tempFileName = this.extractFileNameFromUrl(tempImageUrl);
      if (!tempFileName) {
        throw new Error('一時画像URLからファイル名を抽出できません');
      }

      // 一時コンテナクライアントを取得
      const tempContainerClient = this.blobServiceClient.getContainerClient(this.tempContainerName);
      const tempBlockBlobClient = tempContainerClient.getBlockBlobClient(tempFileName);

      // 画像データを取得
      const downloadResponse = await tempBlockBlobClient.download();
      const imageBuffer = await this.streamToBuffer(downloadResponse.readableStreamBody!);

      // メタデータを取得
      const properties = await tempBlockBlobClient.getProperties();
      const contentType = properties.contentType || 'image/jpeg';

      // 永続コンテナにアップロード
      const permanentContainerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const permanentBlockBlobClient = permanentContainerClient.getBlockBlobClient(tempFileName);

      await permanentBlockBlobClient.upload(imageBuffer, imageBuffer.length, {
        blobHTTPHeaders: {
          blobContentType: contentType
        }
      });

      // 一時ファイルを削除
      await tempBlockBlobClient.delete();

      // 永続保存された画像のURLを返す
      return permanentBlockBlobClient.url;

    } catch (error: any) {
      throw new Error(`画像の永続保存への移動に失敗しました: ${error.message}`);
    }
  }

  /**
   * ReadableStreamをBufferに変換する
   * @param stream ReadableStream
   * @returns Buffer
   */
  private async streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * 画像を削除する
   * @param imageUrl 画像URL
   * @returns 削除が成功したかどうか
   */
  async deleteImage(imageUrl: string): Promise<boolean> {
    try {
      // URLからファイル名を抽出
      const fileName = this.extractFileNameFromUrl(imageUrl);
      if (!fileName) {
        return false;
      }
      
      // URLから適切なコンテナ名を決定
      const containerName = imageUrl.includes(this.tempContainerName) 
        ? this.tempContainerName 
        : this.containerName;
      
      // コンテナクライアントを取得
      const containerClient = this.blobServiceClient.getContainerClient(containerName);
      
      // ブロックBlobクライアントを取得
      const blockBlobClient = containerClient.getBlockBlobClient(fileName);
      
      // 画像を削除
      await blockBlobClient.delete({
        deleteSnapshots: 'include'
      });
      
      return true;
      
    } catch (error: any) {
      // ファイルが存在しない場合は正常とみなす
      if (error.statusCode === 404) {
        return true;
      }
      throw new Error(`画像の削除に失敗しました: ${error.message}`);
    }
  }

  /**
   * 画像が存在するかチェック
   * @param imageUrl 画像URL
   * @returns 画像が存在するかどうか
   */
  async imageExists(imageUrl: string): Promise<boolean> {
    try {
      // URLからファイル名を抽出
      const fileName = this.extractFileNameFromUrl(imageUrl);
      if (!fileName) {
        return false;
      }
      
      // コンテナクライアントを取得
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      
      // ブロックBlobクライアントを取得
      const blockBlobClient = containerClient.getBlockBlobClient(fileName);
      
      // プロパティを取得して存在をチェック
      await blockBlobClient.getProperties();
      return true;
      
    } catch (error: any) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * ユニークなファイル名を生成
   * @param originalFileName 元のファイル名
   * @returns ユニークなファイル名
   */
  private generateUniqueFileName(originalFileName: string): string {
    const extension = this.extractFileExtension(originalFileName);
    const uuid = uuidv4();
    return `${uuid}${extension}`;
  }

  /**
   * ファイル拡張子を抽出
   * @param fileName ファイル名
   * @returns ファイル拡張子
   */
  private extractFileExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf('.');
    return lastDotIndex > 0 ? fileName.substring(lastDotIndex) : '';
  }

  /**
   * URLからファイル名を抽出
   * @param url URL
   * @returns ファイル名
   */
  private extractFileNameFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      const pathSegments = urlObj.pathname.split('/');
      return pathSegments[pathSegments.length - 1] || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * 画像のコンテンツタイプを検証
   * @param contentType コンテンツタイプ
   * @returns 有効な画像コンテンツタイプかどうか
   */
  static isValidImageContentType(contentType: string): boolean {
    return FILE_UPLOAD.SUPPORTED_IMAGE_TYPES.includes(contentType.toLowerCase() as any);
  }

  /**
   * ファイルサイズを検証
   * @param size ファイルサイズ（バイト）
   * @returns 有効なサイズかどうか
   */
  static isValidFileSize(size: number): boolean {
    return size > 0 && size <= FILE_UPLOAD.MAX_SIZE;
  }
}