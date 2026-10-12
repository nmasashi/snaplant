import { PhotoDocument, TripDocument } from '../../src/types/album';

/**
 * Cosmos DB が保存したドキュメントに実際に付けるシステム項目。
 * 偽物の Cosmos は付けないので、応答への漏れを見るテストが、偽物に置くドキュメントに自分で足す。
 * 応答の写真に混ざると、利用者に内部の識別子や ETag が見えてしまう
 */
export const COSMOS_SYSTEM_FIELDS = {
  _rid: 'q2cDAOZl6N8BAAAAAAAAAA==',
  _self: 'dbs/q2cDAA==/colls/q2cDAOZl6N8=/docs/q2cDAOZl6N8BAAAAAAAAAA==/',
  _etag: '"0000a1b2-0000-0d00-0000-6706a1b20000"',
  _attachments: 'attachments/',
  _ts: 1760065200
};

/**
 * 旅行のドキュメント(偽物の documents に置いて「旅行がある」状態を作る)。
 *
 * id と name 以外の既定値は、型を満たすための仮の値で、意味を持たせない。
 * テストの期待に関わる値は、テスト側で overrides に書く
 */
export const tripDocument = (id: string, name: string, overrides: Partial<TripDocument> = {}): TripDocument => ({
  id,
  type: 'trip',
  name,
  description: null,
  tags: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides
});

/**
 * 保存済みの写真のドキュメント(偽物の documents に置く)。
 *
 * id 以外の既定値は、型を満たすための仮の値で、意味を持たせない。
 * テストの期待に関わる値(旅行・並べ替え用の日時・Blob 名・応答にそのまま出る項目など)は、
 * テスト側で overrides に書く。Blob 名の既定値も、URL や Blob の期待がそれに頼るテストは明示する
 */
export const photoDocument = (id: string, overrides: Partial<PhotoDocument> = {}): PhotoDocument => ({
  id,
  type: 'photo',
  tripId: null,
  blobName: `${id}.jpg`,
  thumbnailBlobName: `${id}.thumb.jpg`,
  contentType: 'image/jpeg',
  fileSize: 1000,
  takenAt: null,
  takenAtSource: 'none',
  sortAt: '2026-10-10T12:00:00',
  location: null,
  category: null,
  tags: [],
  comment: null,
  commentSource: null,
  hint: null,
  classification: null,
  identification: null,
  processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
  uploadedAt: '2026-10-10T03:00:00.000Z',
  updatedAt: '2026-10-10T03:00:00.000Z',
  ...overrides
});
