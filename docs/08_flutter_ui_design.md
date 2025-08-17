# SnapPlant Flutter UI設計・実装仕様

## 1. UI設計の概要

### Material Design 3.0 採用
- **Google推奨**: 最新のMaterial Design 3.0を採用
- **植物テーマ**: グリーン系配色によるナチュラルなデザイン
- **アクセシビリティ**: WCAG AA準拠のコントラスト比
- **レスポンシブ**: 様々な画面サイズに対応

### デザインシステム
```dart
// カラーパレット
class AppColors {
  // プライマリカラー（植物の緑）
  static const Color primary = Color(0xFF2E7D32);      // 深緑
  static const Color primaryLight = Color(0xFF60AD5E);  // 明るい緑
  static const Color primaryDark = Color(0xFF005005);   // 濃い緑
  
  // セカンダリカラー（花の色）
  static const Color secondary = Color(0xFFFF6F00);     // オレンジ
  static const Color secondaryLight = Color(0xFFFF9F40); // 明るいオレンジ
  static const Color secondaryDark = Color(0xFFC43E00);  // 濃いオレンジ
  
  // サーフェスカラー
  static const Color surface = Color(0xFFF8F9FA);       // 薄いグレー
  static const Color background = Colors.white;
  static const Color cardBackground = Color(0xFFFFFFF);
  
  // テキストカラー
  static const Color textPrimary = Color(0xFF1A1A1A);
  static const Color textSecondary = Color(0xFF757575);
  static const Color textHint = Color(0xFFBDBDBD);
}

// テキストスタイル
class AppTextStyles {
  static const TextStyle headline1 = TextStyle(
    fontSize: 24,
    fontWeight: FontWeight.bold,
    color: AppColors.textPrimary,
  );
  
  static const TextStyle headline2 = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    color: AppColors.textPrimary,
  );
  
  static const TextStyle body1 = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.normal,
    color: AppColors.textPrimary,
    height: 1.5,
  );
  
  static const TextStyle caption = TextStyle(
    fontSize: 12,
    color: AppColors.textSecondary,
  );
}
```

## 2. 画面別UI実装仕様

### 2.1 植物一覧画面（PlantListScreen）

#### レイアウト構造
```dart
Scaffold(
  appBar: CustomAppBar(
    title: 'SnapPlant',
    actions: [
      IconButton(icon: Icon(Icons.settings), onPressed: () {}),
    ],
  ),
  body: RefreshIndicator(
    onRefresh: _refreshPlants,
    child: ListView.builder(
      padding: EdgeInsets.all(16),
      itemCount: plants.length,
      itemBuilder: (context, index) => PlantCard(plant: plants[index]),
    ),
  ),
  floatingActionButton: FloatingActionButton.extended(
    onPressed: () => Navigator.push(context, CameraScreen.route()),
    icon: Icon(Icons.camera_alt),
    label: Text('撮影'),
    backgroundColor: AppColors.primary,
  ),
)
```

#### PlantCard ウィジェット
```dart
class PlantCard extends StatelessWidget {
  final Plant plant;
  
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.only(bottom: 16),
      elevation: 4,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => Navigator.push(
          context,
          PlantDetailScreen.route(plant: plant),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // 植物画像
            Hero(
              tag: 'plant-image-${plant.id}',
              child: ClipRRect(
                borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
                child: CachedNetworkImage(
                  imageUrl: plant.imagePath,
                  height: 200,
                  width: double.infinity,
                  fit: BoxFit.cover,
                  placeholder: (context, url) => Container(
                    height: 200,
                    color: AppColors.surface,
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  errorWidget: (context, url, error) => Container(
                    height: 200,
                    color: AppColors.surface,
                    child: Icon(Icons.error, color: AppColors.textSecondary),
                  ),
                ),
              ),
            ),
            // 植物情報
            Padding(
              padding: EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          plant.name,
                          style: AppTextStyles.headline2,
                        ),
                      ),
                      Container(
                        padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        decoration: BoxDecoration(
                          color: AppColors.primary.withOpacity(0.1),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text(
                          '${plant.confidence}%',
                          style: TextStyle(
                            color: AppColors.primary,
                            fontWeight: FontWeight.w600,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ],
                  ),
                  SizedBox(height: 8),
                  Text(
                    plant.characteristics,
                    style: AppTextStyles.body1,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  SizedBox(height: 8),
                  Row(
                    children: [
                      Icon(Icons.eco, size: 16, color: AppColors.primary),
                      SizedBox(width: 4),
                      Text(
                        plant.scientificName ?? '学名不明',
                        style: AppTextStyles.caption,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
```

### 2.2 画像アップロード・コンテキスト入力画面（CameraScreen）

