/// 旅行の撮影期間の表記（docs/travel-album/03_screen_design.md §3）
///
/// 撮影日時はタイムゾーン無しの文字列（撮影した土地での時刻）なので、[DateTime] に直さず日付の部分だけを使う。
/// 端末のタイムゾーンに変換すると、旅先と時差がある端末で日付がずれる
String formatTripPeriod(String? firstTakenAt, String? lastTakenAt) {
  if (firstTakenAt == null || lastTakenAt == null) {
    return '撮影日時なし';
  }
  final first = _dateOf(firstTakenAt);
  final last = _dateOf(lastTakenAt);
  return first == last ? first : '$first 〜 $last';
}

/// `YYYY-MM-DDTHH:mm:ss` から `YYYY/MM/DD` を取り出す
String _dateOf(String takenAt) => takenAt.substring(0, 10).replaceAll('-', '/');
