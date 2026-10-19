import OpenAI from "openai";

/**
 * analyze() に渡すもの（送り先のデプロイはコンストラクタで決める）
 *
 * 応答の構造は Structured Outputs（strict）で強制する。strict モードの制約が、呼び出し側のスキーマと検証の作りを縛る:
 * - 全プロパティを required に含める必要があるため、任意項目は ["string", "null"] のように null 許容で表現する
 * - minimum/maximum/maxItems は使用できないため、信頼度の範囲などはスキーマでは強制できず、呼び出し側が応答を検証する
 *   （写真の分類は photoClassifierService、識別は photoIdentifierService）
 */
export interface AnalyzeRequest {
	/** Structured Outputs のスキーマの名前 */
	schemaName: string;
	/** Structured Outputs のスキーマ（strict） */
	schema: Record<string, unknown>;
	prompt: string;
	imageUrl: string;
}

export class OpenAIVisionService {
	/** 送り先のデプロイ名（Azure では接続先の URL にも入る） */
	readonly deployment: string;
	private readonly client: OpenAI;

	/**
	 * 送り先のデプロイを決め、クライアントを作る
	 *
	 * 設定の誤り（デプロイ名が無い、SDK がキーの無いときに投げる例外）はここで投げる。
	 * analyze() の中で作ると、呼び出し側が AI の失敗（UpstreamError）に包んで AI の障害に見える
	 *
	 * @param deployment 送り先のデプロイ名。省略・空・空白だけなら AZURE_OPENAI_DEPLOYMENT_NAME（今のデプロイ）
	 */
	constructor(deployment?: string) {
		// アプリの設定に紛れた空白や改行のまま URL に入れると Azure の 404 になるので、前後を落とす
		const name = deployment?.trim() || process.env.AZURE_OPENAI_DEPLOYMENT_NAME?.trim();

		// Azure OpenAI または OpenAI APIの設定
		if (process.env.AZURE_OPENAI_ENDPOINT) {
			// デプロイ名は接続先の URL に入る。無いと .../deployments/undefined に送って Azure の 404 になり、
			// 設定の書き忘れが AI の障害（502）に見える。AI を呼ぶ前に、設定の誤りとして止める（docs/06 §5.9）
			if (!name) {
				throw new Error(
					deployment === undefined
						? 'AZURE_OPENAI_DEPLOYMENT_NAME（Azure OpenAI Service のデプロイ名）が設定されていません'
						: '送り先のデプロイ名が設定されていません（指定されたデプロイ名も AZURE_OPENAI_DEPLOYMENT_NAME も空です）'
				);
			}
			this.deployment = name;
			this.client = new OpenAI({
				apiKey: process.env.AZURE_OPENAI_API_KEY!,
				baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${name}`,
				defaultQuery: {
					"api-version":
						process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
				},
				defaultHeaders: {
					"api-key": process.env.AZURE_OPENAI_API_KEY!,
				},
			});
		} else {
			this.deployment = name || "gpt-5.6-luna";
			this.client = new OpenAI({
				apiKey: process.env.OPENAI_API_KEY!,
			});
		}
	}

	/**
	 * プロンプトと画像を渡して Structured Outputs で答えさせ、JSON として読んだ応答を返す
	 *
	 * 応答の中身の検証は呼び出し側が行う（スキーマの strict では範囲などを強制できないため）
	 */
	async analyze(request: AnalyzeRequest): Promise<unknown> {
		const response = await this.client.chat.completions.create({
			model: this.deployment,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: request.prompt },
						{
							type: "image_url",
							image_url: {
								url: request.imageUrl,
								detail: "low", // トークン消費を抑制
							},
						},
					],
				},
			],
			// reasoning モデルは推論トークンも max_completion_tokens から消費するため余裕を持たせる
			max_completion_tokens: 4000,
			// temperature は指定しない（このモデルはデフォルト値(1)のみサポート）
			// JSON形式に加えて、フィールド構成・型・必須項目までモデル側で強制する
			response_format: {
				type: "json_schema",
				json_schema: {
					name: request.schemaName,
					strict: true,
					schema: request.schema,
				},
			},
		});

		const content = response.choices[0].message.content;
		if (!content) {
			throw new Error("LLMからの応答が空です");
		}

		try {
			return JSON.parse(content);
		} catch (parseError) {
			throw new Error(`LLM応答のJSONパースに失敗しました: ${parseError}`);
		}
	}
}
