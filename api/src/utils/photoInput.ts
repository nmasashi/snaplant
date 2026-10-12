import { createHash } from 'node:crypto';
import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { createErrorResponse, createValidationError, isValidUUID } from './response';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { FILE_UPLOAD, MOVE_VALIDATION, PHOTO_VALIDATION } from '../constants/validation';

/** 検証を通った写真の保存の入力 */
export interface PhotoInput {
  photoId: string;
  image: Buffer;
  /** 原寸の Content-Type（小文字にそろえたもの） */
  contentType: string;
  /** サムネイル。送られなければ null */
  thumbnail: { data: Buffer; contentType: string } | null;
  tripId: string | null;
  takenAt: string | null;
  location: { latitude: number; longitude: number; placeName: string | null } | null;
}

type Result = { input: PhotoInput } | { error: HttpResponseInit };

/** multipart のパートの値（DOM の FormDataEntryValue は lib に無いので FormData から取る） */
type FormValue = ReturnType<FormData['get']>;

/** multipart のファイルのパート */
type FilePart = Exclude<FormValue, string | null>;

/**
 * 写真の保存（POST /api/photos）の multipart を読んで検証する
 *
 * 順序は docs/travel-album/05_api_design.md §5.1 の表のとおり。Blob と Cosmos に触る前に全部弾く。
 * 画像の内容と写真 ID の照合（18）はバイト列を読む必要があるので最後
 * @param request リクエスト
 * @returns 検証を通った入力、または 400 / 413 / 415 の応答
 */
export async function readPhotoInput(request: HttpRequest): Promise<Result> {
  const contentType = request.headers.get('content-type');
  if (!contentType || !contentType.startsWith('multipart/form-data')) {
    return fail('Content-Typeがmultipart/form-dataではありません', 'multipart/form-dataで送信してください');
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    // 壊れた multipart。エラーの文字列では判定しない（SDK の文言は変わりうる）
    return fail('ファイルの読み取りに失敗しました', '有効なmultipart/form-dataを送信してください');
  }

  const photoId = formData.get('photoId');
  if (typeof photoId !== 'string' || photoId === '') {
    return fail('写真IDが指定されていません');
  }
  if (!PHOTO_VALIDATION.ID_REGEX.test(photoId)) {
    return fail('写真IDの形式が無効です');
  }

  const image = formData.get('image');
  if (!isFile(image)) {
    return fail('画像ファイルが指定されていません', 'imageフィールドでファイルを送信してください');
  }
  const imageError = checkFile(image, FILE_UPLOAD.MAX_SIZE, '画像ファイルが空です', 'ファイルサイズが大きすぎます');
  if (imageError) {
    return { error: imageError };
  }

  const thumbnail = formData.get('thumbnail');
  if (thumbnail !== null && !isFile(thumbnail)) {
    return fail('サムネイルはファイルで送信してください');
  }
  if (thumbnail !== null) {
    const thumbnailError = checkFile(
      thumbnail,
      PHOTO_VALIDATION.THUMBNAIL_MAX_SIZE,
      'サムネイルが空です',
      'サムネイルのサイズが大きすぎます'
    );
    if (thumbnailError) {
      return { error: thumbnailError };
    }
  }

  const tripId = formData.get('tripId');
  if (tripId !== null && (typeof tripId !== 'string' || !isValidUUID(tripId))) {
    return fail('旅行IDの形式が無効です');
  }

  const takenAt = formData.get('takenAt');
  if (takenAt !== null && (typeof takenAt !== 'string' || !isExistingDateTime(takenAt))) {
    return fail('撮影日時の形式が無効です');
  }

  const latitude = formData.get('latitude');
  const longitude = formData.get('longitude');
  if ((latitude === null) !== (longitude === null)) {
    return fail('緯度と経度は両方指定してください');
  }
  const hasLocation = latitude !== null && longitude !== null;
  const lat = toCoordinate(latitude, 90);
  const lng = toCoordinate(longitude, 180);
  if (hasLocation && (lat === null || lng === null)) {
    return fail('位置情報の形式が無効です');
  }

  const placeName = formData.get('placeName');
  if (placeName !== null && !hasLocation) {
    return fail('地名は緯度・経度と一緒に指定してください');
  }
  if (
    placeName !== null &&
    (typeof placeName !== 'string' || placeName.trim() === '' || placeName.length > PHOTO_VALIDATION.MAX_LENGTH.PLACE_NAME)
  ) {
    return fail(PHOTO_VALIDATION.ERROR_MESSAGES.PLACE_NAME_INVALID);
  }

  const imageBuffer = Buffer.from(await image.arrayBuffer());
  // 写真の id は中身の SHA-256 で、同じ写真が1枚になる根拠。クライアントの計算を信用せず照合する
  if (createHash('sha256').update(imageBuffer).digest('hex') !== photoId) {
    return fail('写真IDが画像の内容と一致しません');
  }

  return {
    input: {
      photoId,
      image: imageBuffer,
      contentType: image.type.toLowerCase(),
      thumbnail: thumbnail
        ? { data: Buffer.from(await thumbnail.arrayBuffer()), contentType: thumbnail.type.toLowerCase() }
        : null,
      tripId: tripId as string | null,
      takenAt: takenAt as string | null,
      location: hasLocation ? { latitude: lat!, longitude: lng!, placeName: placeName as string | null } : null,
    },
  };
}

