// 植物データの型定義
export interface Plant {
  id: string;
  name: string;
  scientificName?: string;
  familyName?: string;
  description?: string;
  characteristics: string;
  confidence: number;
  imagePath: string;
  createdAt: string;
  updatedAt: string;
}

// 植物要約（一覧表示用）
export interface PlantSummary {
  id: string;
  name: string;
  characteristics: string;
  imagePath: string;
  confidence: number;
  createdAt: string;
}

// 植物作成リクエスト
export interface PlantCreateRequest {
  name: string;
  scientificName?: string;
  familyName?: string;
  description?: string;
  characteristics: string;
  confidence: number;
  imagePath: string;
}

// 植物更新リクエスト
export interface PlantUpdateRequest {
  imagePath: string;
  confidence: number;
}

// 植物識別リクエスト
export interface IdentifyRequest {
  imagePath: string;
}

// 植物識別候補
export interface PlantCandidate {
  name: string;
  scientificName?: string;
  familyName?: string;
  description?: string;
  characteristics: string;
  confidence: number;
}

// 植物識別結果
export interface IdentificationResult {
  isPlant: boolean;
  confidence?: number;
  reason?: string;
  candidates: PlantCandidate[];
}

// LLM分析結果
export interface LLMAnalysisResult {
  isPlant: boolean;
  confidence: number;
  reason: string;
  plantAnalysis?: {
    candidates: PlantCandidate[];
  };
}

// 重複確認結果
export interface DuplicateCheckResult {
  exists: boolean;
  plant?: {
    id: string;
    name: string;
    imagePath: string;
    confidence: number;
    createdAt: string;
  };
}