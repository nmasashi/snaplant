import { isValidUUID } from '../../src/utils/response';

describe('Response Utils', () => {
  describe('isValidUUID', () => {
    describe('正常系', () => {
      it('有効なUUID v4形式を受け入れる', () => {
        const validUUIDs = [
          '123e4567-e89b-12d3-a456-426614174000',
          'f47ac10b-58cc-4372-a567-0e02b2c3d479',
          '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
          'A1234567-B89C-1234-A567-123456789ABC' // 大文字
        ];
        
        validUUIDs.forEach(uuid => {
          expect(isValidUUID(uuid)).toBe(true);
        });
      });

      it('UUID v1-v5の各バージョンを受け入れる', () => {
        const validUUIDs = [
          '123e4567-e89b-11d3-a456-426614174000', // v1
          '123e4567-e89b-21d3-a456-426614174000', // v2
          '123e4567-e89b-31d3-a456-426614174000', // v3
          '123e4567-e89b-41d3-a456-426614174000', // v4
          '123e4567-e89b-51d3-a456-426614174000'  // v5
        ];
        
        validUUIDs.forEach(uuid => {
          expect(isValidUUID(uuid)).toBe(true);
        });
      });

      it('variant bits (8, 9, a, b)を受け入れる', () => {
        const validUUIDs = [
          '123e4567-e89b-41d3-8456-426614174000', // variant 8
          '123e4567-e89b-41d3-9456-426614174000', // variant 9
          '123e4567-e89b-41d3-a456-426614174000', // variant a
          '123e4567-e89b-41d3-b456-426614174000'  // variant b
        ];
        
        validUUIDs.forEach(uuid => {
          expect(isValidUUID(uuid)).toBe(true);
        });
      });
    });

    describe('異常系', () => {
      it('無効なUUID形式を拒否する', () => {
        const invalidUUIDs = [
          'invalid-uuid',
          '123e4567-e89b-12d3-a456',  // 短すぎる
          '123e4567-e89b-12d3-a456-426614174000-extra', // 長すぎる
          '123e4567-e89b-12d3-a456-42661417400g', // 無効な文字 'g'
          '123e4567_e89b_12d3_a456_426614174000', // アンダースコア
          '123e4567 e89b 12d3 a456 426614174000', // スペース
          'gggggggg-gggg-gggg-gggg-gggggggggggg', // 無効な文字
          '123e4567-e89b-62d3-a456-426614174000', // 無効なバージョン(6)
          '123e4567-e89b-41d3-c456-426614174000', // 無効なvariant(c)
          '123e4567-e89b-41d3-f456-426614174000'  // 無効なvariant(f)
        ];
        
        invalidUUIDs.forEach(uuid => {
          expect(isValidUUID(uuid)).toBe(false);
        });
      });

      it('空文字列やnull、undefinedを拒否する', () => {
        expect(isValidUUID('')).toBe(false);
        expect(isValidUUID(null as any)).toBe(false);
        expect(isValidUUID(undefined as any)).toBe(false);
      });

      it('文字列以外の型を拒否する', () => {
        expect(isValidUUID(123 as any)).toBe(false);
        expect(isValidUUID(true as any)).toBe(false);
        expect(isValidUUID({} as any)).toBe(false);
        expect(isValidUUID([] as any)).toBe(false);
      });

      it('ハイフンの位置が間違っている形式を拒否する', () => {
        const invalidFormats = [
          '123e4567e89b-12d3-a456-426614174000', // 1番目のハイフンがない
          '123e4567-e89b12d3-a456-426614174000', // 2番目のハイフンがない
          '123e4567-e89b-12d3a456-426614174000', // 3番目のハイフンがない
          '123e4567-e89b-12d3-a456426614174000', // 4番目のハイフンがない
          '123e-4567-e89b-12d3-a456-426614174000' // ハイフンの位置が間違っている
        ];
        
        invalidFormats.forEach(uuid => {
          expect(isValidUUID(uuid)).toBe(false);
        });
      });
    });

    describe('エッジケース', () => {
      it('大文字小文字の混在を正しく処理する', () => {
        const mixedCaseUUIDs = [
          '123E4567-e89b-12d3-A456-426614174000',
          'F47AC10B-58cc-4372-a567-0E02B2C3D479'
        ];
        
        mixedCaseUUIDs.forEach(uuid => {
          expect(isValidUUID(uuid)).toBe(true);
        });
      });

      it('最小値・最大値のUUIDを処理する', () => {
        const edgeCaseUUIDs = [
          '00000000-0000-1000-8000-000000000000', // 最小値に近い
          'ffffffff-ffff-5fff-bfff-ffffffffffff'  // 最大値に近い
        ];
        
        edgeCaseUUIDs.forEach(uuid => {
          expect(isValidUUID(uuid)).toBe(true);
        });
      });
    });
  });
});