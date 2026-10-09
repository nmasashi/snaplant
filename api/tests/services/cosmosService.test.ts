import { CosmosService } from '../../src/services/cosmosService';
import { Plant, PlantSummary, PlantCreateRequest, PlantUpdateRequest } from '../../src/types/plant';
import { CosmosClient, Container } from '@azure/cosmos';
import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';

// 外部依存のみモック。
// StorageServiceはCosmosServiceと同じプロセスで動く自前のクラスなのでモックしない
// （CosmosServiceが内部でnewするため、実物のStorageServiceを使い、その先の
// Blob SDKだけを偽物に差し替える。storageService.test.tsと同じ構成）
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: { fromConnectionString: jest.fn() },
  BlobSASPermissions: jest.fn().mockImplementation(() => ({})),
  StorageSharedKeyCredential: jest.fn().mockImplementation(() => ({})),
  generateBlobSASQueryParameters: jest.fn()
}));

const MockedCosmosClient = jest.mocked(CosmosClient);
const MockedBlobServiceClient = BlobServiceClient as jest.MockedClass<typeof BlobServiceClient>;

/**
 * 偽物のCosmos DBバックエンド。
 *
 * ドキュメントをIDをキーにしたMapで保持する。item(id, partitionKey)は
 * パーティションキーが/idのため、idとpartitionKeyが一致しない場合やidが
 * 存在しない場合にアイテムなしの状態になる。
 *
 * ただし read() と replace()/delete() ではその「アイテムなし」の表現方法が異なる。
 * 実際の @azure/cosmos は、read（単一アイテム取得）に限り NotFound エラーを
 * 内部で飲み込み、resource が undefined のレスポンスを返す
 * （node_modules/@azure/cosmos の Item.read 実装: catch 節で
 * error.code === StatusCodes.NotFound のときは再スローせず、
 * resource が無いレスポンスとして扱う）。一方 replace・delete は NotFound を
 * そのまま例外として投げる。この非対称性は読み取りに限った実 SDK の挙動なので、
 * 偽物もここに合わせる。read() が例外を投げる前提で書くと、本番で絶対に通らない
 * catch 分岐をテストすることになり、実際に通る `resource || null` の経路が
 * 無検証のまま緑になってしまう（過去にこの誤りがあった）。
 *
 * パーティションキーの取り違え（例: item(id, 'wrong')）の検出は、読み取りが
 * 例外を投げなくなっても失わない。id と partitionKey が一致しない場合は
 * resource を undefined にする（＝実SDKでも取り違えは単に見つからない扱いになる）ため、
 * 取り違えが起きれば呼び出し側は「見つからない」という結果を受け取り、
 * 正しいドキュメントを期待するテストが失敗する
 * （単一の共有モックだとどの引数で呼ばれても同じアイテムを返すため、
 * 取り違えが検出できない点は変わらず回避している）。
 *
 * items.query は実際のCosmos SQLを解釈せず、渡されたパラメータ（@name）の値で
 * 絞り込むだけに留める。クエリ文字列自体への依存はリファクタリング耐性を失う。
 *
 * この簡略化の結果、次の3点はこの層のテストでは検証できない（SQL自体を解釈する
 * 実エミュレータ、もしくはE2Eテストに委ねる）:
 * - WHERE句が実際に name で絞り込む条件になっているか（パラメータの値さえ
 *   渡っていれば、絞り込み条件を丸ごと削除してもこの偽物は気づかない）
 * - ORDER BY c.createdAt DESC による並び順（偽物はMapの挿入順をそのまま返す）
 * - SELECTの列指定（射影）が正しいか（偽物はドキュメント全体を返す）
 */
interface FakeCosmosBackend {
  // Cosmosは射影（SELECTの列指定）に応じてPlantの部分集合しか返さないことがある。
  // Plant固定だと「常に完全なPlantが返る」という誤った前提を型で固定してしまうため、
  // 射影結果として渡すPlantSummaryも受け入れられるようにしておく
  documents: Map<string, Plant | PlantSummary>;
  forcedCreateError: Error | null;
  forcedCreateNoResource: boolean;
  forcedReadError: Error | null;
  forcedReplaceError: Error | null;
  forcedDeleteError: Error | null;
  forcedQueryError: Error | null;
}