#### Material Design カメラUI
```dart
class CameraScreen extends StatefulWidget {
  static Route<void> route() => MaterialPageRoute(builder: (_) => CameraScreen());
}

class _CameraScreenState extends State<CameraScreen> {
  File? _selectedImage;
  bool _isLoading = false;
  final _contextController = TextEditingController();

  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('植物を撮影・情報入力'),
        centerTitle: true,
      ),
      body: Padding(
        padding: EdgeInsets.all(24),
        child: Column(
          children: [
            // 説明テキスト
            Container(
              width: double.infinity,
              padding: EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.primary.withOpacity(0.1),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Text(
                '植物の写真を撮影または選択してください\n葉や花がはっきり写るように撮影すると\n識別精度が向上します',
                style: AppTextStyles.body1.copyWith(
                  color: AppColors.primary,
                ),
                textAlign: TextAlign.center,
              ),
            ),
            
            SizedBox(height: 32),
            
            // 画像プレビューエリア
            Expanded(
              child: Container(
                width: double.infinity,
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.primary, width: 2),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: _selectedImage != null
                    ? ClipRRect(
                        borderRadius: BorderRadius.circular(14),
                        child: Image.file(
                          _selectedImage!,
                          fit: BoxFit.cover,
                        ),
                      )
                    : Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            Icons.add_photo_alternate_outlined,
                            size: 64,
                            color: AppColors.textSecondary,
                          ),
                          SizedBox(height: 16),
                          Text(
                            'タップして写真を選択',
                            style: AppTextStyles.body1.copyWith(
                              color: AppColors.textSecondary,
                            ),
                          ),
                        ],
                      ),
              ),
            ),
            
            SizedBox(height: 24),
            
            // アクションボタン
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => _pickImage(ImageSource.gallery),
                    icon: Icon(Icons.photo_library),
                    label: Text('ギャラリー'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.primary,
                      side: BorderSide(color: AppColors.primary),
                      padding: EdgeInsets.symmetric(vertical: 16),
                    ),
                  ),
                ),
                SizedBox(width: 16),
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: () => _pickImage(ImageSource.camera),
                    icon: Icon(Icons.camera_alt),
                    label: Text('カメラ'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: Colors.white,
                      padding: EdgeInsets.symmetric(vertical: 16),
                    ),
                  ),
                ),
              ],
            ),
            
            SizedBox(height: 16),
            
            // コンテキスト情報入力エリア
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'コンテキスト情報（任意）',
                  style: AppTextStyles.headline2.copyWith(
                    fontSize: 16,
                    color: AppColors.textPrimary,
                  ),
                ),
                SizedBox(height: 8),
                Text(
                  '撮影場所や環境について入力すると識別精度が向上します',
                  style: AppTextStyles.caption,
                ),
                SizedBox(height: 12),
                TextField(
                  controller: _contextController,
                  maxLines: 3,
                  maxLength: 500,
                  decoration: InputDecoration(
                    hintText: '例：〇〇山の標高1300m、日当たりの良い場所',
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide(color: AppColors.primary, width: 2),
                    ),
                    filled: true,
                    fillColor: AppColors.surface,
                  ),
                ),
              ],
            ),
            
            SizedBox(height: 24),
            
            // 識別実行ボタン
            if (_selectedImage != null)
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _isLoading ? null : _identifyPlant,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.secondary,
                    foregroundColor: Colors.white,
                    padding: EdgeInsets.symmetric(vertical: 20),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: _isLoading
                      ? Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                valueColor: AlwaysStoppedAnimation(Colors.white),
                              ),
                            ),
                            SizedBox(width: 12),
                            Text('識別中...'),
                          ],
                        )
                      : Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.search),
                            SizedBox(width: 8),
                            Text('植物を識別する'),
                          ],
                        ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
```

### 2.3 識別結果画面（IdentificationScreen）

