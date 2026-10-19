// Jest テストセットアップ
import { jest } from '@jest/globals';

// 環境変数のモック設定
process.env.COSMOS_DB_ENDPOINT = 'https://test-cosmos.documents.azure.com:443/';
process.env.COSMOS_DB_KEY = 'test-cosmos-key';
process.env.COSMOS_DB_DATABASE = 'test-db';
process.env.STORAGE_CONNECTION_STRING = 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test==;EndpointSuffix=core.windows.net';
process.env.AZURE_OPENAI_ENDPOINT = 'https://test-openai.openai.azure.com/';
process.env.AZURE_OPENAI_API_KEY = 'test-openai-key';
process.env.AZURE_OPENAI_DEPLOYMENT_NAME = 'gpt-5.6-luna';

jest.mock('openai', () => {
  const mockOpenAI = jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn()
      }
    }
  }));
  
  // Default export for ES6 modules
  (mockOpenAI as any).default = mockOpenAI;
  
  return mockOpenAI;
});

// Console.log を無効化（テスト実行時のノイズ削減）
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
};