function notFoundError(): any {
  const err: any = new Error('NotFound');
  err.code = 404;
  return err;
}

function createFakeContainer(backend: FakeCosmosBackend): Container {
  return {
    items: {
      create: async (doc: Plant) => {
        if (backend.forcedCreateError) throw backend.forcedCreateError;
        if (backend.forcedCreateNoResource) return { resource: undefined };
        backend.documents.set(doc.id, doc);
        return { resource: doc };
      },
      query: (querySpec: any) => {
        const parameters = typeof querySpec === 'string' ? [] : (querySpec.parameters ?? []);
        const nameParam = parameters.find((p: any) => p.name === '@name')?.value;
        let docs = Array.from(backend.documents.values());
        if (nameParam !== undefined) {
          docs = docs.filter((d) => d.name === nameParam);
        }
        return {
          fetchAll: async () => {
            if (backend.forcedQueryError) throw backend.forcedQueryError;
            return { resources: docs };
          }
        };
      }
    },
    item: (id: string, partitionKey: string) => ({
      // read だけは実SDKに合わせてNotFoundを例外にしない（上のコメント参照）。
      // 見つからない場合・パーティションキー不一致の場合は resource が無い
      // レスポンスを返す
      read: async () => {
        if (backend.forcedReadError) throw backend.forcedReadError;
        if (id !== partitionKey || !backend.documents.has(id)) {
          return { resource: undefined };
        }
        return { resource: backend.documents.get(id) };
      },
      replace: async (doc: Plant) => {
        if (backend.forcedReplaceError) throw backend.forcedReplaceError;
        if (id !== partitionKey || !backend.documents.has(id)) throw notFoundError();
        backend.documents.set(id, doc);
        return { resource: doc };
      },
      delete: async () => {
        if (backend.forcedDeleteError) throw backend.forcedDeleteError;
        if (id !== partitionKey || !backend.documents.has(id)) throw notFoundError();
        backend.documents.delete(id);
        return { resource: { id } };
      }
    })
  } as unknown as Container;
}

/** 偽物のBlobバックエンド（storageService.test.tsと同型。旧画像削除の検証に使う） */
interface BlobEntry {
  content: Buffer;
  failWith?: Error;
}

interface FakeBlobBackend {
  store: Map<string, BlobEntry>;
}

function notFoundBlobError(): any {
  const err: any = new Error('BlobNotFound');
  err.statusCode = 404;
  return err;
}

