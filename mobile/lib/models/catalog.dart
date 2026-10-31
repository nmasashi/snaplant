import 'photo.dart';

/// 図鑑の種類の項目の欄（種類の一覧の `fields` の1つ。docs/05_api_design.md §5.14）
class CatalogField {
  /// 項目の `attributes` のキー
  final String key;
  final String label;

  /// 値の型（`string` か `string[]`）
  final String type;

  const CatalogField(
      {required this.key, required this.label, required this.type});

  factory CatalogField.fromJson(Map<String, dynamic> json) => CatalogField(
        key: json['key'] as String,
        label: json['label'] as String,
        type: json['type'] as String,
      );
}

/// 図鑑の種類（`GET /api/catalog/kinds` の1件）
class CatalogKind {
  /// 種類のキー（`plant` など）
  final String kind;
  final String label;
  final List<CatalogField> fields;

  const CatalogKind(
      {required this.kind, required this.label, required this.fields});

  factory CatalogKind.fromJson(Map<String, dynamic> json) => CatalogKind(
        kind: json['kind'] as String,
        label: json['label'] as String,
        fields: (json['fields'] as List<dynamic>)
            .map((e) => CatalogField.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// 図鑑の項目（識別済みの写真を種類と名前でまとめたもの。05 §3.3.1）
class CatalogEntry {
  final String kind;
  final String name;

  /// 見出しの写真（その名前で信頼度が最も高い写真）の信頼度（0〜100）
  final num confidence;
  final String? description;
  final String? characteristics;

  /// 種類ごとの項目（キーは [CatalogField.key]）
  final Map<String, dynamic> attributes;

  /// 属の学名（一覧はこれでまとめて並ぶ。02 §5 #56）。分からなければ null
  final String? genus;

  /// 属名（日本語。属の見出しに出す）。分からなければ null
  final String? genusName;

  /// その名前の写真の枚数
  final int photoCount;

  /// 見出しの写真のサムネイル（無ければ原寸）の SAS 付き URL
  final String coverThumbnailUrl;

  const CatalogEntry({
    required this.kind,
    required this.name,
    required this.confidence,
    required this.description,
    required this.characteristics,
    required this.attributes,
    this.genus,
    this.genusName,
    required this.photoCount,
    required this.coverThumbnailUrl,
  });

  factory CatalogEntry.fromJson(Map<String, dynamic> json) => CatalogEntry(
        kind: json['kind'] as String,
        name: json['name'] as String,
        confidence: json['confidence'] as num,
        description: json['description'] as String?,
        characteristics: json['characteristics'] as String?,
        attributes: (json['attributes'] as Map<String, dynamic>?) ?? const {},
        genus: json['genus'] as String?,
        genusName: json['genusName'] as String?,
        photoCount: json['photoCount'] as int,
        coverThumbnailUrl: json['coverThumbnailUrl'] as String,
      );
}

/// 図鑑の項目の一覧の1ページ（`GET /api/catalog/entries`）
class CatalogEntryPage {
  final List<CatalogEntry> entries;

  /// 項目の総数（ページに依らない）。読み切ったかは、次の offset がこれ以上かで分かる
  final int total;

  const CatalogEntryPage({required this.entries, required this.total});
}

/// 図鑑の項目の詳細の1ページ（`GET /api/catalog/entry`）
class CatalogEntryDetail {
  /// 項目（見出し）。その種類と名前の写真が無ければ null
  final CatalogEntry? entry;

  /// その項目の写真の1ページ
  final PhotoPage photos;

  const CatalogEntryDetail({required this.entry, required this.photos});
}
