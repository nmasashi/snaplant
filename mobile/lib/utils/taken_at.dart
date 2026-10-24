/// 写真の撮影日時の表記（docs/03_screen_design.md §3。例「2026年10月5日 12:30」）
///
/// 撮影日時はタイムゾーン無しの文字列（撮影した土地での時刻）なので、[DateTime] の変換を通さず文字列から組み立てる。
/// 端末のタイムゾーンに直すと、旅先と時差がある端末で時刻がずれる
String formatTakenAt(String? takenAt) {
  if (takenAt == null) {
    return '撮影日時なし';
  }
  final year = takenAt.substring(0, 4);
  final month = int.parse(takenAt.substring(5, 7));
  final day = int.parse(takenAt.substring(8, 10));
  final time = takenAt.substring(11, 16);
  return '$year年$month月$day日 $time';
}
