import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService, photoUrlExpiresOn } from '../services/photoStorageService';
import { toPhoto } from '../services/photoView';
import {
  createDatabaseErrorResponse,
  createNotFoundError,
  createSuccessResponse,
  createUpstreamErrorResponse
} from '../utils/response';
import { UpstreamError } from '../utils/errors';
import { readPhotoInput } from '../utils/photoInput';
import { computeSortAt } from '../utils/sortAt';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { PhotoDocument } from '../types/album';
import { FILE_UPLOAD } from '../constants/validation';

/**
 * 写真保存 API（冪等。同じ写真は何度送っても1枚）
 * POST /api/photos?code={FUNCTION_KEY}
 */
export async function createPhotoHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('写真保存リクエストを受信');
  const validated = await readPhotoInput(request);
  if ('error' in validated) {
    return validated.error;
  }
  const input = validated.input;
  try {
    const album = new AlbumService();

    if (input.tripId && !(await album.tripExists(input.tripId))) {
      return createNotFoundError('指定された旅行が見つかりません', ErrorCode.TRIP_NOT_FOUND);
    }

    const storage = new PhotoStorageService();

    // 同じ写真は1枚。既にあれば Blob にも触らず、送り先の旅行も変えずにそのまま返す
    // （送信は「入れる」ではない。入れたければ move を使う）
    const existing = await album.getPhoto(input.photoId);
    if (existing) {
      const expiresOn = photoUrlExpiresOn();
      return createSuccessResponse({ photo: toPhoto(existing, storage, expiresOn), urlExpiresAt: expiresOn.toISOString() });
    }

    const blobName = `${input.photoId}${FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE[input.contentType]}`;
    const thumbnailBlobName = input.thumbnail ? `${input.photoId}.thumb.jpg` : null;

    await storage.upload(blobName, input.image, input.contentType);
    if (input.thumbnail && thumbnailBlobName) {
      await storage.upload(thumbnailBlobName, input.thumbnail, input.thumbnailContentType!);
    }

    const now = new Date().toISOString();
    const doc: PhotoDocument = {
      id: input.photoId,
      type: 'photo',
      tripId: input.tripId,
      blobName,
      thumbnailBlobName,
      contentType: input.contentType,
      fileSize: input.image.length,
      takenAt: input.takenAt,
      takenAtSource: input.takenAt ? 'exif' : 'none',
      sortAt: computeSortAt(input.takenAt, now),
      location: input.location
        ? { ...input.location, placeSource: input.location.placeName ? 'device' : null }
        : null,
      category: null,
      tags: [],
      comment: null,
      commentSource: null,
      hint: null,
      classification: null,
      identification: null,
      processing: { state: 'none', step: null, attempts: 0, lastError: null, updatedAt: null },
      uploadedAt: now,
      updatedAt: now,
    };
    const { photo, created } = await album.createPhoto(doc);
    context.log(`写真保存成功: ID=${photo.id}`);

    const expiresOn = photoUrlExpiresOn();
    return createSuccessResponse(
      { photo: toPhoto(photo, storage, expiresOn), urlExpiresAt: expiresOn.toISOString() },
      created ? HttpStatusCode.CREATED : HttpStatusCode.OK
    );
  } catch (error: any) {
    context.log('写真保存エラー:', error);
    // Blob の失敗を先に見る。UpstreamError は元のエラーを cause に持ち、isConnectivityError は cause の奥まで
    // errno を探すので、順序が逆だとストレージに接続できない障害が「データベースに接続できません」になる
    if (error instanceof UpstreamError) {
      return createUpstreamErrorResponse(error);
    }
    return createDatabaseErrorResponse(error, '写真の保存に失敗しました');
  }
}

app.http('createPhoto', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'photos',
  handler: createPhotoHandler,
});
