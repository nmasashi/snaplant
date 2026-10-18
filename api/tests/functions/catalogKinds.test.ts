import { HttpRequest, InvocationContext } from '@azure/functions';
import { listCatalogKindsHandler } from '../../src/functions/catalogKinds';

describe('図鑑の種類の一覧API', () => {
  const request = {
    method: 'GET',
    url: 'https://func-snaplant.azurewebsites.net/api/catalog/kinds?code=test-key',
    query: new URLSearchParams({ code: 'test-key' }),
    headers: new Map(),
    params: {}
  } as any as HttpRequest;

  it('定義表の種類を、表の順に、種類ごとの項目（キー・表示名・型）と一緒に返す', async () => {
    // アプリは種類のタブと項目詳細の欄をここから作る（04 §3.2）。AI に渡す指示（prompt・namingRule）は返さない
    const response = await listCatalogKindsHandler(request, { log: jest.fn() } as any as InvocationContext);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      success: true,
      data: {
        kinds: [
          {
            kind: 'plant',
            label: '植物',
            fields: [
              { key: 'scientificName', label: '学名', type: 'string' },
              { key: 'familyName', label: '科名', type: 'string' }
            ]
          },
          {
            kind: 'food',
            label: '食べ物',
            fields: [
              { key: 'genre', label: '料理のジャンル', type: 'string' },
              { key: 'mainIngredients', label: '主な食材', type: 'string[]' }
            ]
          },
          {
            kind: 'landscape',
            label: '風景',
            fields: [
              { key: 'placeType', label: '場所の種類', type: 'string' },
              { key: 'placeName', label: '場所の名前', type: 'string' },
              { key: 'region', label: '地域', type: 'string' }
            ]
          }
        ]
      }
    });
  });
});
