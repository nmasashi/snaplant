import { CosmosService } from '../../src/services/cosmosService';
import { StorageService } from '../../src/services/storageService';
import { Plant, PlantCreateRequest, PlantUpdateRequest } from '../../src/types/plant';
import { CosmosClient, Database, Container, SqlQuerySpec } from '@azure/cosmos';

// 外部依存のみモック
jest.mock('@azure/cosmos');
jest.mock('@azure/storage-blob'); // StorageServiceが使用するため

const MockedCosmosClient = jest.mocked(CosmosClient);

describe('CosmosService', () => {
  let service: CosmosService;
  let mockStorageService: jest.Mocked<StorageService>;
  let mockClient: jest.Mocked<CosmosClient>;
  let mockDatabase: jest.Mocked<Database>;
  let mockContainer: jest.Mocked<Container>;
  let mockItems: any;
  let mockItem: any;

  beforeEach(() => {
    // Cosmos DB SDKのモック設定
    mockItems = {
      query: jest.fn(),
      create: jest.fn()
    };

    mockItem = {
      read: jest.fn(),
      replace: jest.fn(),
      delete: jest.fn()
    };

    mockContainer = {
      items: mockItems,
      item: jest.fn().mockReturnValue(mockItem)
    } as any;

    mockDatabase = {
      container: jest.fn().mockReturnValue(mockContainer)
    } as any;

    mockClient = {
      database: jest.fn().mockReturnValue(mockDatabase)
    } as any;

    MockedCosmosClient.mockImplementation(() => mockClient);

    // StorageServiceのモック設定（注入用）
    mockStorageService = {
      deleteImage: jest.fn()
    } as any;

    // 環境変数設定
    process.env.COSMOS_DB_ENDPOINT = 'https://test.documents.azure.com:443/';
    process.env.COSMOS_DB_KEY = 'test-key';
    process.env.COSMOS_DB_DATABASE = 'test-db';
    process.env.COSMOS_DB_CONTAINER = 'test-container';

    service = new CosmosService();
    // StorageServiceを手動で注入（テスト用）
    (service as any).storageService = mockStorageService;
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_KEY;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_CONTAINER;
  });

  describe('createPlant', () => {
    it('植物を正常に作成できる', async () => {
      const plantCreateRequest: PlantCreateRequest = {
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        description: '日本を代表する花木',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: 'https://example.com/sakura.jpg'
      };

      const expectedPlant: Plant = {
        id: expect.any(String),
        ...plantCreateRequest,
        createdAt: expect.any(String),
        updatedAt: expect.any(String)
      };

      mockItems.create.mockResolvedValue({ resource: expectedPlant });

      const result = await service.createPlant(plantCreateRequest);

      expect(result).toEqual(expectedPlant);
      expect(mockItems.create).toHaveBeenCalledWith(expect.objectContaining({
        ...plantCreateRequest,
        id: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String)
      }));
    });

    it('作成エラーの場合、エラーをスローする', async () => {
      const plantCreateRequest: PlantCreateRequest = {
        name: '桜',
        scientificName: 'Prunus serrulata',
        familyName: 'バラ科',
        characteristics: '春に美しい花を咲かせる',
        confidence: 95.5,
        imagePath: 'https://example.com/sakura.jpg'
      };

      const createError = new Error('Create failed');
      mockItems.create.mockRejectedValue(createError);

      await expect(service.createPlant(plantCreateRequest))
        .rejects.toThrow('Create failed');
    });
  });

  describe('getPlantById', () => {
    it('IDで植物を正常に取得できる', async () => {
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

      mockItem.read.mockResolvedValue({ resource: mockPlant });

      const result = await service.getPlantById(plantId);

      expect(result).toEqual(mockPlant);
      expect(mockContainer.item).toHaveBeenCalledWith(plantId, plantId);
      expect(mockItem.read).toHaveBeenCalled();
    });

    it('存在しない植物の場合、nullを返す', async () => {
      const plantId = '123e4567-e89b-12d3-a456-426614174000';

      mockItem.read.mockResolvedValue({ resource: null });

      const result = await service.getPlantById(plantId);

      expect(result).toBeNull();
    });

    it('取得エラーの場合、エラーをスローする', async () => {
      const plantId = '123e4567-e89b-12d3-a456-426614174000';

      const readError = new Error('Read failed');
      mockItem.read.mockRejectedValue(readError);

      await expect(service.getPlantById(plantId))
        .rejects.toThrow('Read failed');
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
      imagePath: 'https://example.com/old-sakura.jpg',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z'
    };

    it('植物を正常に更新できる', async () => {
      const updateData: PlantUpdateRequest = {
        imagePath: existingPlant.imagePath,
        confidence: 98.0
      };

      const updatedPlant = {
        ...existingPlant,
        ...updateData,
        updatedAt: expect.any(String)
      };

      mockItem.read.mockResolvedValue({ resource: existingPlant });
      mockItem.replace.mockResolvedValue({ resource: updatedPlant });

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toEqual(updatedPlant);
      expect(mockItem.read).toHaveBeenCalled();
      expect(mockItem.replace).toHaveBeenCalledWith(expect.objectContaining({
        ...existingPlant,
        ...updateData,
        updatedAt: expect.any(String)
      }));
      
      // 古い画像は削除されない（imagePath更新なし）
      expect(mockStorageService.deleteImage).not.toHaveBeenCalled();
    });

    it('画像パスが更新される場合、古い画像を削除する', async () => {
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/new-sakura.jpg',
        confidence: 97.0
      };

      const updatedPlant = {
        ...existingPlant,
        ...updateData,
        updatedAt: expect.any(String)
      };

      mockItem.read.mockResolvedValue({ resource: existingPlant });
      mockItem.replace.mockResolvedValue({ resource: updatedPlant });
      mockStorageService.deleteImage.mockResolvedValue(true);

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toEqual(updatedPlant);
      
      // 古い画像が削除される
      expect(mockStorageService.deleteImage).toHaveBeenCalledWith('https://example.com/old-sakura.jpg');
    });

    it('存在しない植物の場合、nullを返す', async () => {
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/test.jpg',
        confidence: 95.0
      };

      mockItem.read.mockResolvedValue({ resource: null });

      const result = await service.updatePlant(plantId, updateData);

      expect(result).toBeNull();
      expect(mockItem.replace).not.toHaveBeenCalled();
      expect(mockStorageService.deleteImage).not.toHaveBeenCalled();
    });

    it('更新エラーの場合、エラーをスローする', async () => {
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/test.jpg',
        confidence: 95.0
      };

      mockItem.read.mockResolvedValue({ resource: existingPlant });
      
      const replaceError = new Error('Replace failed');
      mockItem.replace.mockRejectedValue(replaceError);

      await expect(service.updatePlant(plantId, updateData))
        .rejects.toThrow('Replace failed');
    });

    it('古い画像削除エラーは無視される', async () => {
      const updateData: PlantUpdateRequest = {
        imagePath: 'https://example.com/new-sakura.jpg',
        confidence: 97.0
      };

      const updatedPlant = {
        ...existingPlant,
        ...updateData,
        updatedAt: expect.any(String)
      };

      mockItem.read.mockResolvedValue({ resource: existingPlant });
      mockItem.replace.mockResolvedValue({ resource: updatedPlant });
      
      // 画像削除エラー
      mockStorageService.deleteImage.mockRejectedValue(new Error('Delete failed'));

      // エラーが発生しても更新処理は継続される
      const result = await service.updatePlant(plantId, updateData);

      expect(result).toEqual(updatedPlant);
      expect(mockStorageService.deleteImage).toHaveBeenCalled();
    });
  });

  describe('deletePlant', () => {
    it('植物を正常に削除できる', async () => {
      const plantId = '123e4567-e89b-12d3-a456-426614174000';

      mockItem.delete.mockResolvedValue({ resource: { id: plantId } });

      await service.deletePlant(plantId);

      expect(mockContainer.item).toHaveBeenCalledWith(plantId, plantId);
      expect(mockItem.delete).toHaveBeenCalled();
    });

    it('削除エラーの場合、エラーをスローする', async () => {
      const plantId = '123e4567-e89b-12d3-a456-426614174000';

      const deleteError = new Error('Delete failed');
      mockItem.delete.mockRejectedValue(deleteError);

      await expect(service.deletePlant(plantId))
        .rejects.toThrow('Delete failed');
    });
  });

  describe('getPlantByName', () => {
    it('植物名で植物を取得できる', async () => {
      const searchName = '桜';
      const mockPlant = {
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

      const mockQueryResponse = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [mockPlant] })
      };
      mockItems.query.mockReturnValue(mockQueryResponse);

      const result = await service.getPlantByName(searchName);

      expect(result).toEqual(mockPlant);
      
      // クエリが正しく構築されているかチェック
      const queryCall = mockItems.query.mock.calls[0][0] as SqlQuerySpec;
      expect(queryCall.query).toContain('WHERE c.name = @name');
      expect(queryCall.parameters).toEqual([{ name: '@name', value: searchName }]);
    });

    it('存在しない植物の場合、nullを返す', async () => {
      const searchName = '存在しない植物';

      const mockQueryResponse = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQueryResponse);

      const result = await service.getPlantByName(searchName);

      expect(result).toBeNull();
    });
  });

  describe('checkDuplicateByName', () => {
    it('重複する植物が存在する場合、exists: trueを返す', async () => {
      const plantName = '桜';
      const mockPlant = {
        id: '1',
        name: '桜',
        imagePath: 'https://example.com/sakura.jpg',
        confidence: 95.5,
        createdAt: '2024-01-01T00:00:00.000Z'
      };

      const mockQueryResponse = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [mockPlant] })
      };
      mockItems.query.mockReturnValue(mockQueryResponse);

      const result = await service.checkDuplicateByName(plantName);

      expect(result).toEqual({
        exists: true,
        plant: mockPlant
      });
      
      // クエリが正しく構築されているかチェック
      const queryCall = mockItems.query.mock.calls[0][0] as SqlQuerySpec;
      expect(queryCall.query).toContain('WHERE c.name = @name');
      expect(queryCall.parameters).toEqual([{ name: '@name', value: plantName }]);
    });

    it('重複する植物が存在しない場合、exists: falseを返す', async () => {
      const plantName = '存在しない植物';

      const mockQueryResponse = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQueryResponse);

      const result = await service.checkDuplicateByName(plantName);

      expect(result).toEqual({ exists: false });
    });
  });

  describe('getPlants', () => {
    it('全ての植物サマリーを取得できる', async () => {
      const mockPlants = [
        {
          id: '1',
          name: '桜',
          characteristics: '春に美しい花を咲かせる',
          confidence: 95.5,
          imagePath: 'https://example.com/sakura.jpg',
          createdAt: '2024-01-01T00:00:00.000Z'
        },
        {
          id: '2',
          name: 'バラ',
          characteristics: 'とげがある美しい花',
          confidence: 90.0,
          imagePath: 'https://example.com/rose.jpg',
          createdAt: '2024-01-02T00:00:00.000Z'
        }
      ];

      const mockQueryResponse = {
        fetchAll: jest.fn().mockResolvedValue({ resources: mockPlants })
      };
      mockItems.query.mockReturnValue(mockQueryResponse);

      const result = await service.getPlants();

      expect(result).toEqual(mockPlants);
      
      // サマリー取得クエリが正しく構築されているかチェック
      const queryCall = mockItems.query.mock.calls[0][0];
      expect(queryCall).toContain('SELECT c.id, c.name, c.characteristics');
      expect(queryCall).toContain('ORDER BY c.createdAt DESC');
    });

    it('植物が存在しない場合、空配列を返す', async () => {
      const mockQueryResponse = {
        fetchAll: jest.fn().mockResolvedValue({ resources: [] })
      };
      mockItems.query.mockReturnValue(mockQueryResponse);

      const result = await service.getPlants();

      expect(result).toEqual([]);
    });
  });

  describe('UUID生成', () => {
    it('有効なUUIDを生成する', () => {
      // privateメソッドへのアクセス（テスト用）
      const generateIdMethod = (service as any).generateId.bind(service);
      const uuid = generateIdMethod();

      // UUID v4 形式かチェック
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });

    it('複数回呼び出しで異なるUUIDを生成する', () => {
      const generateIdMethod = (service as any).generateId.bind(service);
      const uuid1 = generateIdMethod();
      const uuid2 = generateIdMethod();

      expect(uuid1).not.toBe(uuid2);
    });
  });
});