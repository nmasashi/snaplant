import { format } from 'node:util';
import { HttpRequest, InvocationContext } from '@azure/functions';
import { uploadImageHandler } from '../../src/functions/upload';
import { BlobServiceClient, generateBlobSASQueryParameters } from '@azure/storage-blob';
import {
  BlobEntry,
  FakeBlobBackend,
  createFakeBlobServiceClient,
  keyFromUrl
} from '../fakes/blob';

// 外部依存のみモック
// tests/setup.ts のファクトリモックは getBlockBlobClient() に download / getProperties / delete が
// 無く、それに頼ると一時保存→永続保存の移動処理がTypeErrorになって本番コードのcatchに
// 飲み込まれてしまう（console.logも抑制されるため気づけない）。一時保存・永続保存・削除が
// 実際に成功する経路をすべて通せるよう、このファイル内で偽物のBlobバックエンドに差し替える
// （偽物の実体は tests/fakes/blob.ts）
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));
jest.mock('openai');

const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;
const mockedGenerateSas = generateBlobSASQueryParameters as jest.MockedFunction<typeof generateBlobSASQueryParameters>;

// SASトークンの固定値（一時保存がSAS付きURLを返すことの土台）。
// 権限は photos.test.ts（実SDKで署名）、一時URLの有効期限は storageService.test.ts が見ている。
// 署名（sig）だけは「SASの署名をログに出さない」テストが漏れの有無を見る秘密として使うため、
// 定数に切り出してトークンをそこから組み立てる（片方だけ書き換えても検証が空振りしない）
const TEST_SAS_SIGNATURE = 'testsignature';
const TEST_SAS_TOKEN = `sv=2024-01-01&se=2030-01-01T00%3A00%3A00Z&sp=r&sig=${TEST_SAS_SIGNATURE}`;

