import { BlobServiceClient, BlockBlobClient, BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob';
import { v4 as uuidv4 } from 'uuid';
import { FILE_UPLOAD } from '../constants/validation';

/**
 * 接続文字列から自アカウントのBlobエンドポイントのホストを組み立てる
 *
 * コンストラクタと静的バリデータの両方から使う。片方だけが古い組み立て方を
 * 持つと、入口と出口で許可するURLが食い違うため共通化している
 * @param connectionString ストレージの接続文字列
 * @returns ホスト名。AccountNameが取れない場合はnull
 */
function resolveBlobEndpointHost(connectionString: string): string | null {
  const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
  if (!accountNameMatch) {
    return null;
  }
  const endpointSuffixMatch = connectionString.match(/EndpointSuffix=([^;]+)/);
  const endpointSuffix = endpointSuffixMatch ? endpointSuffixMatch[1] : 'core.windows.net';
  return `${accountNameMatch[1]}.blob.${endpointSuffix}`;
}

export class StorageService {
  private blobServiceClient: BlobServiceClient;
  private containerName: string;
  private tempContainerName: string;
  private storageAccountName: string;
  private storageAccountKey: string;
  private blobEndpointHost: string;

  constructor() {
    const connectionString = process.env.STORAGE_CONNECTION_STRING!;
    this.containerName = process.env.STORAGE_CONTAINER_NAME!;
    this.tempContainerName = process.env.TEMP_STORAGE_CONTAINER_NAME || 'temp';
    
    // BlobEndpoint を明示した接続文字列は未対応。
    //
    // SDK はそのエンドポイントを使うが、こちらは AccountName と EndpointSuffix から
    // ホストを組み立てるため両者が食い違う。食い違うと、自分が生成した URL を
    // isValidImagePath() が 400 で弾き、deleteImage() も常に false を返して
    // 孤児 Blob が永久に残る。静かに誤動作するより、ここで失敗させる。
    //
    // 対応するには、Azurite のようなパス形式のエンドポイント
    // （/<アカウント名>/<コンテナ>/<Blob> の3セグメント）を前提に検証を
    // 書き直す必要がある。現在の「ちょうど2セグメント」のルールと衝突するため、
    // バックログの判断待ちとして分離している
    if (/(^|;)\s*BlobEndpoint=/i.test(connectionString)) {
      throw new Error('BlobEndpointを明示した接続文字列は未対応です');
    }

    // Connection stringから account name と key を抽出
    const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
    const accountKeyMatch = connectionString.match(/AccountKey=([^;]+)/);
    
    if (!accountNameMatch || !accountKeyMatch) {
      throw new Error('Storage connection string format is invalid');
    }
    
    this.storageAccountName = accountNameMatch[1];
    this.storageAccountKey = accountKeyMatch[1];

    // 自アカウントのBlobエンドポイントのホストを組み立てる。
    // URLのホストを検証せずにファイル名とコンテナ名だけで削除先を決めると、
    // 外部ホストのURLを渡すだけで自分のコンテナの同名Blobを消せてしまう
    this.blobEndpointHost = resolveBlobEndpointHost(connectionString)!;

    this.blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  }

  /**
   * 画像をBlobストレージにアップロードする
   * @param imageBuffer 画像データ
   * @param contentType コンテンツタイプ
   * @returns アップロードされた画像のURL
   */
  async uploadImage(imageBuffer: Buffer, contentType: string): Promise<string> {
    try {
      // ユニークなファイル名を生成
      const uniqueFileName = this.generateUniqueFileName(contentType);
      
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
      
      // 公開URLを返す（SAS不要）
      return blockBlobClient.url;
      
    } catch (error: any) {
      throw new Error(`画像のアップロードに失敗しました: ${error.message}`);
    }
  }

  /**
   * 画像を一時保存する
   * @param imageBuffer 画像データ
   * @param contentType コンテンツタイプ
   * @returns アップロードされた一時画像のURL（SASトークン付き）
   */
  async uploadImageToTemp(imageBuffer: Buffer, contentType: string): Promise<string> {
    try {
      // ユニークなファイル名を生成
      const uniqueFileName = this.generateUniqueFileName(contentType);
      
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
      
      // 一時保存はSASトークン付きURLを返す（セキュリティ確保）
      // SAS生成はアップロードの後なので、失敗したらアップロード済みのBlobを
      // 後片付けする。一時コンテナにライフサイクルポリシーがないため、
      // 残すと孤児Blobが永久に蓄積する
      try {
        return this.generateSasUrl(blockBlobClient.url, this.tempContainerName);
      } catch (sasError: any) {
        try {
          await blockBlobClient.delete();
        } catch {
          // 後片付けの失敗で元の原因を隠さない
        }
        throw sasError;
      }
      
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

      // 公開URLを返す（SAS不要）
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
      // Blob名はコンテナ名より後ろのパス全体を使う。
      // 最後のセグメントだけを取ると、間に余分なセグメントを挟んだURL
      // （.../images/x/other.jpg）が別のBlob（images/other.jpg）を指してしまう
      const fileName = this.extractBlobNameFromUrl(imageUrl);
      if (!fileName) {
        return false;
      }
      
      // 自アカウント以外のホストを指すURLは何も削除しない。
      // コンテナ判定は未知のコンテナを永続コンテナにフォールバックさせるため、
      // ホストを見ないと「ファイル名が一致するだけの他レコードのBlob」を消せてしまう
      if (new URL(imageUrl).host !== this.blobEndpointHost) {
        return false;
      }

      // コンテナは永続・一時のいずれかと完全一致する場合だけ扱う。
      // 一致しないものを永続コンテナにフォールバックさせると、
      // 知らないコンテナ名のURLでも永続側の同名Blobを消せてしまう
      const containerName = this.extractContainerNameFromUrl(imageUrl);
      if (containerName !== this.containerName && containerName !== this.tempContainerName) {
        return false;
      }
      
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
   * SAS URLを生成する（外部からのアクセス用）
   * @param blobUrl 元のBlob URL
   * @param containerName コンテナ名
   * @param expiryHours 有効期限（時間、デフォルト: 8760時間=1年）
   * @returns SAS URL
   * @throws 生成に失敗した場合（フォールバックしない）
   */
  private generateSasUrl(blobUrl: string, containerName: string, expiryHours: number = 8760): string {
    try {
      // URLからファイル名を抽出
      const fileName = this.extractFileNameFromUrl(blobUrl);
      if (!fileName) {
        throw new Error('URLからファイル名を抽出できません');
      }

      // SAS権限を設定（読み取りのみ）
      const permissions = new BlobSASPermissions();
      permissions.read = true;

      // 有効期限を設定
      const expiryTime = new Date();
      expiryTime.setHours(expiryTime.getHours() + expiryHours);

      // 認証情報を作成
      const sharedKeyCredential = new StorageSharedKeyCredential(
        this.storageAccountName,
        this.storageAccountKey
      );

      // SASクエリパラメータを生成
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName: fileName,
          permissions,
          expiresOn: expiryTime,
        },
        sharedKeyCredential
      ).toString();

      // SAS URLを構築
      return `${blobUrl}?${sasToken}`;

    } catch (error: any) {
      // 一時コンテナは非公開（container_access_type = "private"）のため、
      // 生のURLを返しても静かに403になるだけでフォールバックの意味がない。
      // SAS URLはAzure OpenAIが非公開Blobを読むために必要なので、
      // 生成できない場合は原因に近い場所で失敗させる
      throw new Error(`SAS URLの生成に失敗しました: ${error.message}`);
    }
  }

  /**
   * ユニークなBlob名を生成
   *
   * 拡張子は検証済みのContent-Typeから引く。クライアントが送るファイル名から
   * 取ると、/ を含む名前で拡張子にパス区切りが紛れ込み、Blob名とSASの
   * 署名対象がずれる（FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE のコメント参照）
   * @param contentType コンテンツタイプ
   * @returns ユニークなBlob名
   */
  private generateUniqueFileName(contentType: string): string {
    const extension = FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()] || '';
    const uuid = uuidv4();
    return `${uuid}${extension}`;
  }

  /**
   * URLからBlob名を抽出
   *
   * コンテナ名より後ろのパス全体を返す。最後のセグメントだけを取ると、
   * 間に任意のセグメントを挟んだURLが別のBlobを指せてしまう
   * @param url URL
   * @returns Blob名。取り出せない場合はnull
   */
  private extractBlobNameFromUrl(url: string): string | null {
    try {
      const segments = new URL(url).pathname.split('/');
      return segments.slice(2).join('/') || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * URLからコンテナ名を抽出
   *
   * パスセグメントで判定する。URL全体への文字列包含で判定すると、
   * ストレージアカウント名に一時コンテナ名が含まれる場合に永続画像を
   * 一時コンテナから消そうとして失敗し、deleteImage()が404を正常扱いするため
   * 「成功したのに画像が残っている」状態になる。
   * 部分一致ではなく完全一致で比較すること（コンテナ名が一時コンテナ名で
   * 始まるだけの場合も永続扱いにする必要がある）
   * @param url URL。呼び出し元がextractFileNameFromUrl()でパース可能なことを
   *            確認済みであることを前提とする（不正URLはそこで弾かれる）
   * @returns コンテナ名
   */
  private extractContainerNameFromUrl(url: string): string {
    return new URL(url).pathname.split('/')[1];
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
   * 画像パスが自アカウントの永続コンテナを指すURLかを検証
   *
   * ハンドラが受け取るimagePathは、アップロードAPIが返した自アカウントのURLだけが正当。
   * ホストとコンテナを見ずに保存すると、外部ホストのURLを保存しておいて
   * 更新時の旧画像削除を発火させることで、他レコードのBlobを削除できてしまう
   * @param imagePath 検証対象の画像URL
   * @returns 自アカウントの永続コンテナを指すかどうか
   */
  static isValidImagePath(imagePath: string): boolean {
    const connectionString = process.env.STORAGE_CONNECTION_STRING;
    const containerName = process.env.STORAGE_CONTAINER_NAME;
    if (!connectionString || !containerName) {
      return false;
    }

    const expectedHost = resolveBlobEndpointHost(connectionString);
    if (!expectedHost) {
      return false;
    }

    try {
      const url = new URL(imagePath);

      // スキームを明示的に限定する。
      // ホストの一致だけでも javascript: や data: は弾かれる（それらのホストは
      // 空文字になる）が、それは偶然の副作用でしかない。ホスト検証を緩めたときに
      // スキームの防御まで同時に緩むのを避けるため、独立した条件にしておく
      if (url.protocol !== 'https:') {
        return false;
      }

      if (url.host !== expectedHost) {
        return false;
      }

      // アップロードAPIが返す形は必ず /<コンテナ名>/<Blob名> の2セグメント。
      // 最初のセグメントだけを見ると中間に任意のセグメントを挟んだURLも通り、
      // 存在しないBlobを指す壊れた参照を保存できてしまう
      const segments = url.pathname.split('/');
      return segments.length === 3 && segments[1] === containerName && segments[2] !== '';
    } catch (error) {
      return false;
    }
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