/**
 * multipart のパートがファイルか（テキストで送られたものは string になる）
 * @param value パートの値
 */
function isFile(value: FormValue): value is FilePart {
  return value !== null && typeof value !== 'string' && typeof value.arrayBuffer === 'function';
}

/**
 * ファイルの形式と大きさを検証する（形式 415 → 空 400 → 大きすぎ 413 の順）
 * @param file ファイル
 * @param maxSize 上限（バイト）
 * @param emptyMessage 空のときの文言
 * @param tooLargeMessage 大きすぎるときの文言
 */
function checkFile(file: FilePart, maxSize: number, emptyMessage: string, tooLargeMessage: string): HttpResponseInit | null {
  if (!(FILE_UPLOAD.SUPPORTED_IMAGE_TYPES as readonly string[]).includes(file.type.toLowerCase())) {
    return createErrorResponse(
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      'サポートされていない画像形式です',
      HttpStatusCode.UNSUPPORTED_MEDIA_TYPE,
      FILE_UPLOAD.ERROR_MESSAGES.UNSUPPORTED_TYPE
    );
  }
  if (file.size === 0) {
    return createValidationError(emptyMessage);
  }
  if (file.size > maxSize) {
    return createErrorResponse(ErrorCode.FILE_TOO_LARGE, tooLargeMessage, HttpStatusCode.PAYLOAD_TOO_LARGE);
  }
  return null;
}

/**
 * タイムゾーン無しの `YYYY-MM-DDTHH:mm:ss` で、実在する日時か
 *
 * new Date() は 2月30日を3月2日に繰り上げて通すので、組み立て直して一致を確かめる
 * @param value 日時の文字列
 */
