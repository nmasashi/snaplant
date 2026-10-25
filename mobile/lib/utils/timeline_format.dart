import '../models/timeline.dart';

/// タイムラインの日の日付の表記「10月5日（月）」（docs/03_screen_design.md §8.3・§8.4）
///
/// 日付は文字列の暦の日（`YYYY-MM-DD`）。端末のタイムゾーンに直さない
String timelineDateLabel(String date) {
  final day = DateTime.utc(int.parse(date.substring(0, 4)),
      int.parse(date.substring(5, 7)), int.parse(date.substring(8, 10)));
  const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
  return '${day.month}月${day.day}日（${weekdays[day.weekday - 1]}）';
}

/// 場面の時刻（1枚なら「7:50」、複数なら「10:10〜11:40」。§8.3）。撮影時刻はタイムゾーンを変換しない
String timelineTimeRange(List<TimelinePhoto> photos) {
  final first = _clock(photos.first.takenAt!);
  return photos.length == 1 ? first : '$first〜${_clock(photos.last.takenAt!)}';
}

/// 撮影時刻「7:50」（撮影日時の文字列から）
String _clock(String takenAt) =>
    '${int.parse(takenAt.substring(11, 13))}:${takenAt.substring(14, 16)}';
