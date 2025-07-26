import { CosmosClient, Database, Container } from '@azure/cosmos';
import { Plant, PlantSummary, PlantCreateRequest, PlantUpdateRequest, DuplicateCheckResult } from '../types/plant';
import { StorageService } from './storageService';

export class CosmosService {
  private client: CosmosClient;
  private database: Database;
  private container: Container;
  private storageService: StorageService;

  constructor() {
    const endpoint = process.env.COSMOS_DB_ENDPOINT!;
    const key = process.env.COSMOS_DB_KEY!;
    const databaseId = process.env.COSMOS_DB_DATABASE!;
    const containerId = process.env.COSMOS_DB_CONTAINER!;

    this.client = new CosmosClient({ endpoint, key });
    this.storageService = new StorageService();
    this.database = this.client.database(databaseId);
    this.container = this.database.container(containerId);
  }

  /**
   * 植物一覧を取得（作成日時降順）
   */
  async getPlants(): Promise<PlantSummary[]> {
    const query = `
      SELECT c.id, c.name, c.characteristics, c.imagePath, c.confidence, c.createdAt
      FROM c 
      ORDER BY c.createdAt DESC
    `;

    const { resources } = await this.container.items.query<PlantSummary>(query).fetchAll();
    return resources;
  }

  /**
   * 植物詳細を取得
   */
  async getPlantById(id: string): Promise<Plant | null> {
    try {
      const { resource } = await this.container.item(id, id).read<Plant>();
      return resource || null;
    } catch (error: any) {
      if (error.code === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * 植物名で重複チェック
   */
  async getPlantByName(name: string): Promise<Plant | null> {
    const query = `SELECT * FROM c WHERE c.name = @name`;
    const { resources } = await this.container.items
      .query<Plant>({
        query,
        parameters: [{ name: '@name', value: name }]
      })
      .fetchAll();

    return resources.length > 0 ? resources[0] : null;
  }

  /**
   * 植物を作成
   */
  async createPlant(plantData: PlantCreateRequest): Promise<Plant> {
    const now = new Date().toISOString();
    const plant: Plant = {
      id: this.generateId(),
      ...plantData,
      createdAt: now,
      updatedAt: now
    };

    const { resource } = await this.container.items.create<Plant>(plant);
    if (!resource) {
      throw new Error('Failed to create plant');
    }
    return resource;
  }

  /**
   * 植物を更新（旧画像の自動削除付き）
   */
  async updatePlant(id: string, updateData: PlantUpdateRequest): Promise<Plant | null> {
    const existingPlant = await this.getPlantById(id);
    if (!existingPlant) {
      return null;
    }

    // 旧画像URLを保存（削除用）
    const oldImagePath = existingPlant.imagePath;

    const updatedPlant: Plant = {
      ...existingPlant,
      ...updateData,
      updatedAt: new Date().toISOString()
    };

    // データベースを更新
    const { resource } = await this.container.item(id, id).replace<Plant>(updatedPlant);

    // 画像が変更されている場合、旧画像を削除
    if (resource && updateData.imagePath && oldImagePath !== updateData.imagePath) {
      try {
        await this.storageService.deleteImage(oldImagePath);
        console.log(`旧画像削除成功: ${oldImagePath}`);
      } catch (error) {
        // 旧画像削除失敗はログ出力のみ（メイン処理には影響させない）
        console.warn(`旧画像削除に失敗しましたが、データ更新は完了しています: ${error}`);
      }
    }

    return resource || null;
  }

  /**
   * 植物を削除
   */
  async deletePlant(id: string): Promise<boolean> {
    try {
      await this.container.item(id, id).delete();
      return true;
    } catch (error: any) {
      if (error.code === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * 植物名での重複チェック
   */
  async checkDuplicateByName(name: string): Promise<DuplicateCheckResult> {
    console.log(`checkDuplicateByName called with name: "${name}"`);
    
    const query = `
      SELECT c.id, c.name, c.imagePath, c.confidence, c.createdAt
      FROM c 
      WHERE c.name = @name
      LIMIT 1
    `;
    
    console.log('Query:', query);
    console.log('Parameters:', [{ name: '@name', value: name }]);
    
    try {
      const { resources } = await this.container.items.query({
        query,
        parameters: [{ name: '@name', value: name }]
      }).fetchAll();

      console.log(`Query executed successfully. Found ${resources.length} resources.`);
      console.log('Resources:', resources);

      if (resources.length === 0) {
        console.log('No duplicate found, returning { exists: false }');
        return { exists: false };
      }

      const result = {
        exists: true,
        plant: {
          id: resources[0].id,
          name: resources[0].name,
          imagePath: resources[0].imagePath,
          confidence: resources[0].confidence,
          createdAt: resources[0].createdAt
        }
      };
      
      console.log('Duplicate found, returning:', result);
      return result;
      
    } catch (error) {
      console.error('Error in checkDuplicateByName:', error);
      throw error;
    }
  }

  /**
   * UUID生成
   */
  private generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}