#### 美しい結果表示UI
```dart
class IdentificationScreen extends StatelessWidget {
  final IdentificationResult result;
  final File imageFile;

  Widget build(BuildContext context) {
    return Scaffold(
      body: CustomScrollView(
        slivers: [
          // アプリバー（画像背景）
          SliverAppBar(
            expandedHeight: 300,
            pinned: true,
            flexibleSpace: FlexibleSpaceBar(
              title: Text(
                '識別結果',
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.bold,
                  shadows: [
                    Shadow(
                      offset: Offset(1, 1),
                      blurRadius: 4,
                      color: Colors.black.withOpacity(0.5),
                    ),
                  ],
                ),
              ),
              background: Stack(
                fit: StackFit.expand,
                children: [
                  Image.file(
                    imageFile,
                    fit: BoxFit.cover,
                  ),
                  Container(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          Colors.transparent,
                          Colors.black.withOpacity(0.3),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          
          // 識別結果リスト
          SliverPadding(
            padding: EdgeInsets.all(16),
            sliver: SliverList(
              delegate: SliverChildListDelegate([
                if (result.isPlant) ...[
                  Text(
                    '植物として識別されました',
                    style: AppTextStyles.headline1.copyWith(
                      color: AppColors.primary,
                    ),
                  ),
                  SizedBox(height: 8),
                  Text(
                    '信頼度: ${result.confidence}%',
                    style: AppTextStyles.body1.copyWith(
                      color: AppColors.textSecondary,
                    ),
                  ),
                  SizedBox(height: 24),
                  Text(
                    '候補一覧',
                    style: AppTextStyles.headline2,
                  ),
                  SizedBox(height: 16),
                  ...result.candidates.asMap().entries.map(
                    (entry) => CandidateCard(
                      candidate: entry.value,
                      rank: entry.key + 1,
                      isSelected: entry.key == 0,
                    ),
                  ),
                ] else ...[
                  Container(
                    padding: EdgeInsets.all(20),
                    decoration: BoxDecoration(
                      color: Colors.orange.withOpacity(0.1),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Column(
                      children: [
                        Icon(
                          Icons.warning_amber_rounded,
                          size: 48,
                          color: Colors.orange,
                        ),
                        SizedBox(height: 16),
                        Text(
                          '植物として識別できませんでした',
                          style: AppTextStyles.headline2.copyWith(
                            color: Colors.orange[800],
                          ),
                        ),
                        SizedBox(height: 8),
                        Text(
                          result.reason ?? '明確な植物の特徴を検出できませんでした',
                          style: AppTextStyles.body1,
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ),
                  ),
                ],
                
                SizedBox(height: 32),
                
                // アクションボタン
                if (result.isPlant && result.candidates.isNotEmpty)
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => Navigator.pop(context),
                          child: Text('やり直し'),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.textSecondary,
                            side: BorderSide(color: AppColors.textSecondary),
                            padding: EdgeInsets.symmetric(vertical: 16),
                          ),
                        ),
                      ),
                      SizedBox(width: 16),
                      Expanded(
                        child: ElevatedButton(
                          onPressed: () => _savePlant(context),
                          child: Text('保存'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.primary,
                            foregroundColor: Colors.white,
                            padding: EdgeInsets.symmetric(vertical: 16),
                          ),
                        ),
                      ),
                    ],
                  )
                else
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: () => Navigator.pop(context),
                      child: Text('やり直し'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        foregroundColor: Colors.white,
                        padding: EdgeInsets.symmetric(vertical: 16),
                      ),
                    ),
                  ),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}
```

## 3. アニメーション・エフェクト

### Hero アニメーション
```dart
// 植物カード → 詳細画面の画像遷移
Hero(
  tag: 'plant-image-${plant.id}',
  child: Image.network(plant.imagePath),
)
```

### カスタムページ遷移
```dart
class SlideRightRoute<T> extends PageRouteBuilder<T> {
  final Widget child;
  
  SlideRightRoute({required this.child})
      : super(
          pageBuilder: (context, animation, secondaryAnimation) => child,
          transitionsBuilder: (context, animation, secondaryAnimation, child) {
            const begin = Offset(1.0, 0.0);
            const end = Offset.zero;
            const curve = Curves.easeInOutCubic;
            
            var tween = Tween(begin: begin, end: end).chain(
              CurveTween(curve: curve),
            );
            
            return SlideTransition(
              position: animation.drive(tween),
              child: child,
            );
          },
        );
}
```

### ローディングアニメーション
```dart
class PlantLoadingIndicator extends StatefulWidget {
  @override
  _PlantLoadingIndicatorState createState() => _PlantLoadingIndicatorState();
}

class _PlantLoadingIndicatorState extends State<PlantLoadingIndicator>
    with TickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: Duration(seconds: 2),
      vsync: this,
    )..repeat();
    _animation = Tween(begin: 0.0, end: 1.0).animate(_controller);
  }

  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        return Transform.rotate(
          angle: _animation.value * 2 * pi,
          child: Icon(
            Icons.eco,
            color: AppColors.primary,
            size: 32,
          ),
        );
      },
    );
  }
}
```

## 4. レスポンシブデザイン

### 画面サイズ対応
```dart
class ResponsiveLayout extends StatelessWidget {
  final Widget mobile;
  final Widget? tablet;

  const ResponsiveLayout({
    required this.mobile,
    this.tablet,
  });

  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 600) {
          return mobile;
        } else {
          return tablet ?? mobile;
        }
      },
    );
  }
}
```

この設計により、美しく使いやすいFlutterアプリを構築できます。Material Design 3.0の最新の設計原則に従い、植物図鑑アプリらしい自然で親しみやすいUIを実現します。