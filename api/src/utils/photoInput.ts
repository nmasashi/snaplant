import { createHash } from 'node:crypto';
import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { createErrorResponse, createValidationError, isValidUUID } from './response';
import { readJsonBody } from './tripInput';
import { ErrorCode, HttpStatusCode } from '../types/api';
import { CONTEXT_INFO_VALIDATION, FILE_UPLOAD, MOVE_VALIDATION, PHOTO_VALIDATION, TAG_VALIDATION } from '../constants/validation';
import { PHOTO_KINDS, isPhotoKind } from '../catalog/kinds';
import { PhotoTag } from '../types/album';
import { readPageLimit } from './pageLimit';
import { exceedsLength, trimUserText } from './userText';

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
 * 順序は docs/05_api_design.md §5.1 の表のとおり。Blob と Cosmos に触る前に全部弾く。
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
  /** 旅行 ID。どの旅行にも属さない写真なら null（クエリでは none）。旅行で絞らないなら undefined */
  tripId: string | null | undefined;
  /** カテゴリ。カテゴリで絞らないなら undefined */
  category: string | undefined;
  /** お気に入りだけに絞るなら true。絞らないなら undefined */
  favorite: true | undefined;
  limit: number;
  /** 前のページの継続トークン。先頭からなら undefined */
  continuationToken: string | undefined;
}

/**
 * 写真一覧（GET /api/photos）のクエリを検証する
 *
 * 順序は docs/05_api_design.md §5.2 の表のとおり。Cosmos に触る前に全部弾く。
 * 「無い」と「空」を分ける（limit が無ければ既定の枚数、空なら 400。継続トークンが無ければ先頭から、空なら 400）
 * @param query リクエストのクエリ
 * @returns 検証を通ったクエリ、または 400 の応答
 */
export function readPhotoListQuery(
  query: URLSearchParams
): { query: PhotoListQuery } | { error: HttpResponseInit } {
  const tripIdParam = query.get('tripId');
  const categoryParam = query.get('category');
  if (tripIdParam === null && categoryParam === null) {
    return { error: createValidationError('絞り込み条件を指定してください') };
  }
  if (tripIdParam !== null && tripIdParam !== 'none' && !isValidUUID(tripIdParam)) {
    return { error: createValidationError('旅行IDの形式が無効です') };
  }
  if (categoryParam !== null && !PHOTO_KINDS.includes(categoryParam)) {
    return { error: createValidationError('カテゴリが無効です') };
  }
  // お気に入りは「お気に入りだけ」に絞る指定なので true だけ（false で「お気に入りでないものだけ」は作らない。02 §5 #63）
  const favoriteParam = query.get('favorite');
  if (favoriteParam !== null && favoriteParam !== 'true') {
    return { error: createValidationError(FAVORITE_INVALID_MESSAGE) };
  }

  const page = readPhotoPage(query);
  if ('error' in page) {
    return page;
  }

  return {
    query: {
      tripId: tripIdParam === null ? undefined : tripIdParam === 'none' ? null : tripIdParam,
      category: categoryParam ?? undefined,
      favorite: favoriteParam === null ? undefined : true,
      ...page.page,
    },
  };
}

/**
 * 写真のページの指定（limit・continuationToken）を読む。写真の一覧と図鑑の項目の詳細で同じ規則と文言（05 §5.2・§5.14）
 * @param query リクエストのクエリ
 * @returns 1ページの枚数と前のページの継続トークン（先頭からなら undefined）、または 400 の応答
 */
