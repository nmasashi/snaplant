/// 写真のカテゴリ（AI の分類の `category`）の表示名（docs/travel-album/03_screen_design.md §5.1）
///
/// アプリが持つ（図鑑のタブは種類の一覧の API から作るが、カテゴリの表示名はこの表のまま。docs/travel-album/02_design_overview.md §5 #33）。
/// どれにも当てはまらない分類（[otherCategory]）は画面に出さないので、表に入れない
const _categoryLabels = {
  'plant': '植物',
  'food': '食べ物',
  'landscape': '風景',
};

/// どれにも当てはまらない分類（図鑑に載らない写真の寄せ集め）。チップ・カテゴリの一覧・写真ビューアに出さない（03 §5.1〜§5.3）
const otherCategory = 'other';

/// 画面に並べるカテゴリの順（旅行詳細のチップと、カテゴリの一覧の画面）。表示名の表の順で、キーを二重に持たない
final photoCategories = List<String>.unmodifiable(_categoryLabels.keys);

/// カテゴリの表示名。知らないキー（後の段階で足された種類など）はキーのまま返す
String categoryLabel(String category) => _categoryLabels[category] ?? category;

/// カテゴリが図鑑の種類（識別の対象）か。分類の前（null）と [otherCategory] は違う
bool isCatalogCategory(String? category) => photoCategories.contains(category);

/// 分類を待っている・している（`pending` / `classifying` / `identifying`）か
bool isProcessingInProgress(String state) =>
    state == 'pending' || state == 'classifying' || state == 'identifying';

/// 上限まで分類に失敗した（`failed`。自動では再試行されず、「やり直す」を待つ）か
bool isProcessingFailed(String state) => state == 'failed';
