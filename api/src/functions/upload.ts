import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { StorageService } from '../services/storageService';
import { OpenAIVisionService } from '../services/openAIVisionService';
import { 
  createSuccessResponse, 
  createErrorResponse, 
  createInternalError,
  createValidationError,
  createUpstreamErrorResponse
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { FILE_UPLOAD, CONTEXT_INFO_VALIDATION } from '../constants/validation';
import { UpstreamError } from '../utils/errors';

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
    // formData.get() は File も返しうる。as string のキャストは実行時に何も
    // 保証しないため、unknown で受けて下のバリデーションで型を絞る
    const rawContextInfo: unknown = formData.get('contextInfo');

    // ファイルの存在チェック
    // テキストフィールドとして送られた場合も弾く（type を持たないため、
    // 後続の形式検証が型エラーになり500を返してしまう）
    if (!file || typeof file.type !== 'string' || typeof file.arrayBuffer !== 'function') {
      return createValidationError('画像ファイルが指定されていません', 'imageフィールドでファイルを送信してください');
    }

    context.log(`画像処理開始: ファイル名=${file.name}, サイズ=${file.size}, タイプ=${file.type}`);

    // ファイルタイプの検証
    if (!StorageService.isValidImageContentType(file.type)) {
      return createErrorResponse(
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        'サポートされていない画像形式です',
        HttpStatusCode.UNSUPPORTED_MEDIA_TYPE,
        FILE_UPLOAD.ERROR_MESSAGES.UNSUPPORTED_TYPE
      );
    }

    // ファイルサイズの検証。空のファイルは入力の誤りとして 400 に分ける。
    // isValidFileSize() は 0 も偽にするため、先に判定しないと「大きすぎます」の 413 になる
    if (file.size === 0) {
      return createValidationError('画像ファイルが空です');
    }
    if (!StorageService.isValidFileSize(file.size)) {
      return createErrorResponse(
        ErrorCode.FILE_TOO_LARGE,
        'ファイルサイズが大きすぎます',
        HttpStatusCode.PAYLOAD_TOO_LARGE,
        FILE_UPLOAD.ERROR_MESSAGES.SIZE_EXCEEDED
      );
    }

    // 補足情報の検証。
    // プロンプトに埋め込まれるため、一時保存とOpenAI呼び出しの前に弾く。
    // 型を見ずに .length を比較すると、File では undefined が比較対象になり
    // 長さの上限を素通りしてプロンプトに混ざる
    if (rawContextInfo !== null && rawContextInfo !== undefined) {
      if (typeof rawContextInfo !== 'string') {
        return createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.NOT_A_STRING);
      }
      if (rawContextInfo.length > CONTEXT_INFO_VALIDATION.MAX_LENGTH) {
        return createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.TOO_LONG);
      }
    }
    // ここ以降は文字列か未指定であることが保証されている
    const contextInfo = typeof rawContextInfo === 'string' ? rawContextInfo : undefined;

    // ファイルをBufferに変換
    const arrayBuffer = await file.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    // ストレージと AI 識別サービスを、何かを保存する前に作る。設定の誤り（BlobEndpoint のある接続文字列、
    // Azure のデプロイ名の書き忘れ）はコンストラクタで例外になるので、一時コンテナに画像を残さずに失敗できる
    const storageService = new StorageService();
    const visionService = new OpenAIVisionService();
    
    // 1. 画像を一時保存
    const tempImageUrl = await storageService.uploadImageToTemp(imageBuffer, file.type);
    // クエリ文字列の SAS は画像の読み取り権限そのもので、ログを読める人に渡してしまうため、
    // ログにはパスまでを出す
    context.log(`一時保存完了: URL=${tempImageUrl.split('?')[0]}`);

    // 2. 植物判定実行

    // LLMで植物識別実行（コンテキスト情報があれば渡す）
    const identificationResult = await visionService.identifyPlant(tempImageUrl, contextInfo);
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
    
    // AI 識別サービス・Blob Storage の呼び出しで起きたエラー。identify.ts と同じく、
    // メッセージの文字列ではなく、どこで失敗したか（UpstreamError の service）で分類する。
    // AI とストレージは service で区別されるので、AI に接続できない障害が
    // 「ストレージに接続できません」と報告されることはない
    if (error instanceof UpstreamError) {
      return createUpstreamErrorResponse(error);
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