function createFakeBlockBlobClient(backend: FakeBlobBackend, containerName: string, blobName: string): BlockBlobClient {
  const key = `${containerName}/${blobName}`;

  return {
    delete: async () => {
      const entry = backend.store.get(key);
      if (!entry) throw notFoundBlobError();
      if (entry.failWith) throw entry.failWith;
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

describe('CosmosService', () => {
  let service: CosmosService;
  let cosmosBackend: FakeCosmosBackend;
  let blobStore: Map<string, BlobEntry>;

  beforeEach(() => {
    cosmosBackend = {
      documents: new Map(),
      forcedCreateError: null,
      forcedCreateNoResource: false,
      forcedReadError: null,
      forcedReplaceError: null,
      forcedDeleteError: null,
      forcedQueryError: null
    };
    const fakeContainer = createFakeContainer(cosmosBackend);
    MockedCosmosClient.mockImplementation(() => ({
      database: () => ({
        container: () => fakeContainer
      })
    } as unknown as CosmosClient));

    blobStore = new Map();
    MockedBlobServiceClient.fromConnectionString = jest.fn().mockReturnValue(
      createFakeBlobServiceClient({ store: blobStore })
    );

    // 環境変数設定（Cosmos用 + StorageService実物を構築するためのBlob用）
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';
    process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=testkey==;EndpointSuffix=core.windows.net';
    process.env.STORAGE_CONTAINER_NAME = 'test-images';
    process.env.TEMP_STORAGE_CONTAINER_NAME = 'test-temp';

    service = new CosmosService();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_CONTAINER;
    delete process.env.STORAGE_CONNECTION_STRING;
    delete process.env.STORAGE_CONTAINER_NAME;
    delete process.env.TEMP_STORAGE_CONTAINER_NAME;
  });

  describe('createPlant', () => {
    const plantCreateRequest: PlantCreateRequest = {
      name: '桜',
      scientificName: 'Prunus serrulata',
      familyName: 'バラ科',
      description: '日本を代表する花木',
      characteristics: '春に美しい花を咲かせる',
      confidence: 95.5,
      imagePath: 'https://example.com/sakura.jpg'
    };

    it('入力内容とUUID v4形式のIDを持つ植物を作成して返す', async () => {
      const result = await service.createPlant(plantCreateRequest);

      const isoFormat = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(result).toEqual({
        ...plantCreateRequest,
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
        createdAt: expect.stringMatching(isoFormat),
        updatedAt: expect.stringMatching(isoFormat)
      });
    });

    it('作成した植物の内容がデータベースに保存される', async () => {
      const result = await service.createPlant(plantCreateRequest);

      expect(cosmosBackend.documents.get(result.id)).toEqual(result);
    });

    it('2回作成すると異なるIDが生成される', async () => {
      const result1 = await service.createPlant(plantCreateRequest);
      const result2 = await service.createPlant(plantCreateRequest);

      expect(result1.id).not.toBe(result2.id);
    });

    it('作成エラーの場合、エラーをスローする', async () => {
      cosmosBackend.forcedCreateError = new Error('Create failed');

      await expect(service.createPlant(plantCreateRequest))
        .rejects.toThrow(/^Create failed$/);
    });

    it('データベースが作成結果を返さない場合、エラーをスローする', async () => {
      cosmosBackend.forcedCreateNoResource = true;

      await expect(service.createPlant(plantCreateRequest))
        .rejects.toThrow(/^Failed to create plant$/);
    });
  });

  describe('getPlantById', () => {
    const plantId = '123e4567-e89b-12d3-a456-426614174000';
    const mockPlant: Plant = {
      id: plantId,
      name: '桜',
      scientificName: 'Prunus serrulata',
      familyName: 'バラ科',
      characteristics: '春に美しい花を咲かせる',
      confidence: 95.5,
      imagePath: 'https://example.com/sakura.jpg',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    };

    it('IDで植物を正常に取得できる', async () => {
      cosmosBackend.documents.set(plantId, mockPlant);

      const result = await service.getPlantById(plantId);

      expect(result).toEqual(mockPlant);
    });

    it('存在しない植物の場合、nullを返す', async () => {
      const result = await service.getPlantById(plantId);

      expect(result).toBeNull();
    });

    it('取得エラーの場合、エラーをスローする', async () => {
      cosmosBackend.forcedReadError = new Error('Read failed');

      await expect(service.getPlantById(plantId))
        .rejects.toThrow(/^Read failed$/);
    });
  });

  describe('updatePlant', () => {
    const plantId = '123e4567-e89b-12d3-a456-426614174000';
    const existingPlant: Plant = {
      id: plantId,
      name: '桜',
      scientificName: 'Prunus serrulata',
      familyName: 'バラ科',
      characteristics: '春に美しい花を咲かせる',
      confidence: 95.5,
      imagePath: 'https://test.blob.core.windows.net/test-images/old-sakura.jpg',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    };

    it('画像パスが変わらない場合、植物を更新しても古い画像は削除されない', async () => {
      cosmosBackend.documents.set(plantId, existingPlant);
      blobStore.set('test-images/old-sakura.jpg', { content: Buffer.from('old') });
      const updateData: PlantUpdateRequest = {
        imagePath: existingPlant.imagePath,
        confidence: 98.0
      };

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toEqual({
        ...existingPlant,
        ...updateData,
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
      // updatedAtが更新されたことを確認する（旧値のまま据え置かれていないか）
      expect(result!.updatedAt).not.toBe(existingPlant.updatedAt);
      expect(blobStore.has('test-images/old-sakura.jpg')).toBe(true);
    });

    it('画像パスが変わる場合、植物を更新して古い画像を削除する', async () => {
      cosmosBackend.documents.set(plantId, existingPlant);
      blobStore.set('test-images/old-sakura.jpg', { content: Buffer.from('old') });
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/new-sakura.jpg',
        confidence: 97.0
      };

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toEqual({
        ...existingPlant,
        ...updateData,
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
      expect(result!.updatedAt).not.toBe(existingPlant.updatedAt);
      expect(blobStore.has('test-images/old-sakura.jpg')).toBe(false);
    });

    it('存在しない植物の場合、nullを返す', async () => {
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/test.jpg',
        confidence: 95.0
      };

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toBeNull();
    });

    it('更新エラーの場合、エラーをスローする', async () => {
      cosmosBackend.documents.set(plantId, existingPlant);
      cosmosBackend.forcedReplaceError = new Error('Replace failed');
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/test.jpg',
        confidence: 95.0
      };

      await expect(service.updatePlant(plantId, updateData))
        .rejects.toThrow(/^Replace failed$/);
    });

    it('外部ホストだが別レコードの画像と同じファイル名のimagePathで更新しても、その別レコードのBlobは削除されない', async () => {
      // 攻撃経路: deleteImage()がホストを見ずコンテナ名とファイル名だけで削除先を
      // 決めると、外部ホストのURLでもパスの先頭セグメントが未知のコンテナ名
      // （'foo'）になり永続コンテナにフォールバックしてしまう。その結果、
      // ファイル名さえ一致すれば自アカウント永続コンテナ内の「別レコードの」
      // Blobを消せてしまう。ここでは victim-uuid.jpg という別レコードの画像が
      // 永続コンテナに実在する状態で、攻撃対象のレコードのimagePathを
      // 同じファイル名・外部ホストに差し替えて更新を発火させる
      blobStore.set('test-images/victim-uuid.jpg', { content: Buffer.from('victim') });
      const attackerControlledPlant: Plant = {
        ...existingPlant,
        imagePath: 'https://example.com/foo/victim-uuid.jpg'
      };
      cosmosBackend.documents.set(plantId, attackerControlledPlant);
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://test.blob.core.windows.net/test-images/new-sakura.jpg',
        confidence: 97.0
      };

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toEqual({
        ...attackerControlledPlant,
        ...updateData,
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
      expect(blobStore.has('test-images/victim-uuid.jpg')).toBe(true);
    });

    it('古い画像の削除に失敗しても、更新処理は継続される', async () => {
      cosmosBackend.documents.set(plantId, existingPlant);
      blobStore.set('test-images/old-sakura.jpg', {
        content: Buffer.from('old'),
        failWith: new Error('Delete failed')
      });
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/new-sakura.jpg',
        confidence: 97.0
      };

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toEqual({
        ...existingPlant,
        ...updateData,
        updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      });
      expect(result!.updatedAt).not.toBe(existingPlant.updatedAt);
      // 削除に失敗しているため、古い画像は残ったままになる
      expect(blobStore.has('test-images/old-sakura.jpg')).toBe(true);
    });
  });

  describe('deletePlant', () => {
    const plantId = '123e4567-e89b-12d3-a456-426614174000';
    const existingPlant: Plant = {
      id: plantId,
      name: '桜',
      characteristics: '春に美しい花を咲かせる',
      confidence: 95.5,
      imagePath: 'https://example.com/sakura.jpg',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    };

    it('植物を正常に削除できる', async () => {
      cosmosBackend.documents.set(plantId, existingPlant);

      const result = await service.deletePlant(plantId);

      expect(result).toBe(true);
      expect(cosmosBackend.documents.has(plantId)).toBe(false);
    });

    it('存在しない植物を削除した場合、falseを返す', async () => {
      const result = await service.deletePlant(plantId);

      expect(result).toBe(false);
    });

    it('削除エラーの場合、エラーをスローする', async () => {
      cosmosBackend.documents.set(plantId, existingPlant);
      cosmosBackend.forcedDeleteError = new Error('Delete failed');

      await expect(service.deletePlant(plantId))
        .rejects.toThrow(/^Delete failed$/);
    });

    it('植物を削除してもBlobの画像は削除されない（孤児として残る、既知の仕様）', async () => {
      cosmosBackend.documents.set(plantId, existingPlant);
      blobStore.set('test-images/sakura.jpg', { content: Buffer.from('data') });

      await service.deletePlant(plantId);

      expect(blobStore.has('test-images/sakura.jpg')).toBe(true);
    });
  });

  describe('getPlantByName', () => {
    const sakura: Plant = {
      id: '1',
      name: '桜',
      scientificName: 'Prunus serrulata',
      familyName: 'バラ科',
      characteristics: '春に美しい花を咲かせる',
      confidence: 95.5,
      imagePath: 'https://example.com/sakura.jpg',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    };
    const rose: Plant = {
      ...sakura,
      id: '2',
      name: 'バラ',
      imagePath: 'https://example.com/rose.jpg'
    };

    it('植物名で該当する植物を取得できる', async () => {
      // 検索対象と異なる名前のデータも登録し、渡したパラメータの値で正しく
      // 絞り込まれることを確認する（本番SQLのWHERE句自体の正しさはこの層では
      // 検証できない。偽物バックエンドのコメント参照）。Mapの挿入順を検索対象と
      // 逆にしているため、絞り込みが効いていなければバラが返り、このテストは失敗する
      cosmosBackend.documents.set(rose.id, rose);
      cosmosBackend.documents.set(sakura.id, sakura);

      const result = await service.getPlantByName('桜');

      expect(result).toEqual(sakura);
    });

    it('存在しない植物名の場合、nullを返す', async () => {
      cosmosBackend.documents.set(rose.id, rose);

      const result = await service.getPlantByName('存在しない植物');

      expect(result).toBeNull();
    });
  });

  describe('checkDuplicateByName', () => {
    const sakura: Plant = {
      id: '1',
      name: '桜',
      scientificName: 'Prunus serrulata',
      familyName: 'バラ科',
      characteristics: '春に美しい花を咲かせる',
      confidence: 95.5,
      imagePath: 'https://example.com/sakura.jpg',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    };
    const rose: Plant = {
      ...sakura,
      id: '2',
      name: 'バラ',
      imagePath: 'https://example.com/rose.jpg'
    };

    it('重複する植物が存在する場合、exists: trueと該当植物の情報を返す', async () => {
      // 検索対象と異なる名前のデータも登録し、渡したパラメータの値で正しく
      // 絞り込まれることを確認する（本番SQLのWHERE句自体の正しさはこの層では
      // 検証できない。偽物バックエンドのコメント参照）。挿入順を検索対象と逆にする
      cosmosBackend.documents.set(rose.id, rose);
      cosmosBackend.documents.set(sakura.id, sakura);

      const result = await service.checkDuplicateByName('桜');

      expect(result).toEqual({
        exists: true,
        plant: {
          id: sakura.id,
          name: sakura.name,
          imagePath: sakura.imagePath,
          confidence: sakura.confidence,
          createdAt: sakura.createdAt
        }
      });
    });

    it('重複する植物が存在しない場合、exists: falseを返す', async () => {
      cosmosBackend.documents.set(rose.id, rose);

      const result = await service.checkDuplicateByName('存在しない植物');

      expect(result).toEqual({ exists: false });
    });

    it('クエリに失敗した場合、エラーをスローする', async () => {
      cosmosBackend.forcedQueryError = new Error('Query failed');

      await expect(service.checkDuplicateByName('桜'))
        .rejects.toThrow(/^Query failed$/);
    });
  });

  describe('getPlants', () => {
    it('データベースから返された植物サマリーをそのまま返す', async () => {
      // 並び順（ORDER BY c.createdAt DESC）はSQLを解釈しない偽物では検証できない
      // （下記の偽物バックエンドのコメント参照）ため、2件のcreatedAtを同じ値にして
      // 並び順を主張しない形にする。期待値もarrayContainingで順序を問わない
      const sakuraSummary: PlantSummary = {
        id: '1',
        name: '桜',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: 'https://example.com/sakura.jpg',
        createdAt: '2024-01-01T00:00:00.000Z'
      };
      const roseSummary: PlantSummary = {
        id: '2',
        name: 'バラ',
        characteristics: 'とげがある美しい花',
        confidence: 90.0,
        imagePath: 'https://example.com/rose.jpg',
        createdAt: '2024-01-01T00:00:00.000Z'
      };
      cosmosBackend.documents.set(sakuraSummary.id, sakuraSummary);
      cosmosBackend.documents.set(roseSummary.id, roseSummary);

      const result = await service.getPlants();

      expect(result).toHaveLength(2);
      expect(result).toEqual(expect.arrayContaining([sakuraSummary, roseSummary]));
    });

    it('植物が存在しない場合、空配列を返す', async () => {
      const result = await service.getPlants();

      expect(result).toEqual([]);
    });
  });
});
