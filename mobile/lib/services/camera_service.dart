import 'dart:io';
import 'package:image_picker/image_picker.dart';

/// カメラ・画像選択を管理するサービスクラス
class CameraService {
  final ImagePicker _picker = ImagePicker();
  
  /// カメラで写真を撮影
  Future<File?> takePhoto() async {
    try {
      final XFile? image = await _picker.pickImage(
        source: ImageSource.camera,
        imageQuality: 85, // 品質を85%に設定（ファイルサイズとのバランス）
        maxWidth: 1920,   // 最大幅を制限
        maxHeight: 1920,  // 最大高さを制限
      );
      
      if (image != null) {
        return File(image.path);
      }
      return null;
    } catch (e) {
      throw CameraException('写真の撮影に失敗しました: ${e.toString()}');
    }
  }
  
  /// ギャラリーから画像を選択
  Future<File?> pickFromGallery() async {
    try {
      final XFile? image = await _picker.pickImage(
        source: ImageSource.gallery,
        imageQuality: 85,
        maxWidth: 1920,
        maxHeight: 1920,
      );
      
      if (image != null) {
        return File(image.path);
      }
      return null;
    } catch (e) {
      throw CameraException('画像の選択に失敗しました: ${e.toString()}');
    }
  }
  
  /// 画像選択のオプションを表示
  Future<File?> showImageSourceDialog({
    required Function() onCameraSelected,
    required Function() onGallerySelected,
  }) async {
    // この関数は実際にはUIレイヤーで実装される
    // ここではプレースホルダーとして定義
    throw UnimplementedError('showImageSourceDialog should be implemented in UI layer');
  }
  
  /// 画像ファイルのバリデーション
  bool validateImageFile(File file) {
    // ファイルが存在するかチェック
    if (!file.existsSync()) {
      return false;
    }
    
    // ファイルサイズをチェック（10MB以下）
    final fileSize = file.lengthSync();
    if (fileSize > 10 * 1024 * 1024) {
      throw CameraException('画像ファイルが大きすぎます（10MB以下にしてください）');
    }
    
    // ファイル拡張子をチェック
    final extension = file.path.toLowerCase().split('.').last;
    final allowedExtensions = ['jpg', 'jpeg', 'png'];
    if (!allowedExtensions.contains(extension)) {
      throw CameraException('サポートされていない画像形式です（JPG、PNG のみ対応）');
    }
    
    return true;
  }
  
  /// 一時ファイルのクリーンアップ
  Future<void> cleanupTempFiles(List<File> files) async {
    for (final file in files) {
      try {
        if (await file.exists()) {
          await file.delete();
        }
      } catch (e) {
        // ファイル削除エラーは無視（一時ファイルなので問題なし）
        print('一時ファイルの削除に失敗: ${e.toString()}');
      }
    }
  }
  
  /// カメラの利用可能性をチェック
  Future<bool> isCameraAvailable() async {
    try {
      // カメラにアクセスを試行（実際に撮影はしない）
      final cameras = await _picker.pickImage(
        source: ImageSource.camera,
        maxWidth: 1,
        maxHeight: 1,
      );
      return true;
    } catch (e) {
      return false;
    }
  }
  
  /// ギャラリーの利用可能性をチェック
  Future<bool> isGalleryAvailable() async {
    try {
      // ギャラリーにアクセスを試行（実際に選択はしない）
      return true; // ギャラリーは通常利用可能
    } catch (e) {
      return false;
    }
  }
}

/// カメラサービス用の例外クラス
class CameraException implements Exception {
  final String message;
  
  const CameraException(this.message);
  
  @override
  String toString() => 'CameraException: $message';
}