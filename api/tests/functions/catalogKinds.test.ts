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

  it('図鑑に載せる種類（植物）だけを、種類ごとの項目（キー・表示名・型）と一緒に返す', async () => {
    // アプリは種類のタブと項目詳細の欄をここから作る（04 §3.2）。AI に渡す指示（prompt・namingRule）は返さない。
    // 食べ物・風景は識別はできるが図鑑には載せない（02 §5 #51）
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
              { key: 'genusName', label: '属', type: 'string' },
              { key: 'genus', label: '属の学名', type: 'string' },
              { key: 'familyName', label: '科名', type: 'string' }
            ]
          }
        ]
      }
    });
  });
});
