// Jest テストセットアップ
import { jest } from '@jest/globals';

// 環境変数のモック設定
process.env.COSMOS_DB_ENDPOINT = 'https://test-cosmos.documents.azure.com:443/';
process.env.COSMOS_DB_KEY = 'test-cosmos-key';
process.env.COSMOS_DB_DATABASE = 'test-db';
process.env.COSMOS_DB_CONTAINER = 'test-plants';
process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test==;EndpointSuffix=core.windows.net';
process.env.STORAGE_CONTAINER_NAME = 'test-images';
process.env.COMPUTER_VISION_ENDPOINT = 'https://test-vision.cognitiveservices.azure.com/';
process.env.COMPUTER_VISION_KEY = 'test-vision-key';

// Azure SDK のモック
jest.mock('@azure/cosmos', () => ({
  CosmosClient: jest.fn().mockImplementation(() => ({
    database: jest.fn().mockReturnValue({
      container: jest.fn().mockReturnValue({
        items: {
          query: jest.fn().mockReturnValue({
            fetchAll: jest.fn()
          }),
          create: jest.fn(),
          upsert: jest.fn()
        },
        item: jest.fn().mockReturnValue({
          read: jest.fn(),
          replace: jest.fn(),
          delete: jest.fn()
        })
      })
    })
  }))
}));

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn().mockReturnValue({
      getContainerClient: jest.fn().mockReturnValue({
        getBlockBlobClient: jest.fn().mockReturnValue({
          upload: jest.fn(),
          downloadToBuffer: jest.fn()
        })
      })
    })
  }
}));

jest.mock('@azure/cognitiveservices-computervision', () => ({
  ComputerVisionClient: jest.fn().mockImplementation(() => ({
    analyzeImage: jest.fn(),
    analyzeImageInStream: jest.fn()
  }))
}));

// Console.log を無効化（テスト実行時のノイズ削減）
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
};