function isExistingDateTime(value: string): boolean {
  const match = PHOTO_VALIDATION.TAKEN_AT_REGEX.exec(value);
  if (!match) {
    return false;
  }
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

/**
 * 緯度・経度を数値にする。有限で ±limit の範囲内でなければ null
 * @param value パートの値
 * @param limit 絶対値の上限（緯度 90、経度 180）
 */
function toCoordinate(value: FormValue, limit: number): number | null {
  if (typeof value !== 'string' || !PHOTO_VALIDATION.COORDINATE_REGEX.test(value)) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/**
 * 400 INVALID_REQUEST の結果を作る
 * @param message 文言
 * @param details 補足（契約外）
 */
function fail(message: string, details?: string): Result {
  return { error: createValidationError(message, details) };
}

/** 検証を通った写真一覧のクエリ */
export interface PhotoListQuery {
  /** 旅行 ID。どの旅行にも属さない写真なら null（クエリでは none） */
  tripId: string | null;
  limit: number;
  /** 前のページの継続トークン。先頭からなら undefined */
  continuationToken: string | undefined;
}

/**
 * 写真一覧（GET /api/photos）のクエリを検証する
 *
 * 順序は docs/travel-album/05_api_design.md §5.2 の表のとおり。Cosmos に触る前に全部弾く。
 * 「無い」と「空」を分ける（limit が無ければ既定の枚数、空なら 400。継続トークンが無ければ先頭から、空なら 400）
 * @param query リクエストのクエリ
 * @returns 検証を通ったクエリ、または 400 の応答
 */
export function readPhotoListQuery(
  query: URLSearchParams
): { query: PhotoListQuery } | { error: HttpResponseInit } {
  const tripIdParam = query.get('tripId');
  if (tripIdParam === null) {
    return { error: createValidationError('絞り込み条件を指定してください') };
  }
  if (tripIdParam !== 'none' && !isValidUUID(tripIdParam)) {
    return { error: createValidationError('旅行IDの形式が無効です') };
  }

  const limitParam = query.get('limit');
  // 既定の枚数も上限を超えない（環境変数の設定の誤りで上限が破られないように）
  let limit: number = Math.min(PHOTO_VALIDATION.PAGE_SIZE, PHOTO_VALIDATION.MAX_PAGE_SIZE);
  if (limitParam !== null) {
    limit = /^[1-9][0-9]*$/.test(limitParam) ? Number(limitParam) : NaN;
    if (!(limit <= PHOTO_VALIDATION.MAX_PAGE_SIZE)) {
      return { error: createValidationError(PHOTO_VALIDATION.ERROR_MESSAGES.LIMIT_INVALID) };
    }
  }

  const continuationToken = query.get('continuationToken');
  // Cosmos の継続トークンは JSON。読めないものを SDK に渡すと code の無い Error になり 500 と区別できないので、ここで弾く
  if (continuationToken !== null && !isJson(continuationToken)) {
    return { error: createValidationError('継続トークンの形式が無効です') };
  }

  return {
    query: {
      tripId: tripIdParam === 'none' ? null : tripIdParam,
      limit,
      continuationToken: continuationToken ?? undefined,
    },
  };
}

/**
 * 文字列が JSON として読めるか（空文字は読めない）
 * @param value 文字列
 */
function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** 検証を通った写真の移動の入力 */
export interface MoveInput {
  /** 移す写真 ID（重複を除いたもの） */
  photoIds: string[];
  /** 移す先の旅行 ID。旅行から外すなら null */
  tripId: string | null;
}

/**
 * 写真の移動（POST /api/photos/move）のボディを読んで検証する（docs/travel-album/05_api_design.md §5.5 の表の順）
 *
 * 「旅行から外す」は tripId: null を明示させる（キーの省略と区別し、取り違えを検出する）
 * @param request リクエスト
 * @returns 検証を通った入力、または 400 の応答
 */
export async function readMoveInput(request: HttpRequest): Promise<{ input: MoveInput } | { error: HttpResponseInit }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error: any) {
    if (error instanceof SyntaxError) {
      return { error: createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください') };
    }
    throw error;
  }
  if (body === null || body === undefined) {
    return { error: createValidationError('リクエストボディが指定されていません') };
  }
  const { photoIds, tripId } = body as { photoIds?: unknown; tripId?: unknown };
  if (!Array.isArray(photoIds)) {
    return { error: createValidationError('写真IDは配列で指定してください') };
  }
  if (photoIds.length === 0) {
    return { error: createValidationError('写真IDが指定されていません') };
  }
  if (photoIds.length > MOVE_VALIDATION.MAX_IDS) {
    return { error: createValidationError(MOVE_VALIDATION.ERROR_MESSAGES.TOO_MANY) };
  }
  if (!photoIds.every((id) => typeof id === 'string' && PHOTO_VALIDATION.ID_REGEX.test(id))) {
    return { error: createValidationError('写真IDの形式が無効です') };
  }
  if (!('tripId' in (body as object))) {
    return { error: createValidationError('移動先の旅行が指定されていません') };
  }
  if (tripId !== null && (typeof tripId !== 'string' || !isValidUUID(tripId))) {
    return { error: createValidationError('旅行IDの形式が無効です') };
  }
  return { input: { photoIds: [...new Set(photoIds as string[])], tripId: tripId as string | null } };
}