/** 1KB の JPEG 画像だけを送る、入力として正当なアップロードのリクエスト */
const jpegUploadRequest = (): HttpRequest => {
  const mockFile = {
    name: 'test.jpg',
    type: 'image/jpeg',
    size: 1024,
    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
  } as any;
  const mockFormData = { get: jest.fn().mockImplementation((key: string) => (key === 'image' ? mockFile : null)) };
  return {
    method: 'POST',
    url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
    query: new Map([['code', 'test-key']]),
    headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
    formData: jest.fn().mockResolvedValue(mockFormData)
  } as any as HttpRequest;
};


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

    it('Content-Typeが大文字（IMAGE/PNG）でもアップロードでき、Blob名に.pngが付く', async () => {
      // 形式の判定と拡張子の引き当ての両方が、大文字小文字を区別しないことを見る
      const mockFile = {
        name: 'test.png',
        type: 'IMAGE/PNG',
        size: 2048,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(2048))
      } as any;
      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => (key === 'image' ? mockFile : null))
      };
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      const response = await uploadImageHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect(response.jsonBody.data.imagePath).toMatch(/\.png$/);
    });

    it('ファイルサイズが上限ちょうど（10MB）の場合は正常にアップロードできる', async () => {
      // 上限を1バイト超えると413になる（バリデーションエラーの節）。その境界の内側を見る
      const mockFile = {
        name: 'limit.jpg',
        type: 'image/jpeg',
        size: 10 * 1024 * 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10 * 1024 * 1024))
      } as any;
      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => (key === 'image' ? mockFile : null))
      };
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      const response = await uploadImageHandler(request, mockContext);

      expect(response.status).toBe(201);
      expect(response.jsonBody.data.fileSize).toBe(10485760);
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
      // それはテストで固定しない（プロンプトの文言は実装の詳細）。ここで見るのは
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

    it('一時保存したURLの署名（SAS）をログに出さない', async () => {
      // 読み取りSAS付きURLがログ（Application Insights）に残ると、ログを読める人が
      // そのまま画像を取得できる。ログの文言や形式は契約ではないので固定せず、
      // 秘密（SASの署名）がどのログ引数にも現れないことだけを見る。
      // 実物のInvocationContextにlogHandlerを渡し、context.log / info / warn / error など
      // どのレベルで出されても拾う。@azure/functions v4 はログ引数を util.format で文字列化するので
      // 同じ形で集める（JSON.stringify ではErrorのmessageが落ちて漏れを見逃す）
      const logged: string[] = [];
      const context = new InvocationContext({
        logHandler: (_level, ...args) => {
          logged.push(format(...args));
        }
      });
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;
      const mockFormData = { get: jest.fn().mockImplementation((key: string) => (key === 'image' ? mockFile : null)) };
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, context);

      // 検証（保存まで進む経路を通っていること）
      expect(response.status).toBe(201);
      // 検証（全レベルのログをランタイムと同じ util.format で文字列化し、SASの署名が含まれない）。
      // 秘密なのは署名（TEST_SAS_SIGNATURE）で、有効期限や権限の項目は漏れても
      // 画像を取得できない。
      // これは原則4「ログ出力の内容を検証しない」の例外。ログは Application Insights を通じて
      // 開発者以外も読む出力で、「秘密を出さない」はセキュリティ要件のため。文言や形式は固定せず、
      // 秘密が現れないことだけを見るので、ログの書き換え（文言の変更・追加・削除）では落ちない。
      // 範囲の狭い例外なので原則には書かず、ここに理由を残す（人間の判断）
      expect(logged.join('\n')).not.toContain(TEST_SAS_SIGNATURE);
    });

    it('AI識別サービスへ渡す画像のURLは、一時コンテナに保存した画像のSAS付きURL', async () => {
      // 06_api_design.md §5.9「画像」。一時コンテナは非公開なので、SAS が無いと AI 識別サービスは画像を読めない。
      // 管理外の依存へ送るもの（外部との契約）なので、送った引数で確かめる
      const response = await uploadImageHandler(jpegUploadRequest(), mockContext);

      expect(response.status).toBe(201);
      const openAICall = mockOpenAI.chat.completions.create.mock.calls[0][0];
      const imagePart = openAICall.messages[0].content.find((part: any) => part.type === 'image_url');
      // 一時コンテナの Blob 名は永続コンテナへ移した後の Blob 名と同じ
      const blobName = keyFromUrl(response.jsonBody.data.imagePath).replace(/^images\//, '');
      expect(imagePart.image_url.url).toBe(`https://test.blob.core.windows.net/temp/${blobName}?${TEST_SAS_TOKEN}`);
    });

    it('2回アップロードすると、それぞれ別の永続URLに保存される', async () => {
      // Blob 名が毎回同じだと、別の利用者のアップロードを上書きする
      const first = await uploadImageHandler(jpegUploadRequest(), mockContext);
      const second = await uploadImageHandler(jpegUploadRequest(), mockContext);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.jsonBody.data.imagePath).not.toBe(second.jsonBody.data.imagePath);
      expect([...blobStore.keys()].filter((key) => key.startsWith('images/'))).toHaveLength(2);
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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Content-Typeがmultipart/form-dataではありません'
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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: '画像ファイルが指定されていません'
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
      // 上限（10MB）を1バイト超えるファイルオブジェクトのモック
      const mockFile = {
        name: 'large.jpg',
        type: 'image/jpeg',
        size: 10 * 1024 * 1024 + 1,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10 * 1024 * 1024 + 1))
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

    it('0バイトのファイルは「画像ファイルが空です」という400エラーになり、何も保存されず識別も行われない', async () => {
      // 形式は正当だが中身が空のファイル
      const mockFile = {
        name: 'empty.jpg',
        type: 'image/jpeg',
        size: 0,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
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

      // details は契約外のため固定しない
      expect(response.status).toBe(400);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('INVALID_REQUEST');
      expect(response.jsonBody.error.message).toBe('画像ファイルが空です');
      // 状態（一時コンテナにも永続コンテナにも書き込まれていない）
      expect(blobStore.size).toBe(0);
      // OpenAI は管理外の依存。課金に直結する呼び出しが起きていない
      expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled();
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

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'ファイルの読み取りに失敗しました'
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

    it('植物でない画像をアップロードするとNOT_A_PLANTエラーが返り、一時ファイルは残らない', async () => {
      // 実行
      const response = await uploadImageHandler(buildNotPlantRequest(), mockContext);

      // 検証（detailsは契約外なので固定しない）
      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'NOT_A_PLANT',
          message: 'アップロードされた画像は植物ではありません'
        }
      });
      // 検証（状態。このテストで一時コンテナに書き込まれるのはアップロードした1件のみなので、
      // サイズ0は「一時ファイルが削除され、かつ永続コンテナにも何も移動していない」ことを示す）
      expect(blobStore.size).toBe(0);
    });

    it('植物でない画像の一時ファイルの削除に失敗した場合は、NOT_A_PLANTではなく502エラー', async () => {
      // 06_api_design.md §5.8。一時ファイルの Blob 名はリクエストの中で決まるので、
      // 一時コンテナへ書かれた時点で削除が失敗する状態にする
      backend.failWithByPrefix = {
        'temp/': Object.assign(new Error('This request is not authorized to perform this operation.'), {
          name: 'RestError',
          statusCode: 403,
          code: 'AuthorizationFailure'
        })
      };

      const response = await uploadImageHandler(buildNotPlantRequest(), mockContext);

      // details は契約外なので固定しない
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスでエラーが発生しました'
        }
      });
    });
  });

  describe('Azure Storage エラー', () => {
    it('一時保存がストレージ側のエラー応答で失敗した場合は502エラー', async () => {
      // Azure Storage SDK（@azure/storage-blob）が接続できたうえで返す失敗の形を再現する。
      // 実 SDK は RestError（name: 'RestError'、HTTP ステータスと Storage のエラーコード付き）を投げ、
      // message は英語の文で、文字列 "Storage" を含むとは限らない。
      // 実装の判定条件に合わせた文字列（"Storage" を含む message）を作ると、
      // 実 SDK が作らない形でしか分岐を通らないテストになるため、あえて含めない。
      // ネットワーク系の code（ENOTFOUND など）も持たないので、接続はできている失敗を表す
      const storageError = Object.assign(
        new Error('This request is not authorized to perform this operation.'),
        { name: 'RestError', statusCode: 403, code: 'AuthorizationFailure' }
      );
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
      // details は契約外なので文言を固定しない
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスでエラーが発生しました'
        }
      });
    });

    // ストレージが接続できないとみなす errno は utils/response.ts の UPSTREAM_ERROR_RESPONSES.storage にあり、
    // utils/errors.ts の UNREACHABLE_ERRNOS（ENOTFOUND / ECONNREFUSED。AI と Cosmos DB も共有）に ETIMEDOUT を足したもの。
    // ストレージだけが ETIMEDOUT を含むので、3つ全部を通すのはここだけ。
    // 全 errno を通す入口は、ストレージがここ、Cosmos DB が trips.test.ts の「旅行の作成」、
    // AI がこのファイルの「AI サービスのエラー」
    it.each(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'])(
      '一時保存が%sで失敗した場合は503エラー', async (errorCode) => {
      // 一時保存のアップロードが接続障害で落ちた場合。
      // StorageService は失敗を UpstreamError（service: 'storage'）で包み、元の RestError を
      // cause に持つ。Azure の transport は errno を RestError の code に直接載せるので
      // （`code: err.code ?? ...`）、hasCauseCode が見つけて 502 ではなく 503 になる。
      // 到達できていないとサービスへの接続障害が 502 に紛れ、
      // クライアントが再試行の判断をできない（これが元の不具合）
      const networkError: any = Object.assign(new Error(`接続に失敗しました (${errorCode})`), {
        name: 'RestError',
        code: errorCode
      });
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
      // details は契約外なので固定しない
      expect(response.status).toBe(503);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスに接続できません'
        }
      });
    });

    it('一時URLの署名（SAS）の生成に失敗した場合は502エラーで、一時コンテナに何も残らない', async () => {
      // 06_api_design.md §5.8・§6.2。SAS の生成は一時保存（Blob Storage の操作）に含まれる。
      // アップロードは SAS の生成より先に終わっているので、後片付けしないと孤児 Blob が残る
      mockedGenerateSas.mockImplementation(() => {
        throw new Error('credential unavailable');
      });

      const response = await uploadImageHandler(jpegUploadRequest(), mockContext);

      // details は契約外なので固定しない
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスでエラーが発生しました'
        }
      });
      expect(blobStore.size).toBe(0);
    });

    it('永続保存への移動で、一時ファイルの読み出しが途中で失敗した場合は502エラー', async () => {
      // ダウンロードの応答は返るが、ストリームの読み出し中に失敗する経路。
      // 一時ファイルの Blob 名はリクエストの中で決まるので、一時コンテナへ書かれた時点で
      // 読み出しが失敗する状態にする。ストリームの失敗を拾えないと、例外ではなく
      // 応答が返らなくなる（このテストはタイムアウトで失敗する）
      backend.streamErrorWithByPrefix = { 'temp/': new Error('stream read error') };

      const response = await uploadImageHandler(jpegUploadRequest(), mockContext);

      // details は契約外なので固定しない
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスでエラーが発生しました'
        }
      });
      expect([...blobStore.keys()].filter((key) => key.startsWith('images/'))).toEqual([]);
    });

    it('永続保存への移動がストレージ側のエラー応答で失敗した場合は502エラーで、永続コンテナには何も残らない', async () => {
      // 一時保存は成功し、永続コンテナ（images）への書き込みだけが RestError で失敗する。
      // 一時保存の失敗とは別の場所（moveFromTempToPermanent）だが、同じ
      // ストレージの障害として分類される
      backend.forcedUploadErrorByContainer = {
        images: Object.assign(
          new Error('This request is not authorized to perform this operation.'),
          { name: 'RestError', statusCode: 403, code: 'AuthorizationFailure' }
        )
      };

      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;
      const mockFormData = { get: jest.fn().mockImplementation((key: string) => (key === 'image' ? mockFile : null)) };
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証（details は契約外なので固定しない）
      expect(response.status).toBe(502);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'STORAGE_ERROR',
          message: 'ストレージサービスでエラーが発生しました'
        }
      });
      expect([...blobStore.keys()].filter(key => key.startsWith('images/'))).toEqual([]);
    });
  });

  describe('ストレージの設定が未対応の形', () => {
    it('接続文字列にBlobEndpointがある場合は、何も保存せず500エラー', async () => {
      // DEPLOYMENT.md「STORAGE_CONNECTION_STRING の制約」。BlobEndpoint を明示した接続文字列は未対応で、
      // identify 以外のエンドポイントは 500 INTERNAL_ERROR になる。SDK はそのエンドポイントを使う一方、
      // URL の検証は AccountName と EndpointSuffix からホストを組み立てるので、黙って通すと
      // 自分が生成した URL を自分で拒否する。details は契約外なので固定しない
      process.env.STORAGE_CONNECTION_STRING =
        'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=testkey==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

      const response = await uploadImageHandler(jpegUploadRequest(), mockContext);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '画像アップロード・植物判定に失敗しました'
        }
      });
      expect(blobStore.size).toBe(0);
      expect(mockOpenAI.chat.completions.create).not.toHaveBeenCalled();
    });
  });

  describe('ストレージにもAIにも届かない失敗', () => {
    it('受け取ったファイルの読み出しに失敗した場合は500エラーで、Blobには何も書かれない', async () => {
      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockRejectedValue(new Error('stream failure'))
      } as any;
      const mockFormData = { get: jest.fn().mockImplementation((key: string) => (key === 'image' ? mockFile : null)) };
      const request = {
        method: 'POST',
        url: 'https://func-snaplant.azurewebsites.net/api/images/upload?code=test-key',
        query: new Map([['code', 'test-key']]),
        headers: new Map([['content-type', 'multipart/form-data; boundary=---test']]),
        formData: jest.fn().mockResolvedValue(mockFormData)
      } as any as HttpRequest;

      // 実行
      const response = await uploadImageHandler(request, mockContext);

      // 検証（details は契約外なので固定しない）
      expect(response.status).toBe(500);
      expect(response.jsonBody).toMatchObject({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '画像アップロード・植物判定に失敗しました'
        }
      });
      expect(blobStore.size).toBe(0);
    });
  });

  describe('AI サービスのエラー', () => {
    it('AIの呼び出しがSDKのエラー応答で失敗した場合は502エラー', async () => {
      // 実際の SDK（openai の APIError）に近い形のエラーを注入する。
      // 実 SDK の message は "500 The server had an error while processing your request." の
      // ように先頭にステータスが付くだけで、"OpenAI" も "LLM" も含まない。
      // 実装の文字列判定に合わせて "OpenAI" を含むメッセージにすると、
      // 実 SDK が作らない形でしか分岐を通らないテストになるため、含めない。
      // 識別が失敗した時点で一時保存は成功済みである（失敗した場所は AI の呼び出し）
      const sdkError = Object.assign(
        new Error('500 The server had an error while processing your request.'),
        { name: 'InternalServerError', status: 500 }
      );
      mockOpenAI.chat.completions.create.mockRejectedValue(sdkError);

      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
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

      // details は契約外のため固定しない
      expect(response.status).toBe(502);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('AI_SERVICE_ERROR');
      expect(response.jsonBody.error.message).toBe('植物識別サービスでエラーが発生しました');
    });

    it.each(['ENOTFOUND', 'ECONNREFUSED'])('AI識別サービスに接続できない（%s）場合はストレージではなくAIの障害として503エラーを返す', async (errno) => {
      // AI の経路は接続できない errno の一覧を別に持つ（utils/response.ts の UPSTREAM_ERROR_RESPONSES.ai）ので、
      // Cosmos DB 側の全件の表（trips.test.ts）では AI の一覧の崩れを捕まえられない。AI の全 errno を通すのはここ
      // （アプリが使う入口）で、identify.test.ts は1つだけ
      // 実SDK（openai 7.x / Node標準のfetch）の接続エラーは3段のcauseチェーンになる。
      //   APIConnectionError（code無し）→ TypeError 'fetch failed'（code無し）→ Error（code=errno）
      // errnoを持つのは最深部だけで、トップレベルにcodeは付かない。
      // トップレベルにcodeを付けると実SDKが作らない形になるので付けない
      const sysError = Object.assign(new Error(`connect ${errno} example.openai.azure.com`), {
        code: errno
      });
      const fetchError = Object.assign(new TypeError('fetch failed'), { cause: sysError });
      const connectionError = Object.assign(new Error('Connection error.'), {
        name: 'APIConnectionError',
        cause: fetchError
      });
      mockOpenAI.chat.completions.create.mockRejectedValue(connectionError);

      const mockFile = {
        name: 'test.jpg',
        type: 'image/jpeg',
        size: 1024,
        arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(1024))
      } as any;

      const mockFormData = {
        get: jest.fn().mockImplementation((key: string) => {
          if (key === 'image') return mockFile;
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

      // details は契約外のため固定しない
      expect(response.status).toBe(503);
      expect(response.jsonBody.success).toBe(false);
      expect(response.jsonBody.error.code).toBe('AI_SERVICE_ERROR');
      expect(response.jsonBody.error.message).toBe('植物識別サービスに接続できません');
    });
  });
});
