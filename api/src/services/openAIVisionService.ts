import OpenAI from "openai";
import { LLMAnalysisResult, IdentificationResult } from "../types/plant";
import { UpstreamError } from "../utils/errors";

/**
 * 応答の構造を強制する JSON Schema（Structured Outputs）
 *
 * strict モードの制約：
 * - 全プロパティを required に含める必要があるため、
 *   任意項目は ["string", "null"] のように null 許容で表現する
 * - minimum/maximum/maxItems は使用できないため、
 *   信頼度の範囲チェックと候補数の上限はスキーマでは強制できない
 *   （範囲は validateAnalysisResult、候補数はプロンプトで担保）
 */
const PLANT_IDENTIFICATION_SCHEMA = {
	type: "object",
	properties: {
		isPlant: {
			type: "boolean",
			description: "この画像に植物（またはその一部）が写っているか",
		},
		confidence: {
			type: "number",
			description: "植物判定の信頼度（0-100）",
		},
		reason: {
			type: "string",
			description: "判定理由（日本語で簡潔に）",
		},
		plantAnalysis: {
			type: ["object", "null"],
			description: "植物の場合のみ設定し、植物でない場合は null",
			properties: {
				candidates: {
					type: "array",
					description: "可能性の高い候補を最大3つ、信頼度の高い順に並べる",
					items: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description:
									"植物名（日本語）。命名規則に従って品種名・種名・属名のいずれかを設定する",
							},
							scientificName: {
								type: ["string", "null"],
								description: "学名。特定できない場合は null",
							},
							familyName: {
								type: ["string", "null"],
								description: "科名（日本語）。特定できない場合は null",
							},
							description: {
								type: ["string", "null"],
								description: "詳細説明（日本語）。不明な場合は null",
							},
							characteristics: {
								type: "string",
								description: "見た目の特徴(日本語)",
							},
							confidence: {
								type: "number",
								description: "この候補の信頼度（0-100）",
							},
						},
						required: [
							"name",
							"scientificName",
							"familyName",
							"description",
							"characteristics",
							"confidence",
						],
						additionalProperties: false,
					},
				},
			},
			required: ["candidates"],
			additionalProperties: false,
		},
	},
	required: ["isPlant", "confidence", "reason", "plantAnalysis"],
	additionalProperties: false,
} as const;

/** analyze() に渡すもの（送り先のデプロイはコンストラクタで決める） */
export interface AnalyzeRequest {
	/** Structured Outputs のスキーマの名前 */
	schemaName: string;
	/** Structured Outputs のスキーマ（strict） */
	schema: Record<string, unknown>;
	prompt: string;
	imageUrl: string;
}

/**
 * 植物の識別のプロンプト
 *
 * 応答の構造は PLANT_IDENTIFICATION_SCHEMA で強制されるため、プロンプトでは判定基準と命名規則のみを指示する
 */
function plantIdentificationPrompt(contextInfo?: string): string {
	const contextSection = contextInfo ? `
    追加情報：
    撮影時の環境やコンテキスト情報: ${contextInfo}
    この情報を参考にして、植物の識別精度を向上させてください。
    ` : '';

	return `
    この画像を専門的に分析して、植物かどうかを判定してください。
${contextSection}
    植物と判定する例：
    - 花、葉、茎、根、樹皮、果実、種子
    - 木、草、花、苔、シダ、多肉植物、サボテン
    - 野菜、ハーブなどの植物

    植物でないと判定する例：
    - 人、動物、建物、食べ物（調理済み）、風景のみ
    - 植物が全く写っていない場合

    重要な植物名の命名規則：
    「name」フィールドには以下の優先順位で植物名を設定してください：
    1. 品種名がわかる場合：品種名を植物名とする（例：「染井吉野」「関山」「八重桜」など）
    2. 品種名がわからないが種名がわかる場合：種名を植物名とする（例：「ヤマザクラ」「ススキ」「オオバコ」など）
    3. 種名も特定できない場合：属名を植物名とする（例：「サクラ属」「バラ属」「キク属」など）

    植物の場合、可能性の高い候補を最大3つ、信頼度順に返してください。
    日本の植物に詳しく、正確な学名と科名を含めてください。
    各候補の「name」は上記の命名規則に従って設定してください。
    `;
}

