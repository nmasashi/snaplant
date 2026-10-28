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
            current: timeline?.current,
            draft: draft,
            changes: timeline?.changes),
        pendingPhotoCount: pendingPhotoCount,
      );
}

/// タイムライン（完成版と下書き）
class TripTimeline {
  /// 完成版。下書きだけのときは null
  final TimelineCurrent? current;

  /// 下書き（作っている途中・確かめ待ち・失敗）。無ければ null
  final TimelineDraftStatus? draft;

  /// 完成版を作った後に増えた・消えた写真の枚数（完成版が無ければ null）
  final TimelineChanges? changes;

  const TripTimeline(
      {required this.current, required this.draft, this.changes});

  factory TripTimeline.fromJson(Map<String, dynamic> json) {
    final draft = json['draft'] as Map<String, dynamic>?;
    final current = json['current'] as Map<String, dynamic>?;
    final changes = json['changes'] as Map<String, dynamic>?;
    // 応答の droppedEdits（残せなかった文）は読まない。作り直しが前の文を使わなくなり（5-5b）、残せなかった文が無くなった
    return TripTimeline(
      current: current == null ? null : TimelineCurrent.fromJson(current),
      draft: draft == null ? null : TimelineDraftStatus.fromJson(draft),
      changes: changes == null ? null : TimelineChanges.fromJson(changes),
    );
  }
}

/// 完成版を作った後の写真の変化（`changes`）
class TimelineChanges {
  final int added;
  final int removed;

  const TimelineChanges({required this.added, required this.removed});

  factory TimelineChanges.fromJson(Map<String, dynamic> json) =>
      TimelineChanges(
        added: json['added'] as int,
        removed: json['removed'] as int,
      );
}

/// 完成版（`current`。docs/05_api_design.md §5.15）
class TimelineCurrent {
  /// 文を書き終えた時刻（UTC の ISO 8601。画面は端末の時刻で出す）
  final String writtenAt;
  final List<TimelineDay> days;

  /// 撮影日時の無い写真
  final List<TimelinePhoto> undatedPhotos;

  const TimelineCurrent(
      {required this.writtenAt,
      required this.days,
      required this.undatedPhotos});

  factory TimelineCurrent.fromJson(Map<String, dynamic> json) =>
      TimelineCurrent(
        writtenAt: json['writtenAt'] as String,
        days: (json['days'] as List<dynamic>)
            .map((e) => TimelineDay.fromJson(e as Map<String, dynamic>))
            .toList(),
        undatedPhotos: (json['undatedPhotos'] as List<dynamic>)
            .map((e) => TimelinePhoto.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
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

  /// 日のタイトルとまとめ（完成版だけ。文が無ければ null）と、書いた主（`ai` / `user`）
  final String? title;
  final String? titleSource;
  final String? summary;
  final String? summarySource;

  const TimelineDay(
      {required this.date,
      required this.dayNumber,
      required this.scenes,
      this.title,
      this.titleSource,
      this.summary,
      this.summarySource});

  factory TimelineDay.fromJson(Map<String, dynamic> json) => TimelineDay(
        date: json['date'] as String,
        dayNumber: json['dayNumber'] as int,
        scenes: (json['scenes'] as List<dynamic>)
            .map((e) => TimelineScene.fromJson(e as Map<String, dynamic>))
            .toList(),
        title: json['title'] as String?,
        titleSource: json['titleSource'] as String?,
        summary: json['summary'] as String?,
        summarySource: json['summarySource'] as String?,
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

  /// 写真の識別の名前（重なりを除いて撮影の順）
  final List<String> names;

  /// 食べ物の写真がある場面か（見出しの印の色）
  final bool hasFood;

  /// 場面の見出しと一言（完成版だけ。文が無ければ null）
  final String? label;
  final String? note;

  const TimelineScene(
      {required this.startPhotoId,
      required this.photos,
      required this.placeNames,
      required this.names,
      required this.hasFood,
      this.label,
      this.note});

  factory TimelineScene.fromJson(Map<String, dynamic> json) => TimelineScene(
        startPhotoId: json['startPhotoId'] as String,
        photos: (json['photos'] as List<dynamic>)
            .map((e) => TimelinePhoto.fromJson(e as Map<String, dynamic>))
            .toList(),
        placeNames: (json['placeNames'] as List<dynamic>).cast<String>(),
        names: (json['names'] as List<dynamic>).cast<String>(),
        hasFood: json['hasFood'] as bool,
        label: json['label'] as String?,
        note: json['note'] as String?,
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
