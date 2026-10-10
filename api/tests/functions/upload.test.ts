import { HttpRequest, InvocationContext } from '@azure/functions';
import { uploadImageHandler } from '../../src/functions/upload';
import { BlobServiceClient, BlockBlobClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import { Readable } from 'stream';

// 外部依存のみモック
// tests/setup.ts のファクトリモックは getBlockBlobClient() に download / getProperties / delete が
// 無く、それに頼ると一時保存→永続保存の移動処理がTypeErrorになって本番コードのcatchに
// 飲み込まれてしまう（console.logも抑制されるため気づけない）。一時保存・永続保存・削除が
// 実際に成功する経路をすべて通せるよう、このファイル内で偽物のBlobバックエンドに差し替える
// （storageService.test.ts と同型）
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));
jest.mock('openai');

const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<typeof generateBlobSASQueryParameters>;

// SASトークンの固定値（一時保存がSAS付きURLを返すことの土台。値自体の検証はstorageService.test.ts側の責務）
const TEST_SAS_TOKEN = 'sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=testsignature';

/**
 * 偽物のBlobバックエンド（storageService.test.ts の FakeBlobBackend と同型）。
 *
 * コンテナ名とBlob名のキーごとに内容をMapに保持する。これにより
 * 「一時→永続への移動で宛先コンテナを取り違える」「削除対象を取り違える」
 * といった不具合を検出できる（単一の共有モックだとどの引数で呼ばれても
 * 同じ値を返すため、宛先の取り違えがテストを通過してしまう）。
 *
 * upload.ts が実際に使うのは upload / download / getProperties / delete の4つ
 * （一時保存・永続保存への移動・エラー時の一時ファイル削除）なので、
 * この4つだけを持つ最小構成にする。
 */
interface BlobEntry {
  content: Buffer;
  contentType?: string;
}

interface FakeBlobBackend {
  store: Map<string, BlobEntry>;
  forcedUploadError: Error | null;
}

function notFoundError(): any {
  const err: any = new Error('BlobNotFound');
  err.statusCode = 404;
  return err;
}

function createFakeBlockBlobClient(backend: FakeBlobBackend, containerName: string, blobName: string): BlockBlobClient {
  const key = `${containerName}/${blobName}`;
  const url = `https://test.blob.core.windows.net/${key}`;

  return {
    url,
    upload: async (content: Buffer, _length: number, options?: any) => {
      if (backend.forcedUploadError) {
        throw backend.forcedUploadError;
      }
      backend.store.set(key, {
        content,
        contentType: options?.blobHTTPHeaders?.blobContentType
      });
      return {};
    },
    download: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundError();
      const stream = new Readable({
        read() {
          this.push(entry.content);
          this.push(null);
        }
      });
      return { readableStreamBody: stream };
    },
    getProperties: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundError();
      return { contentType: entry.contentType };
    },
    delete: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundError();
      backend.store.delete(key);
      return {};
    }
  } as unknown as BlockBlobClient;
}

function createFakeBlobServiceClient(backend: FakeBlobBackend): BlobServiceClient {
  return {
    getContainerClient: (containerName: string) => ({
      getBlockBlobClient: (blobName: string) => createFakeBlockBlobClient(backend, containerName, blobName)
    })
  } as unknown as BlobServiceClient;
}

/** 返ってきたURL（SASクエリ付きの場合あり）から、偽物バックエンドのMapキーを導く */
function keyFromUrl(url: string): string {
  return url.replace('https://test.blob.core.windows.net/', '').split('?')[0];
}