export function readPhotoPage(
  query: URLSearchParams
): { page: { limit: number; continuationToken: string | undefined } } | { error: HttpResponseInit } {
  const limit = readPageLimit(query.get('limit'), PHOTO_VALIDATION.PAGE_SIZE, PHOTO_VALIDATION.MAX_PAGE_SIZE);
  if (limit === null) {
    return { error: createValidationError(PHOTO_VALIDATION.ERROR_MESSAGES.LIMIT_INVALID) };
  }
  const continuationToken = query.get('continuationToken');
  // Cosmos の継続トークンは JSON。読めないものを SDK に渡すと code の無い Error になり 500 と区別できないので、ここで弾く
  if (continuationToken !== null && !isJson(continuationToken)) {
    return { error: createValidationError(PHOTO_VALIDATION.ERROR_MESSAGES.CONTINUATION_TOKEN_INVALID) };
  }
  return { page: { limit, continuationToken: continuationToken ?? undefined } };
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
 * 写真の移動（POST /api/photos/move）のボディを読んで検証する（docs/05_api_design.md §5.5 の表の順）
 *
 * 「旅行から外す」は tripId: null を明示させる（キーの省略と区別し、取り違えを検出する）
 * @param request リクエスト
 * @returns 検証を通った入力、または 400 の応答
 */
export async function readMoveInput(request: HttpRequest): Promise<{ input: MoveInput } | { error: HttpResponseInit }> {
  const read = await readJsonBody(request);
  if ('error' in read) {
    return read;
  }
  const body = read.body;
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

/** 検証を通った写真の更新の入力（無い項目は undefined） */
export interface PhotoUpdateInput {
  /** 前後の空白を除いたコメント。消すなら null */
  comment?: string | null;
  /** 名前の前後の空白を除いたタグ（置き換え。同じ名前も残す） */
  tags?: PhotoTag[];
  /** 利用者が手で決めたカテゴリ（分類の種類のどれか。02 §5 #53） */
  category?: string;
  /** 利用者が手で付ける撮影日時（タイムゾーン無し）。消すなら null（02 §5 #59） */
  takenAt?: string | null;
  /** お気に入りの印（02 §5 #63） */
  favorite?: boolean;
}

/** お気に入りの指定が無効なときの文言（写真の一覧と更新で同じ。05 §5.2・§5.6） */
const FAVORITE_INVALID_MESSAGE = 'お気に入りの指定が無効です';

/**
 * 写真の更新（PATCH /api/photos/{photoId}）のボディを読んで検証する（docs/05_api_design.md §5.6 の 2〜9）
 *
 * コメントは前後の空白を除いてから数え、空なら null（消す）と同じ。タグは名前の前後の空白を除いてから数え、
 * 同じ名前のタグも除かない（皿が2つなど。02 §5 #57）
 * @param request リクエスト
 * @returns 検証を通った入力、または 400 の応答
 */
export async function readPhotoUpdateInput(
  request: HttpRequest
): Promise<{ input: PhotoUpdateInput } | { error: HttpResponseInit }> {
  const read = await readJsonBody(request);
  if ('error' in read) {
    return read;
  }
  const body = read.body;
  if (body === null || body === undefined) {
    return { error: createValidationError('リクエストボディが指定されていません') };
  }
  const { comment, tags, category, takenAt, favorite } = body as {
    comment?: unknown;
    tags?: unknown;
    category?: unknown;
    takenAt?: unknown;
    favorite?: unknown;
  };
  if (comment === undefined && tags === undefined && category === undefined && takenAt === undefined && favorite === undefined) {
    return { error: createValidationError('更新する項目が指定されていません') };
  }
  const input: PhotoUpdateInput = {};
  if (comment !== undefined) {
    if (comment !== null && typeof comment !== 'string') {
      return { error: createValidationError('コメントは文字列で指定してください') };
    }
    const trimmed = comment === null ? null : trimUserText(comment);
    if (trimmed !== null && exceedsLength(trimmed, PHOTO_VALIDATION.MAX_LENGTH.COMMENT)) {
      return { error: createValidationError(PHOTO_VALIDATION.ERROR_MESSAGES.COMMENT_TOO_LONG) };
    }
    input.comment = trimmed === '' ? null : trimmed;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) {
      return { error: createValidationError('タグは配列で指定してください') };
    }
    // 数は要素の中身より先に見る（大きな配列を、全部の要素を確かめてから断らない）
    if (tags.length > TAG_VALIDATION.MAX_COUNT) {
      return { error: createValidationError(TAG_VALIDATION.ERROR_MESSAGES.TOO_MANY) };
    }
    const parsedTags: PhotoTag[] = [];
    for (const tag of tags) {
      const result = readPhotoTag(tag);
      if (typeof result === 'string') {
        return { error: createValidationError(result) };
      }
      parsedTags.push(result);
    }
    input.tags = parsedTags;
  }
  if (category !== undefined) {
    if (typeof category !== 'string' || !PHOTO_KINDS.includes(category)) {
      return { error: createValidationError('カテゴリが無効です') };
    }
    input.category = category;
  }
  if (takenAt !== undefined) {
    // 写真の送信と同じく、タイムゾーン無しの実在する日時
    if (takenAt !== null && (typeof takenAt !== 'string' || !isExistingDateTime(takenAt))) {
      return { error: createValidationError('撮影日時の形式が無効です') };
    }
    input.takenAt = takenAt;
  }
  if (favorite !== undefined) {
    if (typeof favorite !== 'boolean') {
      return { error: createValidationError(FAVORITE_INVALID_MESSAGE) };
    }
    input.favorite = favorite;
  }
  return { input };
}

/**
 * タグ1つを読んで検証する（05 §5.6 の 8〜9.2。出どころ（C-4）は名前より先に見る）。名前・種類・位置・出どころだけを取り出し、ほかのキーは捨てる
 * @returns 検証を通ったタグ、または 400 の理由の文言
 */
function readPhotoTag(tag: unknown): PhotoTag | string {
  if (typeof tag !== 'object' || tag === null || Array.isArray(tag)) {
    return TAG_VALIDATION.ERROR_MESSAGES.INVALID_SHAPE;
  }
  const { name, kind, x, y, source } = tag as { name?: unknown; kind?: unknown; x?: unknown; y?: unknown; source?: unknown };
  // 出どころは省けば利用者のもの（アプリの送り方は 05 §5.6）
  if (source !== undefined && source !== 'ai' && source !== 'user') {
    return TAG_VALIDATION.ERROR_MESSAGES.INVALID_SHAPE;
  }
  const trimmed = typeof name === 'string' ? trimUserText(name) : '';
  if (trimmed === '' || exceedsLength(trimmed, TAG_VALIDATION.MAX_LENGTH)) {
    return TAG_VALIDATION.ERROR_MESSAGES.INVALID_LENGTH;
  }
  if (!isPhotoKind(kind)) {
    return TAG_VALIDATION.ERROR_MESSAGES.INVALID_KIND;
  }
  if (!isRatio(x) || !isRatio(y)) {
    return TAG_VALIDATION.ERROR_MESSAGES.INVALID_POSITION;
  }
  return { name: trimmed, kind, x, y, source: source ?? 'user' };
}

/** 画像の中の位置の割合（0 以上 1 以下の数）か */
function isRatio(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** 検証を通った解析のやり直しの入力 */
export interface ProcessRequestInput {
  /** やり直す処理（分類からか、名前の識別だけか） */
  step: 'classify' | 'identify';
  /** 利用者からの手がかり（前後の空白を除いたもの）。無ければ null */
  hint: string | null;
  /** 撮影地の地名（前後の空白を除いたもの。空なら null で消す）。送られなければ undefined（撮影地を変えない） */
  placeName?: string | null;
}

/**
 * 解析のやり直し（POST /api/photos/{photoId}/process）のボディを読んで検証する（docs/05_api_design.md §5.7 の 2〜6）
 * @param request リクエスト
 * @returns 検証を通った入力、または 400 の応答
 */
export async function readProcessRequestInput(
  request: HttpRequest
): Promise<{ input: ProcessRequestInput } | { error: HttpResponseInit }> {
  const read = await readJsonBody(request);
  if ('error' in read) {
    return read;
  }
  const body = read.body;
  if (body === null || body === undefined) {
    return { error: createValidationError('リクエストボディが指定されていません') };
  }
  const { step, hint, placeName } = body as { step?: unknown; hint?: unknown; placeName?: unknown };
  if (step !== 'classify' && step !== 'identify') {
    return { error: createValidationError('やり直す処理の種類が無効です') };
  }
  if (hint !== undefined && hint !== null && typeof hint !== 'string') {
    return { error: createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.NOT_A_STRING) };
  }
  const trimmed = typeof hint === 'string' ? trimUserText(hint) : '';
  if (exceedsLength(trimmed, CONTEXT_INFO_VALIDATION.MAX_LENGTH)) {
    return { error: createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.TOO_LONG) };
  }
  const input: ProcessRequestInput = { step, hint: trimmed === '' ? null : trimmed };
  if (placeName !== undefined) {
    if (placeName !== null && typeof placeName !== 'string') {
      return { error: createValidationError(PHOTO_VALIDATION.ERROR_MESSAGES.PLACE_NAME_NOT_A_STRING) };
    }
    const trimmedPlace = placeName === null ? '' : trimUserText(placeName);
    if (exceedsLength(trimmedPlace, PHOTO_VALIDATION.MAX_LENGTH.PLACE_NAME)) {
      return { error: createValidationError(PHOTO_VALIDATION.ERROR_MESSAGES.PLACE_NAME_INVALID) };
    }
    input.placeName = trimmedPlace === '' ? null : trimmedPlace;
  }
  return { input };
}
