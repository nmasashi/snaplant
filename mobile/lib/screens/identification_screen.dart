import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../models/plant.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// 植物識別結果画面
/// AI識別の結果を表示し、植物の保存・重複確認機能を提供
/// 1440×2960画面サイズに最適化されたレスポンシブデザイン
class IdentificationScreen extends StatefulWidget {
  final File? imageFile;
  final XFile? xFile;
  final Uint8List? webImageBytes;
  final IdentificationResult identificationResult;
  final String imagePath;
  final ApiService apiService;

  const IdentificationScreen({
    super.key,
    this.imageFile,
    this.xFile,
    this.webImageBytes,
    required this.identificationResult,
    required this.imagePath,
    required this.apiService,
  });

  @override
  State<IdentificationScreen> createState() => _IdentificationScreenState();
}

class _IdentificationScreenState extends State<IdentificationScreen> {
  int _selectedCandidateIndex = 0;
  bool _isSaving = false;
  bool _isCheckingDuplicate = false;

  @override
  Widget build(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    final isLargeScreen = screenWidth >= 1400;
    
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          _buildSliverAppBar(isLargeScreen),
          _buildContent(isLargeScreen),
        ],
      ),
    );
  }

  /// SliverAppBarの構築（画像背景付き）
  Widget _buildSliverAppBar(bool isLargeScreen) {
    return SliverAppBar(
      expandedHeight: isLargeScreen ? 350 : 300,
      pinned: true,
      leading: IconButton(
        icon: Icon(
          Icons.arrow_back,
          color: Colors.white,
          size: isLargeScreen ? 28 : 24,
        ),
        onPressed: () => Navigator.pop(context),
      ),
      flexibleSpace: FlexibleSpaceBar(
        title: Text(
          '識別結果',
          style: TextStyle(
            color: Colors.white,
            fontSize: isLargeScreen ? 24 : 20,
            fontWeight: FontWeight.bold,
            shadows: [
              Shadow(
                offset: const Offset(1, 1),
                blurRadius: 4,
                color: Colors.black.withOpacity(0.7),
              ),
            ],
          ),
        ),
        background: Stack(
          fit: StackFit.expand,
          children: [
            Hero(
              tag: 'identification-image',
              child: _buildImage(),
            ),
            Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    Colors.transparent,
                    Colors.black.withOpacity(0.7),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// コンテンツの構築
  Widget _buildContent(bool isLargeScreen) {
    return SliverPadding(
      padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
      sliver: SliverList(
        delegate: SliverChildListDelegate([
          if (widget.identificationResult.isPlant) ...[
            _buildPlantIdentificationContent(isLargeScreen),
          ] else ...[
            _buildNonPlantContent(isLargeScreen),
          ],
        ]),
      ),
    );
  }

  /// 植物識別成功時のコンテンツ
  Widget _buildPlantIdentificationContent(bool isLargeScreen) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 識別成功メッセージ
        _buildSuccessHeader(isLargeScreen),
        
        SizedBox(height: isLargeScreen ? 32 : 24),
        
        // 候補一覧
        if (widget.identificationResult.candidates.isNotEmpty) ...[
          Text(
            '候補一覧',
            style: AppTextStyles.headline2.copyWith(
              fontSize: isLargeScreen ? 28 : 24,
            ),
          ),
          
          SizedBox(height: isLargeScreen ? 20 : 16),
          
          ...widget.identificationResult.candidates.asMap().entries.map(
            (entry) => _buildCandidateCard(
              candidate: entry.value,
              index: entry.key,
              isSelected: entry.key == _selectedCandidateIndex,
              isLargeScreen: isLargeScreen,
            ),
          ),
          
          SizedBox(height: isLargeScreen ? 40 : 32),
          
          // 選択された植物の詳細情報
          _buildSelectedPlantDetails(isLargeScreen),
          
          SizedBox(height: isLargeScreen ? 40 : 32),
          
          // アクションボタン
          _buildActionButtons(isLargeScreen),
        ],
      ],
    );
  }

  /// 識別成功ヘッダー
  Widget _buildSuccessHeader(bool isLargeScreen) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
      decoration: BoxDecoration(
        color: AppColors.success.withOpacity(0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: AppColors.success.withOpacity(0.3),
          width: 2,
        ),
      ),
      child: Column(
        children: [
          Icon(
            Icons.check_circle,
            color: AppColors.success,
            size: isLargeScreen ? 64 : 48,
          ),
          SizedBox(height: isLargeScreen ? 16 : 12),
          Text(
            '植物として識別されました',
            style: AppTextStyles.headline2.copyWith(
              color: AppColors.success,
              fontSize: isLargeScreen ? 28 : 24,
            ),
            textAlign: TextAlign.center,
          ),
          if (widget.identificationResult.confidence != null) ...[
            SizedBox(height: isLargeScreen ? 12 : 8),
            Text(
              '全体の信頼度: ${widget.identificationResult.confidence!.toInt()}%',
              style: AppTextStyles.body1.copyWith(
                color: AppColors.success,
                fontSize: isLargeScreen ? 20 : 18,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 候補カードの構築
  Widget _buildCandidateCard({
    required PlantCandidate candidate,
    required int index,
    required bool isSelected,
    required bool isLargeScreen,
  }) {
    return Card(
      margin: EdgeInsets.only(bottom: isLargeScreen ? 16 : 12),
      elevation: isSelected ? 8 : 4,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(
          color: isSelected ? AppColors.primary : Colors.transparent,
          width: isSelected ? 2 : 0,
        ),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () {
          setState(() {
            _selectedCandidateIndex = index;
          });
        },
        child: Padding(
          padding: EdgeInsets.all(isLargeScreen ? 20 : 16),
          child: Row(
            children: [
              // 選択インジケーター
              Container(
                width: isLargeScreen ? 28 : 24,
                height: isLargeScreen ? 28 : 24,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: isSelected ? AppColors.primary : AppColors.textSecondary,
                    width: 2,
                  ),
                  color: isSelected ? AppColors.primary : Colors.transparent,
                ),
                child: isSelected
                    ? Icon(
                        Icons.check,
                        color: Colors.white,
                        size: isLargeScreen ? 16 : 14,
                      )
                    : null,
              ),
              
              SizedBox(width: isLargeScreen ? 20 : 16),
              
              // 植物情報
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            candidate.name,
                            style: AppTextStyles.plantName.copyWith(
                              fontSize: isLargeScreen ? 24 : 20,
                              color: isSelected ? AppColors.primary : AppColors.textPrimary,
                            ),
                          ),
                        ),
                        _buildConfidenceBadge(candidate.confidence, isLargeScreen),
                      ],
                    ),
                    
                    if (candidate.scientificName != null) ...[
                      SizedBox(height: isLargeScreen ? 8 : 6),
                      Text(
                        candidate.scientificName!,
                        style: AppTextStyles.scientificName.copyWith(
                          fontSize: isLargeScreen ? 16 : 14,
                        ),
                      ),
                    ],
                    
                    if (candidate.familyName != null) ...[
                      SizedBox(height: isLargeScreen ? 4 : 2),
                      Text(
                        '${candidate.familyName}科',
                        style: AppTextStyles.caption.copyWith(
                          fontSize: isLargeScreen ? 14 : 12,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 信頼度バッジ
  Widget _buildConfidenceBadge(double confidence, bool isLargeScreen) {
    final color = AppColors.getConfidenceColor(confidence);
    
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: isLargeScreen ? 12 : 10,
        vertical: isLargeScreen ? 6 : 4,
      ),
      decoration: BoxDecoration(
        color: color.withOpacity(0.1),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: color.withOpacity(0.3),
          width: 1,
        ),
      ),
      child: Text(
        '${confidence.toInt()}%',
        style: AppTextStyles.confidence.copyWith(
          color: color,
          fontSize: isLargeScreen ? 14 : 12,
        ),
      ),
    );
  }

  /// 選択された植物の詳細情報
  Widget _buildSelectedPlantDetails(bool isLargeScreen) {
    if (widget.identificationResult.candidates.isEmpty) {
      return const SizedBox.shrink();
    }

    final selectedCandidate = widget.identificationResult.candidates[_selectedCandidateIndex];

    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
      ),
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '選択された植物の詳細',
              style: AppTextStyles.headline3.copyWith(
                fontSize: isLargeScreen ? 24 : 20,
              ),
            ),
            
            SizedBox(height: isLargeScreen ? 20 : 16),
            
            _buildDetailRow('植物名', selectedCandidate.name, isLargeScreen),
            
            if (selectedCandidate.scientificName != null)
              _buildDetailRow('学名', selectedCandidate.scientificName!, isLargeScreen),
            
            if (selectedCandidate.familyName != null)
              _buildDetailRow('科名', '${selectedCandidate.familyName}科', isLargeScreen),
            
            _buildDetailRow('信頼度', '${selectedCandidate.confidence.toInt()}%', isLargeScreen),
            
            if (selectedCandidate.characteristics.isNotEmpty) ...[
              SizedBox(height: isLargeScreen ? 16 : 12),
              Text(
                '特徴',
                style: AppTextStyles.label.copyWith(
                  fontSize: isLargeScreen ? 16 : 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              SizedBox(height: isLargeScreen ? 8 : 6),
              Text(
                selectedCandidate.characteristics,
                style: AppTextStyles.characteristics.copyWith(
                  fontSize: isLargeScreen ? 18 : 16,
                ),
              ),
            ],
            
            if (selectedCandidate.description != null && selectedCandidate.description!.isNotEmpty) ...[
              SizedBox(height: isLargeScreen ? 16 : 12),
              Text(
                '詳細説明',
                style: AppTextStyles.label.copyWith(
                  fontSize: isLargeScreen ? 16 : 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              SizedBox(height: isLargeScreen ? 8 : 6),
              Text(
                selectedCandidate.description!,
                style: AppTextStyles.body1.copyWith(
                  fontSize: isLargeScreen ? 18 : 16,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// 詳細情報行
  Widget _buildDetailRow(String label, String value, bool isLargeScreen) {
    return Padding(
      padding: EdgeInsets.only(bottom: isLargeScreen ? 12 : 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: isLargeScreen ? 100 : 80,
            child: Text(
              '$label:',
              style: AppTextStyles.label.copyWith(
                fontSize: isLargeScreen ? 16 : 14,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: AppTextStyles.body1.copyWith(
                fontSize: isLargeScreen ? 18 : 16,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 植物でない場合のコンテンツ
  Widget _buildNonPlantContent(bool isLargeScreen) {
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: EdgeInsets.all(isLargeScreen ? 24 : 20),
          decoration: BoxDecoration(
            color: AppColors.warning.withOpacity(0.1),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: AppColors.warning.withOpacity(0.3),
              width: 2,
            ),
          ),
          child: Column(
            children: [
              Icon(
                Icons.warning_amber_rounded,
                size: isLargeScreen ? 64 : 48,
                color: AppColors.warning,
              ),
              SizedBox(height: isLargeScreen ? 16 : 12),
              Text(
                '植物として識別できませんでした',
                style: AppTextStyles.headline2.copyWith(
                  color: AppColors.warning,
                  fontSize: isLargeScreen ? 28 : 24,
                ),
                textAlign: TextAlign.center,
              ),
              SizedBox(height: isLargeScreen ? 12 : 8),
              Text(
                widget.identificationResult.reason ?? '明確な植物の特徴を検出できませんでした',
                style: AppTextStyles.body1.copyWith(
                  fontSize: isLargeScreen ? 20 : 18,
                ),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
        
        SizedBox(height: isLargeScreen ? 40 : 32),
        
        SizedBox(
          width: double.infinity,
          child: ElevatedButton.icon(
            onPressed: () => Navigator.pop(context),
            icon: Icon(Icons.refresh),
            label: Text('やり直し'),
            style: ElevatedButton.styleFrom(
              padding: EdgeInsets.symmetric(
                vertical: isLargeScreen ? 24 : 20,
              ),
            ),
          ),
        ),
      ],
    );
  }

  /// アクションボタン
  Widget _buildActionButtons(bool isLargeScreen) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => Navigator.pop(context),
                icon: Icon(Icons.arrow_back),
                label: Text('やり直し'),
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
                onPressed: (_isSaving || _isCheckingDuplicate) ? null : _savePlant,
                icon: (_isSaving || _isCheckingDuplicate)
                    ? SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          valueColor: AlwaysStoppedAnimation(Colors.white),
                        ),
                      )
                    : Icon(Icons.save),
                label: Text(
                  _isCheckingDuplicate ? '重複確認中...' 
                      : _isSaving ? '保存中...' 
                      : '保存',
                ),
                style: ElevatedButton.styleFrom(
                  padding: EdgeInsets.symmetric(
                    vertical: isLargeScreen ? 20 : 16,
                  ),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// 植物の保存
  Future<void> _savePlant() async {
    if (widget.identificationResult.candidates.isEmpty) return;

    final selectedCandidate = widget.identificationResult.candidates[_selectedCandidateIndex];

    try {
      setState(() {
        _isCheckingDuplicate = true;
      });

      // 重複チェック
      final duplicateResult = await widget.apiService.checkDuplicate(selectedCandidate.name);

      setState(() {
        _isCheckingDuplicate = false;
      });

      if (duplicateResult.exists) {
        final shouldReplace = await _showDuplicateDialog(duplicateResult, selectedCandidate);
        if (!shouldReplace) return;
        
        setState(() {
          _isSaving = true;
        });
        
        // 重複あり：既存植物の画像・信頼度を更新
        await widget.apiService.updatePlant(
          duplicateResult.plant!.id,
          widget.imagePath,
          selectedCandidate.confidence,
        );
      } else {
        setState(() {
          _isSaving = true;
        });

        // 重複なし：新規植物保存
        final createRequest = PlantCreateRequest(
          name: selectedCandidate.name,
          scientificName: selectedCandidate.scientificName,
          familyName: selectedCandidate.familyName,
          description: selectedCandidate.description,
          characteristics: selectedCandidate.characteristics,
          confidence: selectedCandidate.confidence,
          imagePath: widget.imagePath,
        );

        await widget.apiService.savePlant(createRequest);
      }

      setState(() {
        _isSaving = false;
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('植物を保存しました'),
            backgroundColor: AppColors.success,
            behavior: SnackBarBehavior.floating,
          ),
        );

        Navigator.pop(context, true);
      }

    } catch (e) {
      setState(() {
        _isSaving = false;
        _isCheckingDuplicate = false;
      });

      final errorMessage = e is ApiException 
          ? e.userMessage 
          : '植物の保存に失敗しました';

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(errorMessage),
            backgroundColor: AppColors.error,
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  /// 重複確認ダイアログ
  Future<bool> _showDuplicateDialog(
    DuplicateCheckResult duplicateResult,
    PlantCandidate candidate,
  ) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('重複する植物が見つかりました'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('「${candidate.name}」は既に登録されています。'),
            const SizedBox(height: 16),
            const Text('新しい写真で上書きしますか？'),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(
              foregroundColor: AppColors.primary,
            ),
            child: const Text('上書き保存'),
          ),
        ],
      ),
    );

    return result ?? false;
  }

  /// 画像表示ウィジェットを構築（Web/モバイル対応）
  Widget _buildImage() {
    if (kIsWeb && widget.webImageBytes != null) {
      return Image.memory(
        widget.webImageBytes!,
        fit: BoxFit.cover,
      );
    } else if (widget.imageFile != null) {
      return Image.file(
        widget.imageFile!,
        fit: BoxFit.cover,
      );
    } else {
      return Container(
        color: Colors.grey[300],
        child: const Icon(
          Icons.image_not_supported,
          size: 64,
          color: Colors.grey,
        ),
      );
    }
  }
}