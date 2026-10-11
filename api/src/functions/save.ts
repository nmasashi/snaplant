import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosService } from '../services/cosmosService';
import { StorageService } from '../services/storageService';
import { 
  createSuccessResponse, 
  createErrorResponse, 
  createInternalError,
  createValidationError,
  isPresentNonString
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { PlantCreateRequest } from '../types/plant';
import { PLANT_VALIDATION, GENERAL_VALIDATION } from '../constants/validation';

/**
 * 植物保存 API
 * POST /api/plants/save?code={FUNCTION_KEY}
 */
export async function savePlantHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物保存リクエストを受信');

  try {
    // リクエストボディの取得
    const requestBody = await request.json() as PlantCreateRequest;
    
    // バリデーション
    const validationError = validatePlantCreateRequest(requestBody);
    if (validationError) {
      return validationError;
    }

    // 保存される値（前後の空白を除いた名前）を出す。そのまま出すと、
    // ログの名前と保存された名前が食い違い、重複の調査で突き合わせられない
    context.log(`植物保存開始: 名前=${requestBody.name.trim()}`);

    // 植物オブジェクト作成
    //
    // id と日時は設定しない。CosmosService.createPlant() の責務で、
    // 引数の型が PlantCreateRequest（id も日時も持たない）であることが
    // その設計を示している。
    //
    // 以前はここでも uuidv4() と日時を設定していたが、createPlant() が
    // `{ id: generateId(), ...plantData, createdAt: now, updatedAt: now }` と
    // 組み立てるため、スプレッドの位置で勝ち負けが決まる状態だった。
    // 日時はハンドラ側が常に捨てられる死んだコードで、id が生き残るのは
    // generateId() がスプレッドの前に置かれているという記述順の偶然だった
    const newPlant: PlantCreateRequest = {
      // check-duplicate は name の前後の空白を除いて比較するので、保存側も揃える
      name: requestBody.name.trim(),
      scientificName: requestBody.scientificName,
      familyName: requestBody.familyName,
      description: requestBody.description,
      characteristics: requestBody.characteristics,
      confidence: requestBody.confidence,
      imagePath: requestBody.imagePath
    };

    // Cosmos DBサービス初期化
    const cosmosService = new CosmosService();
    
    // imagePath の重複チェック。
    // 同じ imagePath を持つレコードが2つできると、一方を削除または別の画像に
    // 更新した時点で、もう一方の画像まで消えてしまう。発生経路はリトライで、
    // 保存に成功したがレスポンスが届かず同じ imagePath で再送されるケース
    const existingByImage = await cosmosService.getPlantsByImagePath(newPlant.imagePath);
    if (existingByImage.length > 0) {
      return createErrorResponse(
        ErrorCode.IMAGE_ALREADY_SAVED,
        'この画像は既に保存されています',
        HttpStatusCode.CONFLICT
      );
    }

    // 植物保存
    const savedPlant = await cosmosService.createPlant(newPlant);
    
    context.log(`植物保存成功: ID=${savedPlant.id}, 名前=${savedPlant.name}`);
    
    return createSuccessResponse({
      plant: savedPlant
    }, HttpStatusCode.CREATED);

  } catch (error: any) {
    context.log('植物保存エラー:', error);
    
    // Cosmos DB関連エラー
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        'データベースに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    // Cosmos DB制約エラー（重複など）
    if (error.code === 409) {
      return createErrorResponse(
        ErrorCode.DATABASE_ERROR,
        '植物の保存に失敗しました',
        HttpStatusCode.CONFLICT,
        error.message
      );
    }

    // JSONパースエラー
    if (error instanceof SyntaxError) {
      return createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください');
    }

    return createInternalError('植物の保存に失敗しました', error.message);
  }
}

/**
 * 植物作成リクエストのバリデーション
 */
function validatePlantCreateRequest(request: PlantCreateRequest): HttpResponseInit | null {
  if (!request) {
    return createValidationError('リクエストボディが指定されていません');
  }

  // 型のチェック。以降の .trim() / .length より前に置く。
  // 文字列以外を通すと、必須項目は .trim() の TypeError で 500 になり、
  // 任意項目は上限の検査をすり抜けてそのまま保存される。
  // 任意項目の null と未指定は「指定なし」として通す（Flutter は空の任意項目を null で送る）
  const stringFields: Array<[keyof PlantCreateRequest, string]> = [
    ['name', '植物名'],
    ['characteristics', '特徴'],
    ['imagePath', '画像パス'],
    ['scientificName', '学名'],
    ['familyName', '科名'],
    ['description', '説明']
  ];
  for (const [field, label] of stringFields) {
    if (isPresentNonString(request[field])) {
      return createValidationError(`${label}は文字列で指定してください`);
    }
  }

  // 必須フィールドのチェック
  if (!request.name || request.name.trim().length === 0) {
    return createValidationError('植物名が指定されていません');
  }

  if (!request.characteristics || request.characteristics.trim().length === 0) {
    return createValidationError('特徴が指定されていません');
  }

  if (!request.imagePath || request.imagePath.trim().length === 0) {
    return createValidationError('画像パスが指定されていません');
  }

  if (typeof request.confidence !== 'number' || 
      request.confidence < PLANT_VALIDATION.CONFIDENCE.MIN || 
      request.confidence > PLANT_VALIDATION.CONFIDENCE.MAX) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.CONFIDENCE_OUT_OF_RANGE);
  }

  // 文字列長のチェック
  // 保存されるのは前後の空白を取り除いた値なので、同じものの長さで判定する
  if (request.name.trim().length > PLANT_VALIDATION.MAX_LENGTH.NAME) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.NAME_TOO_LONG);
  }

  if (request.scientificName && request.scientificName.length > PLANT_VALIDATION.MAX_LENGTH.SCIENTIFIC_NAME) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.SCIENTIFIC_NAME_TOO_LONG);
  }

  if (request.familyName && request.familyName.length > PLANT_VALIDATION.MAX_LENGTH.FAMILY_NAME) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.FAMILY_NAME_TOO_LONG);
  }

  if (request.description && request.description.length > PLANT_VALIDATION.MAX_LENGTH.DESCRIPTION) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.DESCRIPTION_TOO_LONG);
  }

  if (request.characteristics.length > PLANT_VALIDATION.MAX_LENGTH.CHARACTERISTICS) {
    return createValidationError(PLANT_VALIDATION.ERROR_MESSAGES.CHARACTERISTICS_TOO_LONG);
  }

  // 自アカウントの永続コンテナを指すことのバリデーション。
  // URL としてパースできるかの検証は別に置かない。isValidImagePath() が
  // パース失敗も false にするため、前段を置くとメッセージが2種類に分かれるだけで
  // 同じ検証が2段になる
  if (!StorageService.isValidImagePath(request.imagePath)) {
    return createValidationError(GENERAL_VALIDATION.ERROR_MESSAGES.IMAGE_PATH_NOT_ALLOWED);
  }

  return null;
}

// Azure Functions への登録
app.http('save', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'plants/save',
  handler: savePlantHandler
});