export class OpenAIVisionService {
	/** 送り先のデプロイ名（Azure では接続先の URL にも入る） */
	readonly deployment: string;
	private readonly client: OpenAI;

	/**
	 * 送り先のデプロイを決め、クライアントを作る
	 *
	 * 設定の誤り（デプロイ名が無い、SDK がキーの無いときに投げる例外）はここで投げる。
	 * analyze() の中で作ると、呼び出し側が AI の失敗（UpstreamError）に包んで AI の障害（502）に見えるうえ、
	 * アップロードは一時コンテナに画像を置いた後で気づくことになる
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
				throw new Error('AZURE_OPENAI_DEPLOYMENT_NAME（Azure OpenAI Service のデプロイ名）が設定されていません');
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

	/**
	 * 画像を分析して植物かどうか判定し、植物の場合は識別結果を返す
	 */
	async identifyPlant(imageUrl: string, contextInfo?: string): Promise<IdentificationResult> {
		try {
			const parsed = await this.analyze({
				schemaName: "plant_identification",
				schema: PLANT_IDENTIFICATION_SCHEMA,
				prompt: plantIdentificationPrompt(contextInfo),
				imageUrl,
			});
			// 検証は analyze() の JSON の読み取りとは分けて置く。一緒にすると、JSON としては正しいのに
			// 中身が不正な応答まで「JSONパースに失敗しました」と記録され、原因の調査を誤らせる
			const analysisResult = this.normalizeNulls(parsed);
			this.validateAnalysisResult(analysisResult);

			return {
				isPlant: analysisResult.isPlant,
				confidence: analysisResult.confidence,
				reason: analysisResult.reason,
				candidates:
					analysisResult.isPlant && analysisResult.plantAnalysis
						? analysisResult.plantAnalysis.candidates
						: [],
			};
		} catch (error: any) {
			throw new UpstreamError(`植物識別に失敗しました: ${error.message}`, "ai", error);
		}
	}

	/**
	 * スキーマの null 許容項目を undefined に正規化する
	 *
	 * strict モードでは任意項目を required + null 許容で表現する必要があるため、
	 * 「不明」を表す null が返る。既存の型（任意プロパティ）に合わせて undefined にする。
	 */
	private normalizeNulls(parsed: any): LLMAnalysisResult {
		const result: LLMAnalysisResult = {
			isPlant: parsed.isPlant,
			confidence: parsed.confidence,
			reason: parsed.reason,
		};

		if (parsed.plantAnalysis) {
			result.plantAnalysis = {
				candidates: (parsed.plantAnalysis.candidates ?? []).map((candidate: any) => ({
					name: candidate.name,
					characteristics: candidate.characteristics,
					confidence: candidate.confidence,
					scientificName: candidate.scientificName ?? undefined,
					familyName: candidate.familyName ?? undefined,
					description: candidate.description ?? undefined,
				})),
			};
		}

		return result;
	}

	/**
	 * LLM分析結果のバリデーション
	 */
	private validateAnalysisResult(result: any): void {
		if (typeof result.isPlant !== "boolean") {
			throw new Error("isPlantがboolean型ではありません");
		}

		if (
			typeof result.confidence !== "number" ||
			result.confidence < 0 ||
			result.confidence > 100
		) {
			throw new Error("confidenceが0-100の範囲の数値ではありません");
		}

		if (typeof result.reason !== "string") {
			throw new Error("reasonが文字列ではありません");
		}

		if (result.isPlant && result.plantAnalysis) {
			for (const candidate of result.plantAnalysis.candidates) {
				if (!candidate.name || !candidate.characteristics) {
					throw new Error("候補に必須フィールドが不足しています");
				}
				if (typeof candidate.confidence !== "number") {
					throw new Error("候補の信頼度が数値ではありません");
				}
				// strict モードのスキーマでは minimum / maximum を書けないため、範囲はここで検査する。
				// 範囲外の値をそのまま返すと、仕様（PlantCandidate.confidence は 0〜100）に反した値が
				// クライアントに渡り、保存時の検証（0〜100）で弾かれる
				if (candidate.confidence < 0 || candidate.confidence > 100) {
					throw new Error("候補の信頼度が0-100の範囲ではありません");
				}
			}
		}
	}
}
