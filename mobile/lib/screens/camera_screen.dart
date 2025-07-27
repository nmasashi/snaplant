import 'dart:io';
import 'package:flutter/material.dart';
import '../models/plant.dart';
import '../services/api_service.dart';
import '../services/camera_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';
import 'identification_screen.dart';

/// カメラ・画像選択画面
/// 植物の写真撮影または選択を行い、AI識別処理を開始する
/// 1440×2960画面サイズに最適化されたレスポンシブデザイン
class CameraScreen extends StatefulWidget {
  final ApiService apiService;

  const CameraScreen({
    super.key,
    required this.apiService,
  });

  @override
  State<CameraScreen> createState() => _CameraScreenState();
}

class _CameraScreenState extends State<CameraScreen> 
    with TickerProviderStateMixin {
  File? _selectedImage;
  bool _isUploading = false;
  bool _isIdentifying = false;
  final CameraService _cameraService = CameraService();
  late AnimationController _fadeController;
  late AnimationController _scaleController;
  late Animation<double> _fadeAnimation;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _initializeAnimations();
  }

  /// アニメーションの初期化
  void _initializeAnimations() {
    _fadeController = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    
    _scaleController = AnimationController(
      duration: const Duration(milliseconds: 200),
      vsync: this,
    );

    _fadeAnimation = Tween<double>(
      begin: 0.0,
      end: 1.0,
    ).animate(CurvedAnimation(
      parent: _fadeController,
      curve: Curves.easeInOut,
    ));

    _scaleAnimation = Tween<double>(
      begin: 0.8,
      end: 1.0,
    ).animate(CurvedAnimation(
      parent: _scaleController,
      curve: Curves.elasticOut,
    ));
  }

  /// ギャラリーから画像を選択
  Future<void> _pickFromGallery() async {
    try {
      final image = await _cameraService.pickFromGallery();
      if (image != null) {
        _setSelectedImage(image);
      }
    } catch (e) {
      _showErrorSnackBar(e.toString());
    }
  }

  /// カメラで撮影
  Future<void> _takePhoto() async {
    try {
      final image = await _cameraService.takePhoto();
      if (image != null) {
        _setSelectedImage(image);
      }
    } catch (e) {
      _showErrorSnackBar(e.toString());
    }
  }

  /// 選択した画像を設定
  void _setSelectedImage(File image) {
    setState(() {
      _selectedImage = image;
    });
    
    // アニメーション開始
    _fadeController.forward();
    _scaleController.forward();
  }

  /// 植物識別を実行
  Future<void> _identifyPlant() async {
    if (_selectedImage == null) return;

    try {
      // バリデーション
      if (!_cameraService.validateImageFile(_selectedImage!)) {
        return;
      }

      setState(() {
        _isUploading = true;
      });

      // 画像をアップロード
      final uploadResult = await widget.apiService.uploadImage(_selectedImage!);
      
      setState(() {
        _isUploading = false;
        _isIdentifying = true;
      });

      // AI識別を実行
      final identificationResult = await widget.apiService.identifyPlant(
        uploadResult.imagePath,
      );

      setState(() {
        _isIdentifying = false;
      });

      // 識別結果画面へ遷移
      if (mounted) {
        final result = await Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => IdentificationScreen(
              imageFile: _selectedImage!,
              identificationResult: identificationResult,
              imagePath: uploadResult.imagePath,
              apiService: widget.apiService,
            ),
          ),
        );

        // 植物が保存された場合は親画面に通知
        if (result == true) {
          Navigator.pop(context, true);
        }
      }

    } catch (e) {
      setState(() {
        _isUploading = false;
        _isIdentifying = false;
      });

      final errorMessage = e is ApiException 
          ? e.userMessage 
          : '画像の処理に失敗しました';
      _showErrorSnackBar(errorMessage);
    }
  }

  /// エラーメッセージの表示
  void _showErrorSnackBar(String message) {
    if (!mounted) return;
    
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: AppColors.error,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  /// 画像選択ダイアログの表示
  Future<void> _showImagePickerDialog() async {
    final screenWidth = MediaQuery.of(context).size.width;
    final isLargeScreen = screenWidth >= 1400;
    
    showModalBottomSheet(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) => Container(
        padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '画像を選択',
              style: AppTextStyles.headline2.copyWith(
                fontSize: isLargeScreen ? 28 : 24,
              ),
            ),
            SizedBox(height: isLargeScreen ? 32 : 24),
            Row(
              children: [
                Expanded(
                  child: _buildImageSourceButton(
                    icon: Icons.camera_alt,
                    label: 'カメラ',
                    onPressed: () {
                      Navigator.pop(context);
                      _takePhoto();
                    },
                    isLargeScreen: isLargeScreen,
                  ),
                ),
                SizedBox(width: isLargeScreen ? 20 : 16),
                Expanded(
                  child: _buildImageSourceButton(
                    icon: Icons.photo_library,
                    label: 'ギャラリー',
                    onPressed: () {
                      Navigator.pop(context);
                      _pickFromGallery();
                    },
                    isLargeScreen: isLargeScreen,
                    isOutlined: true,
                  ),
                ),
              ],
            ),
            SizedBox(height: isLargeScreen ? 24 : 16),
          ],
        ),
      ),
    );
  }

  /// 画像選択ボタンの構築
  Widget _buildImageSourceButton({
    required IconData icon,
    required String label,
    required VoidCallback onPressed,
    required bool isLargeScreen,
    bool isOutlined = false,
  }) {
    final buttonStyle = isOutlined
        ? OutlinedButton.styleFrom(
            padding: EdgeInsets.symmetric(
              vertical: isLargeScreen ? 20 : 16,
            ),
          )
        : ElevatedButton.styleFrom(
            padding: EdgeInsets.symmetric(
              vertical: isLargeScreen ? 20 : 16,
            ),
          );

    final child = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          icon,
          size: isLargeScreen ? 32 : 28,
        ),
        SizedBox(height: isLargeScreen ? 12 : 8),
        Text(
          label,
          style: TextStyle(
            fontSize: isLargeScreen ? 18 : 16,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );

    return isOutlined
        ? OutlinedButton(
            onPressed: onPressed,
            style: buttonStyle,
            child: child,
          )
        : ElevatedButton(
            onPressed: onPressed,
            style: buttonStyle,
            child: child,
          );
  }

  @override
  Widget build(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    final isLargeScreen = screenWidth >= 1400;
    
    return Scaffold(
      appBar: _buildAppBar(isLargeScreen),
      body: _buildBody(isLargeScreen),
    );
  }

  /// アプリバーの構築
  PreferredSizeWidget _buildAppBar(bool isLargeScreen) {
    return AppBar(
      title: Text(
        '植物を撮影',
        style: AppTextStyles.appBarTitle.copyWith(
          fontSize: isLargeScreen ? 26 : 22,
        ),
      ),
      leading: IconButton(
        icon: Icon(
          Icons.arrow_back,
          size: isLargeScreen ? 28 : 24,
        ),
        onPressed: () => Navigator.pop(context),
      ),
    );
  }

  /// ボディの構築
  Widget _buildBody(bool isLargeScreen) {
    return Padding(
      padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
      child: Column(
        children: [
          // 説明テキスト
          _buildInstructionCard(isLargeScreen),
          
          SizedBox(height: isLargeScreen ? 40 : 32),
          
          // 画像プレビューエリア
          Expanded(
            child: _buildImagePreviewArea(isLargeScreen),
          ),
          
          SizedBox(height: isLargeScreen ? 32 : 24),
          
          // アクションボタン
          _buildActionButtons(isLargeScreen),
        ],
      ),
    );
  }

  /// 説明カードの構築
  Widget _buildInstructionCard(bool isLargeScreen) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
      decoration: BoxDecoration(
        color: AppColors.primary.withOpacity(0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: AppColors.primary.withOpacity(0.2),
          width: 1,
        ),
      ),
      child: Column(
        children: [
          Icon(
            Icons.info_outline,
            color: AppColors.primary,
            size: isLargeScreen ? 32 : 28,
          ),
          SizedBox(height: isLargeScreen ? 16 : 12),
          Text(
            '植物の写真を撮影または選択してください',
            style: AppTextStyles.headline3.copyWith(
              color: AppColors.primary,
              fontSize: isLargeScreen ? 24 : 20,
            ),
            textAlign: TextAlign.center,
          ),
          SizedBox(height: isLargeScreen ? 12 : 8),
          Text(
            '葉や花がはっきり写るように撮影すると\n識別精度が向上します',
            style: AppTextStyles.body1.copyWith(
              color: AppColors.primary,
              fontSize: isLargeScreen ? 18 : 16,
            ),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }

  /// 画像プレビューエリアの構築
  Widget _buildImagePreviewArea(bool isLargeScreen) {
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        border: Border.all(
          color: AppColors.primary,
          width: 2,
        ),
        borderRadius: BorderRadius.circular(16),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: _selectedImage != null
            ? _buildImagePreview(isLargeScreen)
            : _buildImagePlaceholder(isLargeScreen),
      ),
    );
  }

  /// 画像プレビューの構築
  Widget _buildImagePreview(bool isLargeScreen) {
    return AnimatedBuilder(
      animation: _fadeAnimation,
      child: AnimatedBuilder(
        animation: _scaleAnimation,
        child: Image.file(
          _selectedImage!,
          fit: BoxFit.cover,
        ),
        builder: (context, child) {
          return Transform.scale(
            scale: _scaleAnimation.value,
            child: child,
          );
        },
      ),
      builder: (context, child) {
        return Opacity(
          opacity: _fadeAnimation.value,
          child: child,
        );
      },
    );
  }

  /// 画像プレースホルダーの構築
  Widget _buildImagePlaceholder(bool isLargeScreen) {
    return InkWell(
      onTap: _showImagePickerDialog,
      child: Container(
        width: double.infinity,
        height: double.infinity,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.add_photo_alternate_outlined,
              size: isLargeScreen ? 80 : 64,
              color: AppColors.textSecondary,
            ),
            SizedBox(height: isLargeScreen ? 24 : 16),
            Text(
              'タップして写真を選択',
              style: AppTextStyles.headline3.copyWith(
                color: AppColors.textSecondary,
                fontSize: isLargeScreen ? 24 : 20,
              ),
            ),
            SizedBox(height: isLargeScreen ? 12 : 8),
            Text(
              'カメラまたはギャラリーから選択できます',
              style: AppTextStyles.body1.copyWith(
                color: AppColors.textHint,
                fontSize: isLargeScreen ? 18 : 16,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// アクションボタンの構築
  Widget _buildActionButtons(bool isLargeScreen) {
    if (_selectedImage == null) {
      return Row(
        children: [
          Expanded(
            child: OutlinedButton.icon(
              onPressed: _pickFromGallery,
              icon: Icon(Icons.photo_library),
              label: Text('ギャラリー'),
              style: OutlinedButton.styleFrom(
                padding: EdgeInsets.symmetric(
                  vertical: isLargeScreen ? 20 : 16,
                ),
              ),
            ),
          ),
          SizedBox(width: isLargeScreen ? 20 : 16),
          Expanded(
            child: ElevatedButton.icon(
              onPressed: _takePhoto,
              icon: Icon(Icons.camera_alt),
              label: Text('カメラ'),
              style: ElevatedButton.styleFrom(
                padding: EdgeInsets.symmetric(
                  vertical: isLargeScreen ? 20 : 16,
                ),
              ),
            ),
          ),
        ],
      );
    }

    return Column(
      children: [
        // 画像選択ボタン
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _pickFromGallery,
                icon: Icon(Icons.photo_library),
                label: Text('ギャラリー'),
                style: OutlinedButton.styleFrom(
                  padding: EdgeInsets.symmetric(
                    vertical: isLargeScreen ? 16 : 12,
                  ),
                ),
              ),
            ),
            SizedBox(width: isLargeScreen ? 20 : 16),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _takePhoto,
                icon: Icon(Icons.camera_alt),
                label: Text('カメラ'),
                style: OutlinedButton.styleFrom(
                  padding: EdgeInsets.symmetric(
                    vertical: isLargeScreen ? 16 : 12,
                  ),
                ),
              ),
            ),
          ],
        ),
        
        SizedBox(height: isLargeScreen ? 20 : 16),
        
        // 識別開始ボタン
        SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: (_isUploading || _isIdentifying) ? null : _identifyPlant,
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.secondary,
              padding: EdgeInsets.symmetric(
                vertical: isLargeScreen ? 24 : 20,
              ),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: _isUploading || _isIdentifying
                ? Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      SizedBox(
                        width: isLargeScreen ? 24 : 20,
                        height: isLargeScreen ? 24 : 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          valueColor: AlwaysStoppedAnimation(Colors.white),
                        ),
                      ),
                      SizedBox(width: 12),
                      Text(
                        _isUploading ? 'アップロード中...' : '識別中...',
                        style: TextStyle(
                          fontSize: isLargeScreen ? 20 : 18,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  )
                : Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.psychology,
                        size: isLargeScreen ? 24 : 20,
                      ),
                      SizedBox(width: 8),
                      Text(
                        '植物を識別する',
                        style: TextStyle(
                          fontSize: isLargeScreen ? 20 : 18,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    _fadeController.dispose();
    _scaleController.dispose();
    super.dispose();
  }
}