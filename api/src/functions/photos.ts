import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { AlbumService } from '../services/albumService';
import { PhotoStorageService, photoUrlExpiresOn } from '../services/photoStorageService';
import { toPhoto } from '../services/photoView';
import { createSuccessResponse } from '../utils/response';
import { computeSortAt } from '../utils/sortAt';
import { HttpStatusCode } from '../types/api';
import { PhotoDocument } from '../types/album';
import { FILE_UPLOAD } from '../constants/validation';

/**
 * 写真保存 API（冪等。同じ写真は何度送っても1枚）
 * POST /api/photos?code={FUNCTION_KEY}
 */
export async function createPhotoHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('写真保存リクエストを受信');
  const formData = await request.formData();
  const photoId = formData.get('photoId') as string;
  const image = formData.get('image') as unknown as File;
  const thumbnail = formData.get('thumbnail') as unknown as File | null;
  const takenAt = (formData.get('takenAt') as string | null) ?? null;
  const latitude = formData.get('latitude') as string | null;
  const longitude = formData.get('longitude') as string | null;
  const placeName = (formData.get('placeName') as string | null) ?? null;

  const imageBuffer = Buffer.from(await image.arrayBuffer());
  const blobName = `${photoId}${FILE_UPLOAD.EXTENSION_BY_CONTENT_TYPE[image.type]}`;
  const thumbnailBlobName = thumbnail ? `${photoId}.thumb.jpg` : null;

  const storage = new PhotoStorageService();
  await storage.upload(blobName, imageBuffer, image.type);
  if (thumbnail && thumbnailBlobName) {
    await storage.upload(thumbnailBlobName, Buffer.from(await thumbnail.arrayBuffer()), thumbnail.type);
  }

  const now = new Date().toISOString();
  const doc: PhotoDocument = {
    id: photoId,
    type: 'photo',
    tripId: null,
    blobName,
    thumbnailBlobName,
    contentType: image.type,
    fileSize: image.size,
    takenAt,
    takenAtSource: takenAt ? 'exif' : 'none',
    sortAt: computeSortAt(takenAt, now),
    location:
      latitude !== null && longitude !== null
        ? { latitude: Number(latitude), longitude: Number(longitude), placeName, placeSource: placeName ? 'device' : null }
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
  const saved = await new AlbumService().createPhoto(doc);
  context.log(`写真保存成功: ID=${saved.id}`);

  const expiresOn = photoUrlExpiresOn();
  return createSuccessResponse(
    { photo: toPhoto(saved, storage, expiresOn), urlExpiresAt: expiresOn.toISOString() },
    HttpStatusCode.CREATED
  );
}

app.http('createPhoto', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'photos',
  handler: createPhotoHandler,
});
