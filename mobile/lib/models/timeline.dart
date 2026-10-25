/// 旅行のタイムライン（`GET /api/trips/{tripId}/timeline` の `data`。docs/05_api_design.md §5.15）
class TimelineOverview {
  /// 完成版も下書きも無ければ null
  final TripTimeline? timeline;

  /// 解析が済んでいない写真の枚数。0 でなければタイムラインを作れない
  final int pendingPhotoCount;

  const TimelineOverview(
      {required this.timeline, required this.pendingPhotoCount});

  factory TimelineOverview.fromJson(Map<String, dynamic> json) {
    final timeline = json['timeline'] as Map<String, dynamic>?;
    return TimelineOverview(
      timeline: timeline == null ? null : TripTimeline.fromJson(timeline),
      pendingPhotoCount: json['pendingPhotoCount'] as int,
    );
  }
}

/// タイムライン（完成版と下書き）
class TripTimeline {
  const TripTimeline();

  factory TripTimeline.fromJson(Map<String, dynamic> json) =>
      const TripTimeline();
}