describe('画像アップロード・植物判定統合API', () => {
  let mockContext: InvocationContext;
  let blobStore: Map<string, BlobEntry>;
  let backend: FakeBlobBackend;
  let mockOpenAI: any;

  beforeEach(() => {
    // InvocationContextのモック
    mockContext = {
      log: jest.fn()
    } as any;

    // Blobの偽物バックエンド
    blobStore = new Map();
    backend = { store: blobStore, forcedUploadError: null };
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(createFakeBlobServiceClient(backend));

    // SAS生成を成功させる（jest.fn() のままだとundefinedを返し、.toString() で例外になる）
    mockedGenerateSas.mockReturnValue({
      toString: () => TEST_SAS_TOKEN
    } as any);

    // OpenAI SDKのモック（管理外の依存。識別結果はスタブとして与える）
    mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  isPlant: true,
                  confidence: 95.5,
                  reason: '画像に桜の花が写っており、植物と判定しました',
                  plantAnalysis: {
                    candidates: [
                      {
                        name: '桜',
                        scientificName: 'Prunus serrulata',
                        familyName: 'バラ科',
                        description: '日本を代表する花木',
                        characteristics: '春に美しいピンクの花を咲かせる',
                        confidence: 95.5
                      }
                    ]
                  }
                })
              }
            }]
          })
        }
      }
    };

    const MockedOpenAI = jest.requireMock('openai');
    MockedOpenAI.mockImplementation(() => mockOpenAI);

    // 環境変数設定
    process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=key;EndpointSuffix=core.windows.net';
    process.env.STORAGE_CONTAINER_NAME = 'images';
    process.env.TEMP_STORAGE_CONTAINER_NAME = 'temp';
    process.env.OPENAI_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.STORAGE_CONTAINER_NAME;
    delete process.env.TEMP_STORAGE_CONTAINER_NAME;
    delete process.env.OPENAI_API_KEY;
  });

  describe('正常系', () => {
    it('画像を正常にアップロードできる', async () => {
      // 統合処理は beforeEach でモック済み

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return null;
          return null;
        })
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証（レスポンス。imagePathはStorageServiceが実際に生成するUUIDを含むため、
      // 形式のみ検証する。それ以外のフィールドはリテラルで直接比較する）
      expect(response.status).toBe(201);
      expect(response.jsonBody.data.imagePath).toMatch(
        /^https:\/\/test\.blob\.core\.windows\.net\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/
      );
      expect(response.jsonBody).toEqual({
        success: true,
        data: {
          imagePath: expect.any(String),
          fileName: 'test.jpg',
          contentType: 'image/jpeg',
          fileSize: 1024,
          identificationResult: {
            isPlant: true,
            confidence: 95.5,
            candidates: [
              {
                name: '桜',
                scientificName: 'Prunus serrulata',
                familyName: 'バラ科',
                description: '日本を代表する花木',
                characteristics: '春に美しいピンクの花を咲かせる',
                confidence: 95.5
              }
            ]
          }
        }
      });

      // 検証（管理外の依存。LLM呼び出し回数はコストに直結する観察可能な振る舞い）
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);

      // 検証（状態。一時ファイルは永続コンテナへ移動され、一時コンテナには残っていない）
      const permanentKey = keyFromUrl(response.jsonBody.data.imagePath);
      const tempKey = permanentKey.replace(/^images\//, 'temp/');
      expect(blobStore.has(tempKey)).toBe(false);
      expect(blobStore.get(permanentKey)).toEqual({
        content: Buffer.from(new ArrayBuffer(1024)),
        contentType: 'image/jpeg'
      });
    });

    it('PNG画像も正常にアップロードできる', async () => {
      // 統合処理は beforeEach でモック済み

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.png',
        type: 'image/png',
        size: 2048,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(2048))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return null;
          return null;
        })
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);

      // 検証（状態。PNGの拡張子・Content-Typeで永続コンテナに保存され、
      // 一時コンテナには残っていない）
      const permanentKey = keyFromUrl(response.jsonBody.data.imagePath);
      expect(permanentKey).toMatch(/\.png$/);
      expect(blobStore.get(permanentKey)?.contentType).toBe('image/png');
      expect(blobStore.has(permanentKey.replace(/^images\//, 'temp/'))).toBe(false);
    });

    it('コンテキスト情報ありで画像を正常にアップロードできる', async () => {
      // 統合処理は beforeEach でモック済み

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'mountain-flower.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const contextInfo = '白馬岳の標高2500m、高山帯の岩場';
      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return contextInfo;
          return null;
        })
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(201);

      // 検証（管理外の依存。LLM呼び出し回数はコストに直結する観察可能な振る舞い）
      expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);

      // 検証（状態。永続コンテナへ移動済みで一時コンテナには残っていない）
      const permanentKey = keyFromUrl(response.jsonBody.data.imagePath);
      expect(blobStore.has(permanentKey)).toBe(true);
      expect(blobStore.has(permanentKey.replace(/^images\//, 'temp/'))).toBe(false);

      // OpenAI呼び出しでコンテキスト情報が渡されているか確認
      // （管理外の依存への送信内容は出力が不透明ではないが、プロンプトへの
      // 混入を確認する手段がこの呼び出し引数の検査以外にないため見る）。
      // 固定ラベル「撮影時の環境やコンテキスト情報: 」はプロンプトの文言そのもので、
      // それは openAIVisionService.test.ts の責務。ここで見るのは
      // 利用者が入力した値がプロンプトに届いていることだけなので、
      // 値の部分だけを検証する
      const openAICall = mockOpenAI.chat.completions.create.mock.calls[0][0];
      const promptText = openAICall.messages[0].content[0].text;
      expect(promptText).toContain('白馬岳の標高2500m、高山帯の岩場');
    });

    it('contextInfoが500文字の場合は正常に処理される', async () => {
      // 統合処理は beforeEach でモック済み

      // ファイルオブジェクトのモック（正当なファイル）
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return 'あ'.repeat(500);
          return null;
        })
      };

      // リクエストの作成（contextInfoが500文字、ファイルは正当な値）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証（この境界が言いたいのは「500文字は拒否されず受理される」ことだけ。
      // レスポンスの内容自体は正常系のテストが既に検証しているので、
      // ここでは拒否されていないことをステータスとsuccessで確認する）
      expect(response.status).toBe(201);
      expect(response.jsonBody.success).toBe(true);
    });
  });

  describe('バリデーションエラー', () => {
    it('Content-Typeがmultipart/form-dataでない場合は400エラー', async () => {
      // リクエストの作成（無効なContent-Type）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'application/json']]),
        formData: jest.fn()
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Content-Typeがmultipart/form-dataではありません',
          details: 'multipart/form-dataでファイルを送信してください'
        }
      });
      // 検証（状態。バリデーションで止まり、どのBlobにも書き込まれていない）
      expect(blobStore.size).toBe(0);
    });

    it('ファイルが指定されていない場合は400エラー', async () => {
      // ファイルなしのモック
      const mockFormData = {
        get: jest.fn().mockReturnValue(null)
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像ファイルが指定されていません',
          details: 'imageフィールドでファイルを送信してください'
        }
      });
      // 検証（状態。バリデーションで止まり、どのBlobにも書き込まれていない）
      expect(blobStore.size).toBe(0);
    });

    it('imageフィールドがファイルでない場合は400エラー', async () => {
      // テキストフィールドとして image を送ると type が存在しないため、
      // 検証の前に型エラーで落ちて500になっていた
      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return 'not-a-file';
          return null;
        })
      };

      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      const response = await uploadImageHandler(request, mockContext);

      expect(response.status).toBe(400);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('INVALID_REQUEST');
    });

    it('サポートされていないファイル形式の場合は415エラー', async () => {
      // ファイルオブジェクトのモック（無効なコンテンツタイプ）
      const mockFile = {
        name: 'test.txt',
        type: 'text/plain',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return null;
          return null;
        })
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(415);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(response.jsonBody.error.message).toBe('サポートされていない画像形式です');
      // 検証（状態。バリデーションで止まり、どのBlobにも書き込まれていない）
      expect(blobStore.size).toBe(0);
    });

    it('ファイルサイズが上限を超える場合は413エラー', async () => {
      // 大きなファイルオブジェクトのモック（11MB）
      const mockFile = {
        name: 'large.jpg',
        type: 'image/jpeg',
        size: 11 * 1024 * 1024, // 11MB
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(11 * 1024 * 1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return null;
          return null;
        })
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(413);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('FILE_TOO_LARGE');
      expect(response.jsonBody.error.message).toBe('ファイルサイズが大きすぎます');
      // 検証（状態。バリデーションで止まり、どのBlobにも書き込まれていない）
      expect(blobStore.size).toBe(0);
    });

    it('contextInfoが501文字の場合は400エラー', async () => {
      // 統合処理は beforeEach でモック済み（バリデーションで止まるはずだが、
      // 意図せず到達しても別の原因で落ちないようにしておく）

      // ファイルオブジェクトのモック（正当なファイル）
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return 'あ'.repeat(501);
          return null;
        })
      };

      // リクエストの作成（contextInfoが501文字、ファイルは正当な値）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '補足情報は500文字以内で指定してください'
        }
      });
    });

    it('contextInfoにファイルを指定した場合は400エラー', async () => {
      // 統合処理は beforeEach でモック済み（バリデーションで止まるはずだが、
      // 意図せず到達しても別の原因で落ちないようにしておく）

      // ファイルオブジェクトのモック（正当なファイル）
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      // contextInfoに指定するファイル風オブジェクト（Fileを模す）。
      //
      // formData.get()は任意のフィールド名にFileを返しうる。現在の実装は
      // `formData.get('contextInfo') as string | null` というキャストに
      // 実行時の保証はなく、型を見ずに.lengthを比較している。Fileには
      // .lengthが存在しないため、contextInfo.lengthはundefinedになり、
      // `undefined > 500`がfalseとなって長さ検証を素通りしてしまう。
      const mockContextInfoFile = {
        name: 'note.txt',
        type: 'text/plain',
        size: 10,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return mockContextInfoFile;
          return null;
        })
      };

      // リクエストの作成（contextInfoにファイル、imageは正当な値）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '補足情報は文字列で指定してください'
        }
      });
    });

    it('フォームデータパースエラーの場合は400エラー', async () => {
      // リクエストの作成（フォームデータパースエラー）
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockRejectedValue(new TypeError('Failed to parse formData'))
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'ファイルの読み取りに失敗しました',
          details: '有効なmultipart/form-dataを送信してください'
        }
      });
    });
  });

  describe('植物でない画像の判定', () => {
    // この describe 内の全テストで共通：AIが「植物ではない」と判定する応答に差し替える。
    // validateImage()はURL形式のみを見てOpenAIを呼ばないため、このモックの影響を受けない
    beforeEach(() => {
      mockOpenAI.chat.completions.create.mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              isPlant: false,
              confidence: 8.2,
              reason: '画像に写っているのは猫で、植物ではないと判定しました',
              plantAnalysis: null
            })
          }
        }]
      });
    });

    function buildNotPlantRequest(): HttpRequest {
      const mockFile = {
        name: 'cat.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return null;
          return null;
        })
      };

      return {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;
    }

    it('植物でない画像をアップロードするとNOT_A_PLANTエラーが返る', async () => {
      // 実行
      const response = await uploadImageHandler(buildNotPlantRequest(), mockContext);

      // 検証（レスポンス全文）
      expect(response.status).toBe(400);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'NOT_A_PLANT',
          message: 'アップロードされた画像は植物ではありません',
          details: '植物の画像を選択して再度お試しください'
        }
      });
    });

    it('植物でない画像をアップロードすると一時ファイルが削除される', async () => {
      // 実行
      await uploadImageHandler(buildNotPlantRequest(), mockContext);

      // 検証（状態。このテストで一時コンテナに書き込まれるのはアップロードした1件のみなので、
      // サイズ0は「一時ファイルが削除され、かつ永続コンテナにも何も移動していない」ことを示す）
      expect(blobStore.size).toBe(0);
    });
  });

  describe('Azure Storage エラー', () => {
    it('Storageエラーの場合は502エラー', async () => {
      // Azure Storage エラーのモック（一時保存のアップロードで発生させる）
      const storageError = new Error('Storage service error');
      backend.forcedUploadError = storageError;

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return null;
          return null;
        })
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(502);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスでエラーが発生しました',
          details: '一時画像のアップロードに失敗しました: Storage service error'
        }
      });
      // 検証（状態。アップロード自体が失敗しているため、どのBlobにも残らない）
      expect(blobStore.size).toBe(0);
    });

    it('一時保存が未分類のエラーで失敗した場合は500エラー', async () => {
      // 未分類のエラーのモック（一時保存のアップロードで発生させる）。
      // code は設定しない。StorageService.uploadImageToTemp は catch で
      // `throw new Error(...)` と包み直すため、元の error.code は失われる。
      // そのため upload.ts の ECONNREFUSED || ETIMEDOUT 分岐（503）には
      // 到達せず、実際に通るのは最終フォールバック（500）
      const networkError = new Error('Connection timeout');
      backend.forcedUploadError = networkError;

      // ファイルオブジェクトのモック
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
          if (key === 'contextInfo') return null;
          return null;
        })
      };

      // リクエストの作成
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証
      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '画像アップロード・植物判定に失敗しました',
          details: '一時画像のアップロードに失敗しました: Connection timeout'
        }
      });
      // 検証（状態。アップロード自体が失敗しているため、どのBlobにも残らない）
      expect(blobStore.size).toBe(0);
    });
  });
});
