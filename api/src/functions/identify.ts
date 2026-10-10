import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { OpenAIVisionService } from '../services/openAIVisionService';
import { 
  createSuccessResponse, 
  createErrorResponse, 
  createInternalError,
  createValidationError
} from '../utils/response';
import { HttpStatusCode, ErrorCode } from '../types/api';
import { IdentifyRequest } from '../types/plant';
import { GENERAL_VALIDATION, CONTEXT_INFO_VALIDATION } from '../constants/validation';

/**
 * 植物識別 API
 * POST /api/plants/identify?code={FUNCTION_KEY}
 */
export async function identifyPlantHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('植物識別リクエストを受信');

  try {
    // リクエストボディの取得
    const requestBody = await request.json() as IdentifyRequest;
    
    // バリデーション
    if (!requestBody || !requestBody.imagePath) {
      return createValidationError('画像URLが指定されていません');
    }

    // URL形式のバリデーション
    try {
      new URL(requestBody.imagePath);
    } catch (error) {
      return createValidationError('画像URLの形式が無効です', GENERAL_VALIDATION.ERROR_MESSAGES.INVALID_URL);
    }

    // 補足情報のバリデーション。
    // request.json() の値は型が保証されないため、まず文字列であることを要求する。
    // 型を見ずに .length を比較すると、配列では要素数が、数値では undefined が
    // 比較対象になり、長さの上限を素通りしてプロンプトに埋め込まれてしまう
    const contextInfo: unknown = requestBody.contextInfo;
    if (contextInfo !== undefined && contextInfo !== null) {
      if (typeof contextInfo !== 'string') {
        return createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.NOT_A_STRING);
      }
      if (contextInfo.length > CONTEXT_INFO_VALIDATION.MAX_LENGTH) {
        return createValidationError(CONTEXT_INFO_VALIDATION.ERROR_MESSAGES.TOO_LONG);
      }
    }

    context.log(`植物識別開始: 画像URL=${requestBody.imagePath}, コンテキスト情報=${requestBody.contextInfo || 'なし'}`);

    // OpenAI Visionサービス初期化
    const visionService = new OpenAIVisionService();
    
    // 画像の有効性チェック
    const isValidImage = await visionService.validateImage(requestBody.imagePath);
    if (!isValidImage) {
      return createValidationError('画像の解析に失敗しました', '有効な画像URLを指定してください');
    }

    // LLMで植物識別実行（コンテキスト情報があれば渡す）
    const identificationResult = await visionService.identifyPlant(requestBody.imagePath, requestBody.contextInfo);
    
    context.log(`植物識別完了: 植物=${identificationResult.isPlant}, 候補数=${identificationResult.candidates.length}`);
    
    return createSuccessResponse({
      result: identificationResult
    });

  } catch (error: any) {
    context.log('植物識別エラー:', error);
    
    // OpenAI API関連エラー
    if (error.message.includes('OpenAI') || error.message.includes('LLM') || error.code === 'insufficient_quota') {
      return createErrorResponse(
        ErrorCode.AI_SERVICE_ERROR,
        '植物識別サービスでエラーが発生しました',
        HttpStatusCode.BAD_GATEWAY,
        error.message
      );
    }


    // ネットワークエラー
    //
    // **現在この分岐は到達しない。** 理由は errno が深くネストしているため。
    // 実測したチェーン（openai 7.x / Node 20+ の native fetch）:
    //
    //   深さ0  APIConnectionError      code=undefined  "Connection error."
    //   深さ1  TypeError               code=undefined  "fetch failed"
    //   深さ2  Error                   code="ENOTFOUND"
    //
    // `APIConnectionError` は自分では `code` を設定せず、undici の
    // `TypeError: fetch failed` を `cause` に入れ、その `cause` に errno がある。
    // `wrapError()` は `cause.code` しか見ないので undefined のまま伝わり、
    // 未分類エラーとして 500 に落ちる。メッセージも `'Connection error.'` で
    // 上の `includes('OpenAI')` にも当たらない。
    //
    // 分岐自体は残している。直し方と注意点は docs/09_backlog.md の
    // 「`identify` の 503 分岐が実運用で到達しない」にある。
    // **チェーンを辿る修正は upload.ts の分類修正と同時に行うこと**
    // （単独で直すと OpenAI 障害が STORAGE_ERROR として報告される）。
    // **到達不能な今の状態をテストで埋めようとしないこと。**
    // 実SDKが作らない形（`cause` 1段だけ）のテストは通るが何も守らない
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return createErrorResponse(
        ErrorCode.AI_SERVICE_ERROR,
        '植物識別サービスに接続できません',
        HttpStatusCode.SERVICE_UNAVAILABLE,
        error.message
      );
    }

    // JSONパースエラー
    if (error instanceof SyntaxError) {
      return createValidationError('リクエストボディの形式が無効です', 'JSON形式で送信してください');
    }

    return createInternalError('植物識別処理に失敗しました', error.message);
  }
}

// Azure Functions への登録
app.http('identify', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'plants/identify',
  handler: identifyPlantHandler
});