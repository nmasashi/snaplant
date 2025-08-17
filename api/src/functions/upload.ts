import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { StorageService } from '../services/storageService';
import { OpenAIVisionService } from '../services/openAIVisionService';
import { 
  createSuccessResponse, 
  createErrorResponse, 
  createInternalError,
  createValidationError
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { FILE_UPLOAD } from '../constants/validation';

/**
 * 画像アップロード・植物判定統合 API
 * POST /api/images/upload?code={FUNCTION_KEY}
 */
export async function uploadImageHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('画像アップロード・植物判定リクエストを受信');

  try {
    // Content-Typeをチェック
    const contentType = request.headers.get('content-type');
    if (!contentType || !contentType.startsWith('multipart/form-data')) {
      return createValidationError(
        'Content-Typeがmultipart/form-dataではありません',
        'multipart/form-dataでファイルを送信してください'
      );
    }

    // リクエストボディを取得
    const formData = await request.formData();
    const file = formData.get('image') as File;
    const contextInfo = formData.get('contextInfo') as string | null;

    // ファイルの存在チェック
    if (!file) {
      return createValidationError('画像ファイルが指定されていません', 'imageフィールドでファイルを送信してください');
    }

    context.log(`画像処理開始: ファイル名=${file.name}, サイズ=${file.size}, タイプ=${file.type}`);

    // ファイルタイプの検証
    if (!StorageService.isValidImageContentType(file.type)) {
      return createValidationError(
        'サポートされていない画像形式です',
        FILE_UPLOAD.ERROR_MESSAGES.UNSUPPORTED_TYPE
      );
    }

    // ファイルサイズの検証
    if (!StorageService.isValidFileSize(file.size)) {
      return createValidationError(
        'ファイルサイズが大きすぎます',
        FILE_UPLOAD.ERROR_MESSAGES.SIZE_EXCEEDED
      );
    }

    // ファイルをBufferに変換
    const arrayBuffer = await file.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    // ストレージサービス初期化
    const storageService = new StorageService();
    
    // 1. 画像を一時保存
    const tempImageUrl = await storageService.uploadImageToTemp(imageBuffer, file.name, file.type);
    context.log(`一時保存完了: URL=${tempImageUrl}`);

    // 2. AI識別サービス初期化・植物判定実行
    const visionService = new OpenAIVisionService();
    
    // 画像の有効性チェック
    const isValidImage = await visionService.validateImage(tempImageUrl);
    if (!isValidImage) {
      // 無効な画像の場合、一時ファイルを削除
      await storageService.deleteImage(tempImageUrl);
      return createValidationError('画像の解析に失敗しました', '有効な画像URLを指定してください');
    }

    // LLMで植物識別実行（コンテキスト情報があれば渡す）
    const identificationResult = await visionService.identifyPlant(tempImageUrl, contextInfo || undefined);
    context.log(`植物識別完了: 植物=${identificationResult.isPlant}, 候補数=${identificationResult.candidates.length}`);

    // 3. 植物判定結果による分岐処理
    if (!identificationResult.isPlant) {
      // 植物でない場合: 一時ファイルを削除してエラー返却
      await storageService.deleteImage(tempImageUrl);
      context.log('植物でない画像として判定、一時ファイル削除完了');
      
      return createErrorResponse(
        ErrorCode.NOT_A_PLANT,
        'アップロードされた画像は植物ではありません',
        HttpStatusCode.BAD_REQUEST,
        '植物の画像を選択して再度お試しください'
      );
    }

    // 4. 植物の場合: 一時保存→永続保存に移動
    const permanentImageUrl = await storageService.moveFromTempToPermanent(tempImageUrl);
    context.log(`永続保存完了: URL=${permanentImageUrl}`);

    // 5. 統合レスポンス返却
    return createSuccessResponse({
      imagePath: permanentImageUrl,
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size,
      identificationResult: {
        isPlant: identificationResult.isPlant,
        confidence: identificationResult.confidence,
        candidates: identificationResult.candidates
      }
    }, HttpStatusCode.CREATED);

  } catch (error: any) {
    context.log('画像アップロード・植物判定エラー:', error);
    
    // OpenAI API関連エラー
    if (error.message.includes('OpenAI') || error.message.includes('LLM') || error.code === 'insufficient_quota') {
      return createErrorResponse(
        ErrorCode.AI_SERVICE_ERROR,
        '植物識別サービスでエラーが発生しました',
        HttpStatusCode.BAD_GATEWAY,
        error.message
      );
    }

    // Azure Storage関連エラー
    if (error.message.includes('Storage') || error.code === 'ENOTFOUND') {
      return createErrorResponse(
        ErrorCode.STORAGE_ERROR,
        'ストレージサービスでエラーが発生しました',
        HttpStatusCode.BAD_GATEWAY,
        error.message
      );
    }

    // ネットワークエラー
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return createErrorResponse(
        ErrorCode.STORAGE_ERROR,
        'ストレージサービスに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    // ファイル処理エラー
    if (error.name === 'TypeError' && error.message.includes('formData')) {
      return createValidationError('ファイルの読み取りに失敗しました', '有効なmultipart/form-dataを送信してください');
    }

    return createInternalError('画像アップロード・植物判定に失敗しました', error.message);
  }
}

// Azure Functions への登録
app.http('upload', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'images/upload',
  handler: uploadImageHandler
});