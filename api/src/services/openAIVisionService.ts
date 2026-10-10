import OpenAI from "openai";
import { LLMAnalysisResult, IdentificationResult } from "../types/plant";
import { wrapError } from "../utils/errors";

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

export class OpenAIVisionService {
	private client: OpenAI;

	constructor() {
		// Azure OpenAI または OpenAI APIの設定
		const isAzure = !!process.env.AZURE_OPENAI_ENDPOINT;

		if (isAzure) {
			this.client = new OpenAI({
				apiKey: process.env.AZURE_OPENAI_API_KEY!,
				baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}`,
				defaultQuery: {
					"api-version":
						process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
				},
				defaultHeaders: {
					"api-key": process.env.AZURE_OPENAI_API_KEY!,
				},
			});
		} else {
			this.client = new OpenAI({
				apiKey: process.env.OPENAI_API_KEY!,
			});
		}
	}

	/**
	 * 画像を分析して植物かどうか判定し、植物の場合は識別結果を返す
	 */
	async identifyPlant(imageUrl: string, contextInfo?: string): Promise<IdentificationResult> {
		try {
			const analysisResult = await this.analyzeImage(imageUrl, contextInfo);

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
			throw wrapError(`植物識別に失敗しました: ${error.message}`, error);
		}
	}

	/**
	 * LLMを使用して画像を分析
	 */
	private async analyzeImage(imageUrl: string, contextInfo?: string): Promise<LLMAnalysisResult> {
		const contextSection = contextInfo ? `
    追加情報：
    撮影時の環境やコンテキスト情報: ${contextInfo}
    この情報を参考にして、植物の識別精度を向上させてください。
    ` : '';

		// 応答の構造は PLANT_IDENTIFICATION_SCHEMA で強制されるため、
		// プロンプトでは判定基準と命名規則のみを指示する
		const prompt = `
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

		const response = await this.client.chat.completions.create({
			model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "gpt-5.6-luna",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{
							type: "image_url",
							image_url: {
								url: imageUrl,
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
					name: "plant_identification",
					strict: true,
					schema: PLANT_IDENTIFICATION_SCHEMA,
				},
			},
		});

		const content = response.choices[0].message.content;
		if (!content) {
			throw new Error("LLMからの応答が空です");
		}

		try {
			const result = this.normalizeNulls(JSON.parse(content));
			this.validateAnalysisResult(result);
			return result;
		} catch (parseError) {
			throw new Error(`LLM応答のJSONパースに失敗しました: ${parseError}`);
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
			if (!Array.isArray(result.plantAnalysis.candidates)) {
				throw new Error("candidatesが配列ではありません");
			}

			for (const candidate of result.plantAnalysis.candidates) {
				if (!candidate.name || !candidate.characteristics) {
					throw new Error("候補に必須フィールドが不足しています");
				}
				if (typeof candidate.confidence !== "number") {
					throw new Error("候補の信頼度が数値ではありません");
				}
			}
		}
	}

	/**
	 * 画像の有効性をチェック
	 */
	async validateImage(imageUrl: string): Promise<boolean> {
		try {
			// URLの形式チェック
			new URL(imageUrl);

			// OpenAI APIは画像の有効性を自動チェックするため、
			// 別途チェックは不要（呼び出し時にエラーになる）
			return true;
		} catch (error) {
			return false;
		}
	}
}
