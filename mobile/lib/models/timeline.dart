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

  /// 下書きを [draft] に替えたもの（作る・文を書く受付の応答で、読み直さずに表示を進める）
  TimelineOverview withDraft(TimelineDraftStatus draft) => TimelineOverview(
        timeline: TripTimeline(
            hasCurrent: timeline?.hasCurrent ?? false, draft: draft),
        pendingPhotoCount: pendingPhotoCount,
      );
}

/// タイムライン（完成版と下書き）
class TripTimeline {
  /// 完成版があるか（完成版の中身は段階5の 5-4 で読む）
  final bool hasCurrent;

  /// 下書き（作っている途中・確かめ待ち・失敗）。無ければ null
  final TimelineDraftStatus? draft;

  const TripTimeline({required this.hasCurrent, required this.draft});

  factory TripTimeline.fromJson(Map<String, dynamic> json) {
    final draft = json['draft'] as Map<String, dynamic>?;
    return TripTimeline(
      hasCurrent: json['current'] != null,
      draft: draft == null ? null : TimelineDraftStatus.fromJson(draft),
    );
  }
}

/// 下書きの状態（`draft` の `id`・`reason`・`phase`・`job`・`startedAt`）
class TimelineDraftStatus {
  final String id;

  /// `create`（初めて作る）・`rebuild`（作り直し）・`recut`（区切りの直し）
  final String reason;

  /// `proposing`（区切りの案）・`reviewing`（確かめ待ち）・`writing`（見出しと一言）
  final String phase;

  /// 裏の処理の状態。確かめ待ちでは null
  final TimelineJob? job;

  const TimelineDraftStatus(
      {required this.id,
      required this.reason,
      required this.phase,
      required this.job});

  factory TimelineDraftStatus.fromJson(Map<String, dynamic> json) {
    final job = json['job'] as Map<String, dynamic>?;
    return TimelineDraftStatus(
      id: json['id'] as String,
      reason: json['reason'] as String,
      phase: json['phase'] as String,
      job: job == null ? null : TimelineJob.fromJson(job),
    );
  }

  /// 作っている途中（`job.state` が `pending` / `running`）。この間は画面が下書きを読み直す（docs/03_screen_design.md §8.1）
  bool get isWorking => job?.state == 'pending' || job?.state == 'running';

  /// 裏の処理が失敗した
  bool get isFailed => job?.state == 'failed';
}

/// 下書きの裏の処理（`job` の `step`・`state`・`lastError`）
class TimelineJob {
  /// `propose`（区切りの案）・`write`（見出しと一言）
  final String step;

  /// `pending`・`running`・`failed`
  final String state;

  const TimelineJob({required this.step, required this.state});

  factory TimelineJob.fromJson(Map<String, dynamic> json) => TimelineJob(
        step: json['step'] as String,
        state: json['state'] as String,
      );
}
