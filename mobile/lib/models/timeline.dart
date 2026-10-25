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

  /// 日ごとの場面（`GET …/timeline/draft` が、区切りを確かめられる下書きにだけ付ける）。無ければ null
  final List<TimelineDay>? days;

  /// 撮影日時の無い写真（[days] と一緒に付く）
  final List<TimelinePhoto>? undatedPhotos;

  const TimelineDraftStatus(
      {required this.id,
      required this.reason,
      required this.phase,
      required this.job,
      this.days,
      this.undatedPhotos});

  factory TimelineDraftStatus.fromJson(Map<String, dynamic> json) {
    final job = json['job'] as Map<String, dynamic>?;
    return TimelineDraftStatus(
      id: json['id'] as String,
      reason: json['reason'] as String,
      phase: json['phase'] as String,
      job: job == null ? null : TimelineJob.fromJson(job),
      days: (json['days'] as List<dynamic>?)
          ?.map((e) => TimelineDay.fromJson(e as Map<String, dynamic>))
          .toList(),
      undatedPhotos: (json['undatedPhotos'] as List<dynamic>?)
          ?.map((e) => TimelinePhoto.fromJson(e as Map<String, dynamic>))
          .toList(),
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

/// タイムラインの日（`days` の1つ。確かめ中の下書きでは文が無い）
class TimelineDay {
  /// 日付（`YYYY-MM-DD`。日付の切り替えの時刻で分けた日）
  final String date;

  /// 何日目か（写真の無い日も数える）
  final int dayNumber;
  final List<TimelineScene> scenes;

  const TimelineDay(
      {required this.date, required this.dayNumber, required this.scenes});

  factory TimelineDay.fromJson(Map<String, dynamic> json) => TimelineDay(
        date: json['date'] as String,
        dayNumber: json['dayNumber'] as int,
        scenes: (json['scenes'] as List<dynamic>)
            .map((e) => TimelineScene.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// タイムラインの場面（区切りから次の区切りの前までの写真）
class TimelineScene {
  /// 場面の最初の写真の id（区切りの id。写真が消えていても控えの最初の写真のまま）
  final String startPhotoId;

  /// 場面の写真のうち、今もあるもの（撮影の順）
  final List<TimelinePhoto> photos;

  /// 地名（重なりを除いて撮影の順）
  final List<String> placeNames;

  const TimelineScene(
      {required this.startPhotoId,
      required this.photos,
      required this.placeNames});

  factory TimelineScene.fromJson(Map<String, dynamic> json) => TimelineScene(
        startPhotoId: json['startPhotoId'] as String,
        photos: (json['photos'] as List<dynamic>)
            .map((e) => TimelinePhoto.fromJson(e as Map<String, dynamic>))
            .toList(),
        placeNames: (json['placeNames'] as List<dynamic>).cast<String>(),
      );
}

/// タイムラインの写真の1枚
class TimelinePhoto {
  final String id;

  /// 撮影日時（タイムゾーン無し）。日時の無い写真は null
  final String? takenAt;

  /// サムネイル（無ければ原寸）の SAS 付きの URL
  final String thumbnailUrl;

  const TimelinePhoto(
      {required this.id, required this.takenAt, required this.thumbnailUrl});

  factory TimelinePhoto.fromJson(Map<String, dynamic> json) => TimelinePhoto(
        id: json['id'] as String,
        takenAt: json['takenAt'] as String?,
        thumbnailUrl: json['thumbnailUrl'] as String,
      );
}
