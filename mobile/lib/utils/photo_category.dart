/// 写真のカテゴリ（AI の分類の `category`）の表示名（docs/03_screen_design.md §5.1）
///
/// アプリが持つ（図鑑のタブは種類の一覧の API から作るが、カテゴリの表示名はこの表のまま。docs/02_design_overview.md §5 #33）。
/// どれにも当てはまらない分類（[otherCategory]）は旅行詳細のチップに出さないので、表に入れない（表示名は [categoryLabel] が持つ）
const _categoryLabels = {
  'plant': '植物',
  'food': '食べ物',
  'landscape': '風景',
};

/// どれにも当てはまらない分類（図鑑に載らない写真の寄せ集め）。チップには出さない（03 §5.1・§5.3）。写真ビューアでは「その他」と出し、手で直せる（03 §5.6）
const otherCategory = 'other';

/// 画面に並べるカテゴリの順（旅行詳細のチップ）。表示名の表の順で、キーを二重に持たない
final photoCategories = List<String>.unmodifiable(_categoryLabels.keys);

/// 写真ビューアで手で選べるカテゴリ（チップの順に、最後に [otherCategory]。03 §5.6）
final editableCategories =
    List<String>.unmodifiable([...photoCategories, otherCategory]);

/// カテゴリの表示名。[otherCategory] は「その他」。知らないキー（後の段階で足された種類など）はキーのまま返す
String categoryLabel(String category) =>
    _categoryLabels[category] ?? (category == otherCategory ? 'その他' : category);

/// カテゴリが図鑑の種類（識別の対象）か。分類の前（null）と [otherCategory] は違う
bool isCatalogCategory(String? category) => photoCategories.contains(category);

/// 図鑑に載せる種類（02 §5 #51。植物だけ。食べ物・風景は識別できても図鑑には載せない）
const _listedInCatalog = {'plant'};

/// 識別の種類 [kind] が図鑑に載るか（写真ビューアで名前を図鑑へのリンクにするか。03 §6.3）
bool isListedInCatalog(String kind) => _listedInCatalog.contains(kind);

/// 分類を待っている・している（`pending` / `classifying` / `identifying`）か
bool isProcessingInProgress(String state) =>
    state == 'pending' || state == 'classifying' || state == 'identifying';

/// 上限まで分類に失敗した（`failed`。自動では再試行されず、「やり直す」を待つ）か
bool isProcessingFailed(String state) => state == 'failed';
