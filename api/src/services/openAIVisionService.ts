import OpenAI from "openai";
import { LLMAnalysisResult, IdentificationResult } from "../types/plant";

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
						process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview",
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
	async identifyPlant(imageUrl: string): Promise<IdentificationResult> {
		try {
			const analysisResult = await this.analyzeImage(imageUrl);

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
			throw new Error(`植物識別に失敗しました: ${error.message}`);
		}
	}

	/**
	 * LLMを使用して画像を分析
	 */
	private async analyzeImage(imageUrl: string): Promise<LLMAnalysisResult> {
		const prompt = `
    この画像を専門的に分析して、以下の形式でJSONを返してください：

    {
      "isPlant": boolean,
      "confidence": number,
      "reason": "string",
      "plantAnalysis": {
        "candidates": [
          {
            "name": "植物名（日本語）",
            "scientificName": "学名",
            "familyName": "科名",
            "description": "詳細説明（日本語）",
            "characteristics": "見た目の特徴（日本語）",
            "confidence": number
          }
        ]
      }
    }

    判定基準：
    - isPlant: この画像に植物（またはその一部）が写っているか
    - confidence: 植物判定の信頼度（0-100）
    - reason: 判定理由（日本語で簡潔に）

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
			model: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "gpt-4-vision-preview",
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
			max_tokens: 1000,
			temperature: 0.1, // 一貫性を重視
			response_format: { type: "json_object" }, // JSON形式を強制
		});

		const content = response.choices[0].message.content;
		if (!content) {
			throw new Error("LLMからの応答が空です");
		}

		try {
			const result = JSON.parse(content) as LLMAnalysisResult;
			this.validateAnalysisResult(result);
			return result;
		} catch (parseError) {
			throw new Error(`LLM応答のJSONパースに失敗しました: ${parseError}`);
		}
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
