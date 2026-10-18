/// 写真のカテゴリ（AI の分類の `category`）の表示名（docs/travel-album/03_screen_design.md §5.1）
///
/// 段階3ではアプリが持つ。段階4で種類の一覧の API（`GET /api/catalog/kinds` の `label`）から取る形に移す
const _categoryLabels = {
  'plant': '植物',
  'food': '食べ物',
  'landscape': '風景',
  'other': 'その他',
};

/// 画面に並べるカテゴリの順（旅行詳細のチップと、カテゴリの一覧の画面）
const photoCategories = ['plant', 'food', 'landscape', 'other'];

/// カテゴリの表示名。知らないキー（後の段階で足された種類など）はキーのまま返す
String categoryLabel(String category) => _categoryLabels[category] ?? category;

/// 分類を待っている・している（`pending` / `classifying` / `identifying`）か
bool isProcessingInProgress(String state) =>
    state == 'pending' || state == 'classifying' || state == 'identifying';

/// 上限まで分類に失敗した（`failed`。自動では再試行されず、「やり直す」を待つ）か
bool isProcessingFailed(String state) => state == 'failed';
