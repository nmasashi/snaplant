import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart' show sha256;
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/test/test_flutter_secure_storage_platform.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:snaplant_mobile/main.dart';

import 'app_test_helpers.dart';

// 旅行一覧・旅行詳細など、旅行アルバムの API を呼ぶ画面のテストが共有する偽のサーバと前置き

/// 旅行（TripSummary）の JSON を作る。表紙は付けない（coverThumbnailUrl は null）。
/// [firstTakenAt]・[lastTakenAt] はタイムゾーン無しの撮影日時（`2026-10-05T09:00:00`）で、撮影日時のある写真が無ければ null
Map<String, Object?> tripJson({
  required String id,
  required String name,
  required int photoCount,
  String? description,
  String? firstTakenAt,
  String? lastTakenAt,
}) {
  return {
    'id': id,
    'name': name,
    'description': description,
    'tags': <String>[],
    'createdAt': '2026-10-01T09:00:00.000Z',
    'updatedAt': '2026-10-01T09:00:00.000Z',
    'photoCount': photoCount,
    'firstTakenAt': firstTakenAt,
    'lastTakenAt': lastTakenAt,
    'coverThumbnailUrl': null,
  };
}

/// 写真（Photo。docs/05_api_design.md §3.3）の JSON を作る。
/// [number] から 64 桁の小文字16進の id を作る（実際の id は画像の SHA-256）。サムネイルの URL は SAS 付きの形にする。
/// [takenAt] はタイムゾーン無しの撮影日時（`2026-10-05T12:30:15`）。[hasThumbnail] が false ならサムネイルが無い写真（thumbnailUrl が null）
Map<String, Object?> photoJson({
  required int number,
  String? tripId,
  String? takenAt,
  bool hasThumbnail = true,
}) {
  final id = number.toRadixString(16).padLeft(64, '0');
  const blobHost = 'https://stsnaplant.blob.core.windows.net/photos';
  return {
    'id': id,
    'tripId': tripId,
    'imageUrl': '$blobHost/$id.jpg?sv=2024-01-01&sig=test',
    'thumbnailUrl': hasThumbnail ? '$blobHost/$id.thumb.jpg?sv=2024-01-01&sig=test' : null,
    'contentType': 'image/jpeg',
    'fileSize': 1234567,
    'takenAt': takenAt,
    'takenAtSource': takenAt == null ? null : 'exif',
    'sortAt': takenAt ?? '2026-10-10T12:12:45',
    'location': null,
    'category': null,
    'tags': <String>[],
    'comment': null,
    'commentSource': null,
    'hint': null,
    'classification': null,
    'identification': null,
    'processing': {'state': 'none', 'step': null, 'attempts': 0, 'lastError': null, 'updatedAt': null},
    'uploadedAt': '2026-10-10T03:12:45.000Z',
    'updatedAt': '2026-10-10T03:12:45.000Z',
  };
}

// ---------------------------------------------------------------------------
// 状態を1つだけ持つ偽のサーバ

/// 偽のサーバが応答する宛先
enum TripRoute {
  /// GET /api/trips
  list,

  /// POST /api/trips
  create,

  /// GET /api/trips/{tripId}
  detail,

  /// PUT /api/trips/{tripId}
  update,

  /// DELETE /api/trips/{tripId}?deletePhotos=true|false
  delete,

  /// GET /api/photos?tripId=...&limit=...&continuationToken=...
  photos,

  /// POST /api/photos/move
  move,

  /// DELETE /api/photos/{photoId}
  deletePhoto,

  /// POST /api/photos（multipart）
  upload,

  /// POST /api/photos/{photoId}/process（解析のやり直し。段階3）
  process,

  /// PATCH /api/photos/{photoId}（コメントの編集。段階4）
  updatePhoto,

  /// GET /api/catalog/kinds（図鑑の種類の一覧。段階4）
  catalogKinds,

  /// GET /api/catalog/entries?kind=...&offset=...&limit=...（図鑑の項目の一覧。段階4）
  catalogEntries,

  /// GET /api/catalog/entry?kind=...&name=...&continuationToken=...（図鑑の項目の詳細。段階4）
  catalogEntry,

  /// GET /api/trips/{tripId}/timeline（タイムライン。段階5）
  timeline,

  /// POST /api/trips/{tripId}/timeline（タイムラインを作る・作り直す受付。段階5）
  timelineCreate,

  /// GET /api/trips/{tripId}/timeline/draft（下書きを読む。段階5）
  timelineDraft,

  /// DELETE /api/trips/{tripId}/timeline/draft（下書きをやめる。段階5）
  timelineDraftDelete,

  /// POST /api/trips/{tripId}/timeline/draft/write（文を書く受付。段階5）
  timelineWrite,

  /// PUT /api/trips/{tripId}/timeline/draft/scenes（区切りを保存する。段階5）
  timelineScenes,

  /// POST /api/trips/{tripId}/timeline/recut（完成版の区切りを直し始める。段階5）
  timelineRecut,

  /// GET /api/photos/{photoId}（写真を1枚読む。タイムラインのサムネイルから写真ビューアを開くとき）
  getPhoto,
}

/// 旅行アルバムの API（`/api/trips` の5つと、図鑑の種類の一覧 `GET /api/catalog/kinds`・項目の一覧 `GET /api/catalog/entries`・項目の詳細 `GET /api/catalog/entry`、写真の一覧 `GET /api/photos`・写真の移動 `POST /api/photos/move`・写真の削除 `DELETE /api/photos/{photoId}`・写真の送信 `POST /api/photos`・解析のやり直し `POST /api/photos/{photoId}/process`）の偽のサーバ。
/// 状態は [trips]・[unassignedPhotoCount]・[photosByTripId] の3つだけで、
/// 一覧も詳細も作成・更新・削除も、この同じ旅行のリストを読み書きする。
///
/// - 写真は旅行ごとに [photosByTripId] に持つ（キーは旅行の id。旅行に属さない写真は `none`）。
///   `GET /api/photos` は `tripId` で絞り込み、入れた順（サーバが返す順）に `limit`（クライアントが送らなければ [pageSize]）枚ずつ返す。
///   `category` があれば写真の `category` でも絞る（段階3）。`tripId` が無ければ旅行をまたぎ、全部の写真を `sortAt` の昇順に並べて返す。
///   どちらも無ければ 400「絞り込み条件を指定してください」、定義表に無いカテゴリは 400「カテゴリが無効です」（本物と同じ）。
///   前提: 本物の API は `sortAt` の昇順で返すので、[photosByTripId] の各リストも `sortAt` の昇順に並べて渡すこと。
///   偽のサーバは並べ替えず、続きの位置を「並びの位置」と `sortAt` の両方で決めるため、昇順でないと続きがずれる。
///   続きがあるときの `continuationToken` は最後に返した写真の目印（`<sortAt>|<id>|<位置>`）で、受け取ったものをそのまま次の要求に載せると続きが返る。
///   目印の写真が消えていれば、`sortAt` がそれより後の写真、または `sortAt` が同じで目印の元の位置以降の写真から返す
///   （本物は並び順の位置から続けるので、読んだ後に前の写真を消しても後ろを飛ばさない。
///   また、読んだ後に前に足された `sortAt` の早い写真は続きには出ない）
///   （旅行が無い `tripId` は 404 `TRIP_NOT_FOUND`。`none` は旅行の確認をしない）
/// - `POST /api/photos/move` は、[photosByTripId] の写真を移し先の旅行（`tripId: null` なら `none`）の末尾へ動かし、写真の `tripId` を書き換える。
///   移した写真の元の旅行と移し先の旅行の `photoCount`（と [unassignedPhotoCount]）も合わせて更新する。
///   応答は `{ moved, notFound }`（どの旅行にも無い id が `notFound`）。移し先の旅行が無ければ 404 `TRIP_NOT_FOUND`。
///   `photoIds` が空なら 400 `INVALID_REQUEST`、200件を超えても 400（実際のサーバと同じ検証。分けずに送る・空のまとまりを送るクライアントを落とすため）。
///   `tripId` のキーが無いときも 400（旅行から外すには `tripId: null` を明示する）。
///   既にその旅行にある写真は、動かさずに `moved` に入れる。
/// - `POST /api/photos`（multipart）は、`photoId` が `image` の SHA-256 と一致しなければ 400「写真IDが画像の内容と一致しません」（実際のサーバと同じ）。
///   既にある id は 200 で既存を返し（冪等）、無ければ宛先（`tripId` が無ければ `none`）の末尾に足して 201 を返す。宛先の旅行の `photoCount`（と [unassignedPhotoCount]）も増やす。
///   `takenAt`・`latitude`・`longitude` は写真に反映する（`location` は緯度と経度を持つときだけ。地名は null）。
///   `placeName` パートは `location.placeName` に入れ、`placeSource` を `device` にする（無ければ両方 null）。地名の検証（緯度・経度が無い・空・空白のみ・ファイル・100 文字超え）も実際のサーバと同じ。
///   `thumbnail` パートがあれば `thumbnailUrl` を入れ（無ければ null）、バイト列は [thumbnailsByPhotoId] に残す。サムネイルの検証（ファイルでない・形式・空・[thumbnailMaxSize] 超え）も実際のサーバと同じ。
///   実際のサーバと同じく、multipart でない・`photoId` の形式・画像の Content-Type（415）・画像が空・`tripId` の形式・`takenAt` の形式（実在する日時）・緯度と経度の片方だけ・位置情報の形式は 400/415（空文字のパートも「指定あり」として検証する）
/// - `POST /api/photos/{photoId}/process` は、写真を分類の待ち（`pending`・`classify`・回数 0・時刻は [processAcceptedAt]）にし、
///   手がかり（前後の空白を除き、空なら null）を `hint` に書き、コメントを消して、202 で `{ photo, urlExpiresAt }` を返す（docs/05_api_design.md §5.7）。
///   `step` は `processing.step` に書く。`step` が `classify` / `identify` でなければ 400「やり直す処理の種類が無効です」、`identify` でカテゴリが図鑑の種類でなければ 400「この写真は識別の対象ではありません」、手がかりが文字列でない・500 文字を超えるなら 400。無い写真は 404 `PHOTO_NOT_FOUND`
/// - `PATCH /api/photos/{photoId}` はコメントだけを書き換える（前後の空白を除き、空なら `comment`・`commentSource` を null、それ以外は `commentSource: "user"`）。
///   200 で `{ photo, urlExpiresAt }`。`comment` のキーが無い・文字列でも null でもない・500 文字を超えるなら 400、無い写真は 404 `PHOTO_NOT_FOUND`（本物と同じ文言）
/// - `DELETE /api/photos/{photoId}` は、写真を [photosByTripId] から取り除き、その旅行の `photoCount`（と [unassignedPhotoCount]）を減らす。
///   応答は `{ message }`。どの旅行にも無い id は 404 `PHOTO_NOT_FOUND`。
/// - `GET /api/catalog/kinds` は [catalogKinds] を返す。`GET /api/catalog/entries` は [catalogEntriesByKind] のその種類の項目を、入れた順（本物は名前順）に
///   `offset`（既定 0）から `limit`（既定 50）件返し、`total` は項目の総数。種類が [catalogKinds] に無ければ 400「図鑑の種類が無効です」、
///   `offset` が 0 以上の整数・`limit` が 1〜100 の整数でなければ 400「ページの指定が無効です」（本物と同じ）。
///   [catalogVanishedNames] の名前は、ページからは外すが `total` には数える（本物が、数えてから見出しを読むまでに写真が無くなった項目を外すのと同じ）。
///   受け取った `offset` は [catalogOffsetsReceived] に残す（続きの読み方は 03 §6.1 の決まり）
/// - `GET /api/catalog/entry` は、[photosByTripId] の全部の写真のうち `identification` の種類と名前（受け取った名前は前後の空白を除いてから比べる）が合い `matchesKind` が true のものを、
///   `sortAt` の昇順に `limit`（無ければ [pageSize]）枚ずつ返す。`entry` は信頼度が最も高い写真（同じなら識別の新しい写真）の識別から作り、`photoCount` は合う写真の枚数（本物と同じ。05 §5.14）。
///   合う写真が無ければ `entry: null`・`photos: []`・`continuationToken: null`。続きのトークンは次の位置（`entry:<位置>`）。
///   種類が無効・名前が無い（空白だけ）・トークンの形が違うときは 400（文言は本物と同じ）。受け取った名前とトークンは [catalogEntryQueriesReceived] に残す
/// - タイムライン（05 §5.15。段階5）: `GET …/timeline` は [timelinesByTripId] と [pendingPhotoCountByTripId] を返す。
///   `POST …/timeline` は、作っている途中なら 409 `TIMELINE_STATE_CONFLICT`、解析中の写真があれば 409 `TIMELINE_PHOTOS_PROCESSING`、それ以外は区切りの案の待ちの下書きを書いて 202。
///   `GET …/timeline/draft` は下書きの状態を返し、届いた回数を [timelineDraftReadsReceived] に数える。`DELETE …/timeline/draft` は下書きを消し（完成版も無ければタイムラインごと）、
///   `POST …/draft/write` は確かめ待ち・文の失敗の下書きを文の待ちにする（どちらも下書きが無ければ 404 `TIMELINE_NOT_FOUND`、状態が合わなければ 409）。
///   ワーカーが進んだことは、テストが [timelinesByTripId] を直接書き換えて表す。旅行が無ければどれも 404 `TRIP_NOT_FOUND`
/// - 「別の端末で変わった」は、テストが [trips] を直接書き換えて表す（旅行を足す・消す・枚数を変える）
/// - 宛先ごとに、応答を止める（[holds]）・次の呼び出しを失敗させる（[failNext]）ことができる
/// - 次の1回の呼び出しだけ、応答の中身（[failNext] の失敗を含む）は届いた時点の状態で決めたまま、返すのを止める（[holdNextReply]）こともできる。
///   遅れて届く古い応答（止めている間に別の端末で状態が変わる）を表す
/// - ホストと API キー（`?code=`）が合わなければ 404 を返す。宛先やキーの取り違えを検出するため（`catalogServer` と同じ考え方）
/// - 削除の要求の `deletePhotos` を [deletePhotosSent] に記録する。写真が0枚の旅行は `true` でも `false` でも応答が同じで、
///   結果からは何を送ったか見分けられない。二重に送られたかどうか（2回目は 404 になって成功扱いと区別しにくい）も、これで見る。
///   API が必須にしている `deletePhotos` を載せたかという、クライアントが送る要求そのものを確かめたいときだけ使う
class FakeTripBackend {
  FakeTripBackend({
    List<Map<String, Object?>> trips = const [],
    this.unassignedPhotoCount = 0,
    this.functionKey = 'saved-key',
    this.pageSize = 100,
    this.leadingEmptyPages = 0,
    Map<String, List<Map<String, Object?>>> photosByTripId = const {},
    Map<String, List<Map<String, Object?>>> catalogEntriesByKind = const {},
  })  : trips = [...trips],
        catalogEntriesByKind = {
          for (final entry in catalogEntriesByKind.entries) entry.key: [...entry.value],
        },
        photosByTripId = {
          for (final entry in photosByTripId.entries) entry.key: [...entry.value],
        };

  /// 旅行（新しい順。`GET /api/trips` はこの順に返す）。作成は先頭に足し、更新と削除はここを書き換える
  final List<Map<String, Object?>> trips;

  /// `GET /api/photos` の1ページの枚数（`limit` が無いときの既定。実際のサーバは 100。画面を超える枚数を少なく用意するために減らせる）
  final int pageSize;

  /// `GET /api/photos` が、先頭から読むとき最初に返す「写真が0枚で、続きのトークンが付いた」ページの数。
  /// 実際のサーバは、空のページを何度か読み直してもまだ空のとき、空のページをトークン付きで返すことがある（写真があっても起きる）。
  /// トークンを渡して読み進めると、この数だけ空のページを返したあと、写真の先頭から返す
  final int leadingEmptyPages;

  /// 図鑑の種類（`GET /api/catalog/kinds` の `kinds`。既定は本物の定義表と同じ3つ）
  List<Map<String, Object?>> catalogKinds = [
    {
      'kind': 'plant',
      'label': '植物',
      'fields': [
        {'key': 'scientificName', 'label': '学名', 'type': 'string'},
        {'key': 'familyName', 'label': '科名', 'type': 'string'},
      ],
    },
    {
      'kind': 'food',
      'label': '食べ物',
      'fields': [
        {'key': 'genre', 'label': '料理のジャンル', 'type': 'string'},
        {'key': 'mainIngredients', 'label': '主な食材', 'type': 'string[]'},
      ],
    },
    {
      'kind': 'landscape',
      'label': '風景',
      'fields': [
        {'key': 'placeType', 'label': '場所の種類', 'type': 'string'},
        {'key': 'placeName', 'label': '場所の名前', 'type': 'string'},
        {'key': 'region', 'label': '地域', 'type': 'string'},
      ],
    },
  ];

  /// 図鑑の項目（キーは種類。`GET /api/catalog/entries` はこの並びのまま返す。本物は名前順なので、名前順に並べて渡す）
  final Map<String, List<Map<String, Object?>>> catalogEntriesByKind;

  /// ページからは外すが総数には数える項目の名前（数えてから見出しを読むまでに写真が無くなった項目）
  final Set<String> catalogVanishedNames = {};

  /// `GET /api/catalog/entries` で受け取った `offset`（届いた順）
  final List<int> catalogOffsetsReceived = [];

  /// `GET /api/catalog/entry` で受け取った名前と継続トークン（届いた順。トークンが無ければ null）
  final List<({String? name, String? continuationToken})> catalogEntryQueriesReceived = [];

  /// 旅行に属さない写真の枚数。写真を残す削除で、その旅行の枚数だけ増える
  int unassignedPhotoCount;

  /// 旅行ごとの写真（キーは旅行の id、旅行に属さない写真は `none`）。`GET /api/photos` はこの並びのまま返す
  final Map<String, List<Map<String, Object?>>> photosByTripId;

  /// 写真 ID の形式（画像のバイト列の SHA-256。小文字16進 64 文字。本物の `PHOTO_VALIDATION.ID_REGEX` と同じ）
  static final _photoIdPattern = RegExp(r'^[0-9a-f]{64}$');

  /// 受け付ける API キー
  final String functionKey;

  /// 宛先ごとに、応答を返すのをこの Future が終わるまで止める（Completer の future を入れる）
  final Map<TripRoute, Future<void>> holds = {};

  /// 削除の要求ごとの `deletePhotos` の値（無ければ null）
  final List<String?> deletePhotosSent = [];

  /// 写真の送信（`POST /api/photos`）の要求が届いた回数（応答を保留する前に数える）。
  /// 要求が届くまで待つ印として使う。届いた要求の数そのものが仕様（docs/03_screen_design.md §4.7）の振る舞いであるときは、検証にも使う
  /// （送り直しの回数と間隔、404 の後に残りを送らないこと）。送れたかどうかは、写真が偽のサーバに入ったことで見る
  int uploadsReceived = 0;

  /// 旅行の取得（`GET /api/trips/{tripId}`）の要求が届いた回数（応答を保留する前に数える）。
  /// 応答は届いた時点の状態で決まるので、要求が旅行を消す前に届いたかを確かめる印として使う
  int tripFetchesReceived = 0;

  /// 写真の一覧（`GET /api/photos`）の要求が届いた回数（応答を保留する前に数える）。
  /// 「まだ続きのページを要求していない」ことを、応答が止まっていても確かめる印として使う
  int photoPagesReceived = 0;

  /// サムネイルの上限（サーバの `THUMBNAIL_MAX_SIZE` の既定値。1MB）
  static const thumbnailMaxSize = 1048576;

  /// 写真の送信で受け取ったサムネイルのバイト列（キーは写真の id）。写真を新しく保存したときだけ入る
  /// （既にある id の再送では、サムネイルを足さない。docs/05_api_design.md §5.1 の 3）
  final Map<String, List<int>> thumbnailsByPhotoId = {};

  /// 旅行ごとのタイムライン（`GET …/timeline` の `timeline`。キーが無ければ null）。
  /// ワーカーが区切り案を出した・文を書き終えた（完成版に入れ替わった）は、テストがここを直接書き換えて表す
  final Map<String, Map<String, Object?>> timelinesByTripId = {};

  /// 旅行ごとの、解析が済んでいない写真の枚数（`GET …/timeline` の `pendingPhotoCount`。無ければ 0）
  final Map<String, int> pendingPhotoCountByTripId = {};

  /// 下書きの読み取り（`GET …/timeline/draft`）の要求が届いた回数。画面が読み直しを止めたかを確かめる印として使う
  /// （5 秒ごとに読み直すこと・閉じたら止めることは 03 §8.1 の振る舞い）
  int timelineDraftReadsReceived = 0;

  /// 作る受付で書く下書きの開始時刻
  static const timelineStartedAt = '2026-10-25T09:00:00.000Z';

  // 次の呼び出しの失敗を、届いた時点で作る（応答を返すものと、通信が切れて例外になるもの）
  final Map<TripRoute, List<http.Response Function()>> _failures = {};
  final Map<TripRoute, List<Future<void>>> _replyHolds = {};
  var _createdCount = 0;
  var _timelineDraftCount = 0;

  /// [route] の次の1回の呼び出しを、[status] の封筒つきのエラーで失敗させる。呼ぶたびに1回分積まれ、順に使われる
  void failNext(
    TripRoute route, {
    int status = 503,
    String code = 'DATABASE_ERROR',
    String message = 'データベースに接続できません',
  }) {
    _failures.putIfAbsent(route, () => []).add(() => _error(status, code, message));
  }

  /// [route] の次の1回の呼び出しを、封筒の無い [status] の応答で失敗させる。
  /// 従量課金プランの Functions ランタイムが過負荷のときに返す 429 "Too Busy" のように、アプリを通らずに返る応答を表す
  void failNextWithoutEnvelope(TripRoute route, {int status = 429, String body = 'Too Busy'}) {
    _failures.putIfAbsent(route, () => []).add(() => http.Response(body, status, headers: const {'content-type': 'text/plain'}));
  }

  /// [route] の次の1回の呼び出しを、通信が切れて応答が返らない失敗（HTTP クライアントの例外）にする
  void failNextWithConnectionError(TripRoute route) {
    _failures.putIfAbsent(route, () => []).add(() => throw http.ClientException('Connection reset by peer'));
  }

  /// [route] の次の1回の呼び出しだけ、返すのを返り値の Completer が終わるまで止める。
  /// 応答の中身は呼び出しが届いた時点の状態で決まり、止めている間に状態を書き換えても変わらない（[holds] は解放されたときの状態で決まる）
  Completer<void> holdNextReply(TripRoute route) {
    final completer = Completer<void>();
    _replyHolds.putIfAbsent(route, () => []).add(completer.future);
    return completer;
  }

  /// やり直しを受け付けたときに、写真の `processing.updatedAt` に書く時刻
  static const processAcceptedAt = '2026-10-18T05:30:00.000Z';

  /// この偽のサーバにつなぐ HTTP クライアント
  late final MockClient client = MockClient(_handle);

  Future<http.Response> _handle(http.Request request) async {
    if (request.url.host != testApiHost || request.url.queryParameters['code'] != functionKey) {
      return http.Response('', 404);
    }
    final route = _routeOf(request);
    if (route == null) return http.Response('', 404);
    if (route == TripRoute.delete) {
      deletePhotosSent.add(request.url.queryParameters['deletePhotos']);
    }
    if (route == TripRoute.upload) uploadsReceived++;
    if (route == TripRoute.detail) tripFetchesReceived++;
    if (route == TripRoute.photos) photoPagesReceived++;
    if (route == TripRoute.timelineDraft) timelineDraftReadsReceived++;
    final hold = holds[route];
    if (hold != null) await hold;
    // 応答の中身（失敗を含む）は届いた時点で決め、返すのを止める指定があれば、そのあとで返す
    final failures = _failures[route];
    final failure = failures != null && failures.isNotEmpty ? failures.removeAt(0) : null;
    final replyHolds = _replyHolds[route];
    final replyHold = replyHolds != null && replyHolds.isNotEmpty ? replyHolds.removeAt(0) : null;
    final response = failure != null ? failure() : _respondTo(route, request);
    if (replyHold != null) await replyHold;
    return response;
  }

  http.Response _respondTo(TripRoute route, http.Request request) {
    switch (route) {
      case TripRoute.list:
        return _ok(200, {
          'trips': trips,
          'total': trips.length,
          'unassignedPhotoCount': unassignedPhotoCount,
        });
      case TripRoute.create:
        return _create(request);
      case TripRoute.detail:
        final trip = _find(request.url.pathSegments.last);
        return trip == null ? _notFound() : _ok(200, {'trip': trip});
      case TripRoute.update:
        return _update(request);
      case TripRoute.delete:
        return _delete(request);
      case TripRoute.photos:
        return _listPhotos(request);
      case TripRoute.move:
        return _movePhotos(request);
      case TripRoute.upload:
        return _uploadPhoto(request);
      case TripRoute.deletePhoto:
        return _deletePhoto(request);
      case TripRoute.process:
        return _processPhoto(request);
      case TripRoute.updatePhoto:
        return _updatePhoto(request);
      case TripRoute.catalogKinds:
        return _ok(200, {'kinds': catalogKinds});
      case TripRoute.catalogEntries:
        return _listCatalogEntries(request);
      case TripRoute.catalogEntry:
        return _catalogEntry(request);
      case TripRoute.timeline:
      case TripRoute.timelineCreate:
      case TripRoute.timelineDraft:
      case TripRoute.timelineDraftDelete:
      case TripRoute.timelineWrite:
      case TripRoute.timelineScenes:
      case TripRoute.timelineRecut:
        return _timeline(route, request);
      case TripRoute.getPhoto:
        return _getPhoto(request);
    }
  }

  /// タイムラインの API（05 §5.15）。旅行が無ければ 404 `TRIP_NOT_FOUND`
  http.Response _timeline(TripRoute route, http.Request request) {
    final tripId = request.url.pathSegments[2];
    if (_find(tripId) == null) return _notFound();
    final timeline = timelinesByTripId[tripId];
    final draft = timeline?['draft'] as Map<String, Object?>?;
    final job = draft?['job'] as Map<String, Object?>?;
    final working = job != null && (job['state'] == 'pending' || job['state'] == 'running');
    switch (route) {
      case TripRoute.timeline:
        return _ok(200, {
          'timeline': timeline == null ? null : {...timeline, 'draft': _draftStatusOf(draft)},
          'pendingPhotoCount': pendingPhotoCountByTripId[tripId] ?? 0,
          'urlExpiresAt': '2026-10-10T04:12:45.000Z',
        });
      case TripRoute.timelineCreate:
        if (working) return _timelineConflict();
        if ((pendingPhotoCountByTripId[tripId] ?? 0) > 0) {
          return _error(409, 'TIMELINE_PHOTOS_PROCESSING', '解析中の写真があります。終わってから作ってください');
        }
        final created = {
          'id': '0b8e1c5a-0000-4000-8000-${(_timelineDraftCount++).toString().padLeft(12, '0')}',
          'reason': timeline?['current'] == null ? 'create' : 'rebuild',
          'phase': 'proposing',
          'job': {'step': 'propose', 'state': 'pending', 'lastError': null},
          'startedAt': timelineStartedAt,
        };
        timelinesByTripId[tripId] = {
          'current': timeline?['current'],
          'draft': created,
          'changes': timeline?['changes'],
          'droppedEdits': timeline?['droppedEdits'] ?? <Object?>[],
        };
        return _ok(202, {'draft': created, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
      case TripRoute.timelineDraft:
        // 日と場面を返すのは、区切りを確かめられる下書きだけ（本物と同じ）
        return _ok(200, {'draft': draft != null && _isEditableDraft(draft) ? draft : _draftStatusOf(draft), 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
      case TripRoute.timelineDraftDelete:
        if (timeline == null || draft == null) {
          return _error(404, 'TIMELINE_NOT_FOUND', 'タイムラインの下書きが見つかりません');
        }
        if (timeline['current'] == null) {
          timelinesByTripId.remove(tripId);
        } else {
          timelinesByTripId[tripId] = {...timeline, 'draft': null};
        }
        return _ok(200, {'draft': null});
      case TripRoute.timelineWrite:
        if (timeline == null || draft == null) {
          return _error(404, 'TIMELINE_NOT_FOUND', 'タイムラインの下書きが見つかりません');
        }
        final writeFailed = draft['phase'] == 'writing' && job?['state'] == 'failed';
        if (draft['phase'] != 'reviewing' && !writeFailed) return _timelineConflict();
        final writing = {
          ...draft,
          'phase': 'writing',
          'job': {'step': 'write', 'state': 'pending', 'lastError': null},
        };
        timelinesByTripId[tripId] = {...timeline, 'draft': writing};
        return _ok(202, {'draft': _draftStatusOf(writing), 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
      case TripRoute.timelineRecut:
        final current = timeline?['current'] as Map<String, Object?>?;
        if (timeline == null || current == null) {
          return _error(404, 'TIMELINE_NOT_FOUND', 'タイムラインが見つかりません');
        }
        if (draft != null) return _timelineConflict();
        // 完成版の区切りを写した、確かめ中の下書き（本物と同じく文は持たない）
        final recut = {
          'id': '0b8e1c5a-0000-4000-8000-${(_timelineDraftCount++).toString().padLeft(12, '0')}',
          'reason': 'recut',
          'phase': 'reviewing',
          'job': null,
          'startedAt': timelineStartedAt,
          'days': [
            for (final day in (current['days'] as List).cast<Map<String, Object?>>())
              {
                'date': day['date'],
                'dayNumber': day['dayNumber'],
                'scenes': [
                  for (final scene in (day['scenes'] as List).cast<Map<String, Object?>>())
                    {...scene}..removeWhere((key, _) => const {'label', 'labelSource', 'note', 'noteSource'}.contains(key)),
                ],
              },
          ],
          'undatedPhotos': current['undatedPhotos'],
        };
        timelinesByTripId[tripId] = {...timeline, 'draft': recut};
        return _ok(200, {'draft': recut, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
      case TripRoute.timelineScenes:
        if (timeline == null || draft == null) {
          return _error(404, 'TIMELINE_NOT_FOUND', 'タイムラインの下書きが見つかりません');
        }
        if (!_isEditableDraft(draft)) return _timelineConflict();
        final starts = (jsonDecode(request.body) as Map<String, Object?>)['sceneStarts'];
        if (starts is! List || starts.any((start) => start is! String)) {
          return _error(400, 'INVALID_REQUEST', '区切りは写真IDの配列で指定してください');
        }
        final days = _recutDays(draft, starts.cast<String>());
        if (days == null) return _error(400, 'INVALID_REQUEST', '区切りが無効です');
        final saved = {...draft, 'phase': 'reviewing', 'job': null, 'days': days};
        timelinesByTripId[tripId] = {...timeline, 'draft': saved};
        return _ok(200, {'draft': saved, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
      default:
        throw StateError('タイムラインの宛先ではありません: $route');
    }
  }

  /// 区切りを確かめられる下書き（確かめ待ちか、文を書くのに失敗した。05 §5.15）
  bool _isEditableDraft(Map<String, Object?> draft) {
    final job = draft['job'] as Map<String, Object?>?;
    return draft['phase'] == 'reviewing' || (draft['phase'] == 'writing' && job?['state'] == 'failed');
  }

  /// 状態だけの下書き（`days`・`undatedPhotos` を外す。GET …/timeline と受付の応答の形）
  Map<String, Object?>? _draftStatusOf(Map<String, Object?>? draft) {
    if (draft == null) return null;
    return {...draft}
      ..remove('days')
      ..remove('undatedPhotos');
  }

  /// 下書きの日ごとの写真を [starts] で場面に分け直す。区切りが無効（下書きに無い写真・重なり・撮影の順でない）なら null。
  /// 本物と同じく、各日の最初の写真は区切りに無くても場面の始まりにする（補う）。
  /// 区切りを入れた主は本物と違い、日の最初は `day`、前の下書きでも区切りだった写真はその主を引き継ぎ、新しい区切りは `user` にする
  /// （本物は AI の案にあれば `ai`。クライアントはまだ読まないので、読むようになったら本物に合わせる）。消えた写真（控えにだけある写真）は表さない
  /// （そのため、日の最初の場面の写真が全部消えたとき、本物は次の場面を `day` にしないが、偽物は見えている最初の場面を `day` にする）
  List<Map<String, Object?>>? _recutDays(Map<String, Object?> draft, List<String> starts) {
    final previous = <String, Object?>{};
    final days = (draft['days'] as List).cast<Map<String, Object?>>();
    final photoIds = <String>{};
    for (final day in days) {
      for (final scene in (day['scenes'] as List).cast<Map<String, Object?>>()) {
        previous[scene['startPhotoId'] as String] = scene['startedBy'];
        for (final photo in (scene['photos'] as List).cast<Map<String, Object?>>()) {
          photoIds.add(photo['id'] as String);
        }
      }
    }
    if (starts.toSet().length != starts.length || !starts.every(photoIds.contains)) return null;
    // 撮影の順でなければ無効（本物と同じ。photoIds は日・場面・写真の順に足したので撮影の順）
    final order = photoIds.toList();
    for (var i = 1; i < starts.length; i++) {
      if (order.indexOf(starts[i - 1]) > order.indexOf(starts[i])) return null;
    }
    final result = <Map<String, Object?>>[];
    for (final day in days) {
      final photos = [
        for (final scene in (day['scenes'] as List).cast<Map<String, Object?>>())
          ...(scene['photos'] as List).cast<Map<String, Object?>>(),
      ];
      final scenes = <Map<String, Object?>>[];
      var current = <Map<String, Object?>>[];
      for (final photo in photos) {
        if (current.isNotEmpty && starts.contains(photo['id'])) {
          scenes.add(timelineSceneJson(current, startedBy: scenes.isEmpty ? 'day' : (previous[current.first['id']] as String? ?? 'user')));
          current = [];
        }
        current.add(photo);
      }
      scenes.add(timelineSceneJson(current, startedBy: scenes.isEmpty ? 'day' : (previous[current.first['id']] as String? ?? 'user')));
      result.add({...day, 'scenes': scenes});
    }
    return result;
  }

  http.Response _timelineConflict() =>
      _error(409, 'TIMELINE_STATE_CONFLICT', 'タイムラインが変わったか、作っている途中です。読み直してください');

  /// タイムラインの宛先（/api/trips/{tripId}/timeline・…/draft・…/draft/write）
  TripRoute? _timelineRouteOf(http.Request request) {
    final segments = request.url.pathSegments;
    if (segments.length < 4 || segments[0] != 'api' || segments[1] != 'trips' || segments[3] != 'timeline') return null;
    final rest = segments.sublist(4).join('/');
    return switch ((rest, request.method)) {
      ('', 'GET') => TripRoute.timeline,
      ('', 'POST') => TripRoute.timelineCreate,
      ('draft', 'GET') => TripRoute.timelineDraft,
      ('draft', 'DELETE') => TripRoute.timelineDraftDelete,
      ('draft/write', 'POST') => TripRoute.timelineWrite,
      ('draft/scenes', 'PUT') => TripRoute.timelineScenes,
      ('recut', 'POST') => TripRoute.timelineRecut,
      _ => null,
    };
  }


  http.Response _catalogEntry(http.Request request) {
    final query = request.url.queryParameters;
    final kind = query['kind'];
    final token = query['continuationToken'];
    catalogEntryQueriesReceived.add((name: query['name'], continuationToken: token));
    if (!catalogKinds.any((k) => k['kind'] == kind)) {
      return _error(400, 'INVALID_REQUEST', '図鑑の種類が無効です');
    }
    final name = query['name']?.trim() ?? '';
    if (name.isEmpty) {
      return _error(400, 'INVALID_REQUEST', '図鑑の項目の名前が指定されていません');
    }
    final start = token == null ? 0 : (token.startsWith('entry:') ? int.tryParse(token.substring(6)) : null);
    if (start == null) {
      return _error(400, 'INVALID_REQUEST', '継続トークンの形式が無効です');
    }
    final matching = [
      for (final photos in photosByTripId.values)
        for (final photo in photos)
          if (photo['identification'] case {'kind': final String k, 'matchesKind': true, 'name': final String n}
              when k == kind && n == name)
            photo
    ]..sort((a, b) => (a['sortAt'] as String).compareTo(b['sortAt'] as String));
    if (matching.isEmpty) {
      return _ok(200, {'entry': null, 'photos': <Object?>[], 'continuationToken': null, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
    }
    // 本物と同じく、信頼度の高い順、同じなら識別の新しい順（04 §5.6）
    int headOrder(Map<String, Object?> a, Map<String, Object?> b) {
      final x = a['identification'] as Map, y = b['identification'] as Map;
      final byConfidence = (y['confidence'] as num).compareTo(x['confidence'] as num);
      return byConfidence != 0 ? byConfidence : (y['at'] as String).compareTo(x['at'] as String);
    }
    final head = ([...matching]..sort(headOrder)).first;
    final identification = head['identification'] as Map<String, Object?>;
    final limit = int.tryParse(query['limit'] ?? '') ?? pageSize;
    final next = start + limit;
    return _ok(200, {
      'entry': {
        'kind': kind,
        'name': name,
        'confidence': identification['confidence'],
        'description': identification['description'],
        'characteristics': identification['characteristics'],
        'attributes': identification['attributes'] ?? <String, Object?>{},
        'photoCount': matching.length,
        'coverThumbnailUrl': head['thumbnailUrl'] ?? head['imageUrl'],
      },
      'photos': matching.skip(start).take(limit).toList(),
      'continuationToken': next < matching.length ? 'entry:$next' : null,
      'urlExpiresAt': '2026-10-10T04:12:45.000Z',
    });
  }

  http.Response _listCatalogEntries(http.Request request) {
    final query = request.url.queryParameters;
    final kind = query['kind'];
    if (!catalogKinds.any((k) => k['kind'] == kind)) {
      return _error(400, 'INVALID_REQUEST', '図鑑の種類が無効です');
    }
    final offsetParam = query['offset'];
    final limitParam = query['limit'];
    final offset = offsetParam == null ? 0 : (RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(offsetParam) ? int.parse(offsetParam) : -1);
    final limit = limitParam == null ? 50 : (RegExp(r'^[1-9][0-9]*$').hasMatch(limitParam) ? int.parse(limitParam) : -1);
    if (offset < 0 || limit < 1 || limit > 100) {
      return _error(400, 'INVALID_REQUEST', 'ページの指定が無効です');
    }
    catalogOffsetsReceived.add(offset);
    final all = catalogEntriesByKind[kind] ?? const [];
    final page = all
        .skip(offset)
        .take(limit)
        .where((entry) => !catalogVanishedNames.contains(entry['name']))
        .toList();
    return _ok(200, {'entries': page, 'total': all.length});
  }

  TripRoute? _routeOf(http.Request request) {
    final path = request.url.path;
    final timelineRoute = _timelineRouteOf(request);
    if (timelineRoute != null) return timelineRoute;
    if (path == '/api/trips') {
      return switch (request.method) {
        'GET' => TripRoute.list,
        'POST' => TripRoute.create,
        _ => null,
      };
    }
    if (path.startsWith('/api/trips/') && request.url.pathSegments.length == 3) {
      return switch (request.method) {
        'GET' => TripRoute.detail,
        'PUT' => TripRoute.update,
        'DELETE' => TripRoute.delete,
        _ => null,
      };
    }
    if (path == '/api/catalog/kinds' && request.method == 'GET') return TripRoute.catalogKinds;
    if (path == '/api/catalog/entries' && request.method == 'GET') return TripRoute.catalogEntries;
    if (path == '/api/catalog/entry' && request.method == 'GET') return TripRoute.catalogEntry;
    if (path == '/api/photos' && request.method == 'GET') return TripRoute.photos;
    if (path == '/api/photos' && request.method == 'POST') return TripRoute.upload;
    if (path == '/api/photos/move' && request.method == 'POST') return TripRoute.move;
    if (path.startsWith('/api/photos/') &&
        request.url.pathSegments.length == 4 &&
        request.url.pathSegments.last == 'process' &&
        request.method == 'POST') {
      return TripRoute.process;
    }
    if (path.startsWith('/api/photos/') && request.url.pathSegments.length == 3 && request.method == 'DELETE') {
      return TripRoute.deletePhoto;
    }
    if (path.startsWith('/api/photos/') && request.url.pathSegments.length == 3 && request.method == 'PATCH') {
      return TripRoute.updatePhoto;
    }
    if (path.startsWith('/api/photos/') && request.url.pathSegments.length == 3 && request.method == 'GET') {
      return TripRoute.getPhoto;
    }
    return null;
  }

  Map<String, Object?>? _find(String id) {
    for (final trip in trips) {
      if (trip['id'] == id) return trip;
    }
    return null;
  }

  http.Response _create(http.Request request) {
    final body = json.decode(request.body) as Map<String, dynamic>;
    final trip = tripJson(
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c${9000 + _createdCount++}',
      name: (body['name'] as String).trim(),
      description: body['description'] as String?,
      photoCount: 0,
    );
    trips.insert(0, trip);
    return _ok(201, {'trip': trip});
  }

  http.Response _update(http.Request request) {
    final trip = _find(request.url.pathSegments.last);
    if (trip == null) return _notFound();
    // 実際のサーバと同じく全体置き換え（name は前後の空白を除く。description は省略か null で消える）
    final body = json.decode(request.body) as Map<String, dynamic>;
    trip['name'] = (body['name'] as String).trim();
    trip['description'] = body['description'];
    return _ok(200, {'trip': trip});
  }

  http.Response _delete(http.Request request) {
    // 実際のサーバの順: deletePhotos の検証が先、旅行の有無が後
    final deletePhotos = request.url.queryParameters['deletePhotos'];
    if (deletePhotos == null) {
      return _error(400, 'INVALID_REQUEST', '写真を削除するかどうかを指定してください');
    }
    if (deletePhotos != 'true' && deletePhotos != 'false') {
      return _error(400, 'INVALID_REQUEST', '写真を削除するかどうかの指定が無効です');
    }
    final trip = _find(request.url.pathSegments.last);
    if (trip == null) return _notFound();
    trips.remove(trip);
    final photoCount = trip['photoCount'] as int;
    if (deletePhotos == 'false') unassignedPhotoCount += photoCount;
    return _ok(200, {
      'message': '旅行が正常に削除されました',
      'deletedPhotoCount': deletePhotos == 'true' ? photoCount : 0,
      'detachedPhotoCount': deletePhotos == 'false' ? photoCount : 0,
    });
  }

  http.Response _listPhotos(http.Request request) {
    final query = request.url.queryParameters;
    final tripId = query['tripId'];
    final category = query['category'];
    // 実際のサーバの検証の順（docs/05_api_design.md §5.2 の 1・3・6）
    if (tripId == null && category == null) return _error(400, 'INVALID_REQUEST', '絞り込み条件を指定してください');
    if (category != null && !const ['plant', 'food', 'landscape', 'other'].contains(category)) {
      return _error(400, 'INVALID_REQUEST', 'カテゴリが無効です');
    }
    if (tripId != null && tripId != 'none' && _find(tripId) == null) return _notFound();
    // 旅行を指定しなければ旅行をまたぐ（本物と同じく sortAt の昇順に並べる）
    final source = tripId != null
        ? photosByTripId[tripId] ?? const <Map<String, Object?>>[]
        : ([for (final photos in photosByTripId.values) ...photos]
          ..sort((a, b) => (a['sortAt'] as String).compareTo(b['sortAt'] as String)));
    final photos = category == null ? source : source.where((photo) => photo['category'] == category).toList();
    final limit = int.parse(query['limit'] ?? '$pageSize');
    final token = query['continuationToken'];
    const emptyTokenPrefix = 'empty-';
    final emptyPagesRead = token == null
        ? 0
        : token.startsWith(emptyTokenPrefix)
            ? int.parse(token.substring(emptyTokenPrefix.length))
            : leadingEmptyPages;
    if (emptyPagesRead < leadingEmptyPages) {
      return _ok(200, {
        'photos': <Map<String, Object?>>[],
        'continuationToken': '$emptyTokenPrefix${emptyPagesRead + 1}',
        'urlExpiresAt': '2026-10-10T04:12:45.000Z',
      });
    }
    final start = token == null || token.startsWith(emptyTokenPrefix) ? 0 : _startAfter(photos, token);
    final end = start + limit < photos.length ? start + limit : photos.length;
    return _ok(200, {
      'photos': photos.sublist(start, end),
      // 続きの目印は「最後に返した写真」（`<sortAt>|<id>`）。位置（何枚目か）にしない
      'continuationToken': end < photos.length ? _tokenAfter(photos[end - 1], end - 1) : null,
      'urlExpiresAt': '2026-10-10T04:12:45.000Z',
    });
  }

  /// 続きの目印。最後に返した写真の `sortAt`・id・そのときの位置
  String _tokenAfter(Map<String, Object?> lastReturned, int index) => '${lastReturned['sortAt']}|${lastReturned['id']}|$index';

  /// 目印の続きの開始位置。目印の写真がまだあればその直後、消えていれば `sortAt` がそれより後の最初の写真、
  /// または `sortAt` が同じで目印の元の位置以降の最初の写真から
  /// （実際の API は並び順の位置から続けるので、読んだ後に前の写真を消しても後ろを飛ばさない。
  /// `sortAt` が同じ写真を飛ばさないよう、元の位置も見る）
  int _startAfter(List<Map<String, Object?>> photos, String token) {
    final first = token.indexOf('|');
    final last = token.lastIndexOf('|');
    final sortAt = token.substring(0, first);
    final id = token.substring(first + 1, last);
    final originalIndex = int.parse(token.substring(last + 1));
    final index = photos.indexWhere((photo) => photo['id'] == id);
    if (index >= 0) return index + 1;
    final later = [for (var i = 0; i < photos.length; i++) i].indexWhere((i) {
      final order = (photos[i]['sortAt'] as String).compareTo(sortAt);
      return order > 0 || (order == 0 && i >= originalIndex);
    });
    return later >= 0 ? later : photos.length;
  }

  /// `POST /api/photos`（multipart。docs/05_api_design.md §5.1）。
  /// 写真の id（`photoId`）は画像のバイト列の SHA-256 でなければ 400 にする（実際のサーバと同じ。クライアントが正しいハッシュを送ったかを結果で見るため）。
  /// 既にある id は、動かさずに 200 で既存を返す（冪等）。無ければ、宛先（`tripId` が無ければ `none`）の末尾に足し、枚数を増やして 201 を返す
  http.Response _uploadPhoto(http.Request request) {
    if (!(request.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
      return _error(400, 'INVALID_REQUEST', 'Content-Typeがmultipart/form-dataではありません');
    }
    final parts = _parseMultipart(request);
    final photoId = parts['photoId']?.text;
    final image = parts['image'];
    // 実際のサーバの検証の順（docs/05_api_design.md §5.1）のうち、クライアントが取り違えうるもの。
    // 値が無いときはパートごと省く。空文字のパートは「指定あり」として検証され、400 になる
    if (photoId == null || photoId.isEmpty) return _error(400, 'INVALID_REQUEST', '写真IDが指定されていません');
    if (!_photoIdPattern.hasMatch(photoId)) return _error(400, 'INVALID_REQUEST', '写真IDの形式が無効です');
    if (image == null || image.filename == null) return _error(400, 'INVALID_REQUEST', '画像ファイルが指定されていません');
    // 画像の形式は、パートの Content-Type で判定する（クライアントが付け忘れると、既定の application/octet-stream になる）
    const supportedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!supportedTypes.contains(image.contentType)) {
      return _error(415, 'UNSUPPORTED_MEDIA_TYPE', 'サポートされていない画像形式です');
    }
    if (image.bytes.isEmpty) return _error(400, 'INVALID_REQUEST', '画像ファイルが空です');
    // サムネイルの検証（実際のサーバの 8〜11）。サムネイルは省けるので、あるときだけ見る
    final thumbnail = parts['thumbnail'];
    if (thumbnail != null) {
      if (thumbnail.filename == null) return _error(400, 'INVALID_REQUEST', 'サムネイルはファイルで送信してください');
      if (!supportedTypes.contains(thumbnail.contentType)) {
        return _error(415, 'UNSUPPORTED_MEDIA_TYPE', 'サポートされていない画像形式です');
      }
      if (thumbnail.bytes.isEmpty) return _error(400, 'INVALID_REQUEST', 'サムネイルが空です');
      if (thumbnail.bytes.length > thumbnailMaxSize) return _error(413, 'FILE_TOO_LARGE', 'サムネイルのサイズが大きすぎます');
    }
    final tripId = parts['tripId']?.text;
    if (tripId != null && !RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$').hasMatch(tripId)) {
      return _error(400, 'INVALID_REQUEST', '旅行IDの形式が無効です');
    }
    final takenAt = parts['takenAt']?.text;
    if (takenAt != null && !_isRealDateTime(takenAt)) {
      return _error(400, 'INVALID_REQUEST', '撮影日時の形式が無効です');
    }
    final latitudeText = parts['latitude']?.text;
    final longitudeText = parts['longitude']?.text;
    if ((latitudeText == null) != (longitudeText == null)) {
      return _error(400, 'INVALID_REQUEST', '緯度と経度は両方指定してください');
    }
    final decimal = RegExp(r'^-?\d+(\.\d+)?$');
    final latitude = latitudeText == null ? null : double.tryParse(latitudeText);
    final longitude = longitudeText == null ? null : double.tryParse(longitudeText);
    if (latitudeText != null &&
        (!decimal.hasMatch(latitudeText) ||
            !decimal.hasMatch(longitudeText!) ||
            latitude!.abs() > 90 ||
            longitude!.abs() > 180)) {
      return _error(400, 'INVALID_REQUEST', '位置情報の形式が無効です');
    }
    // 地名の検証（実際のサーバの 16・17）。緯度・経度と一緒でなければ断る。空・空白のみ・ファイル・100 文字超えも断る（前後の空白は除かずに数える）
    final placeNamePart = parts['placeName'];
    if (placeNamePart != null && latitudeText == null) {
      return _error(400, 'INVALID_REQUEST', '地名は緯度・経度と一緒に指定してください');
    }
    if (placeNamePart != null &&
        (placeNamePart.filename != null || placeNamePart.text.trim().isEmpty || placeNamePart.text.length > 100)) {
      return _error(400, 'INVALID_REQUEST', '地名は100文字以内で指定してください');
    }
    final placeName = placeNamePart?.text;
    if (sha256.convert(image.bytes).toString() != photoId) {
      return _error(400, 'INVALID_REQUEST', '写真IDが画像の内容と一致しません');
    }
    for (final photos in photosByTripId.values) {
      for (final photo in photos) {
        if (photo['id'] == photoId) return _ok(200, {'photo': photo, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
      }
    }
    if (tripId != null && _find(tripId) == null) return _notFound();
    const blobHost = 'https://stsnaplant.blob.core.windows.net/photos';
    final photo = photoJson(number: 0, tripId: tripId, takenAt: takenAt)
      ..['id'] = photoId
      ..['imageUrl'] = '$blobHost/$photoId.jpg?sv=2024-01-01&sig=test'
      ..['thumbnailUrl'] = thumbnail == null ? null : '$blobHost/$photoId.thumb.jpg?sv=2024-01-01&sig=test'
      ..['fileSize'] = image.bytes.length
      ..['location'] = latitude == null
          ? null
          : {
              'latitude': latitude,
              'longitude': longitude,
              'placeName': placeName,
              'placeSource': placeName == null ? null : 'device',
            };
    final targetKey = tripId ?? 'none';
    photosByTripId.putIfAbsent(targetKey, () => []).add(photo);
    if (thumbnail != null) thumbnailsByPhotoId[photoId] = thumbnail.bytes;
    _addToPhotoCount(targetKey, 1);
    return _ok(201, {'photo': photo, 'urlExpiresAt': '2026-10-10T04:12:45.000Z'});
  }

  /// `YYYY-MM-DDTHH:mm:ss` の形で、実在する日時か
  bool _isRealDateTime(String text) {
    final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$').firstMatch(text);
    if (match == null) return false;
    final n = [for (var i = 1; i <= 6; i++) int.parse(match.group(i)!)];
    final date = DateTime.utc(n[0], n[1], n[2], n[3], n[4], n[5]);
    return [date.year, date.month, date.day, date.hour, date.minute, date.second].toString() == n.toString();
  }

  /// multipart/form-data の本文を、パートの名前ごとに分ける
  Map<String, _MultipartPart> _parseMultipart(http.Request request) {
    final contentType = request.headers['content-type'] ?? '';
    final boundary = RegExp(r'boundary=(?:"([^"]+)"|([^;]+))').firstMatch(contentType);
    final delimiter = '--${boundary?.group(1) ?? boundary?.group(2)}';
    // バイト列を1文字1バイトの文字列として扱うと、区切りで分けても中身のバイト列を壊さない
    final body = latin1.decode(request.bodyBytes);
    final parts = <String, _MultipartPart>{};
    // 先頭は区切りの前（空）、末尾は閉じの `--`
    for (final raw in body.split(delimiter).skip(1)) {
      if (raw.startsWith('--')) break;
      final headerEnd = raw.indexOf('\r\n\r\n');
      final headers = raw.substring(0, headerEnd);
      final content = raw.substring(headerEnd + 4, raw.length - 2);
      final name = RegExp(r'name="([^"]*)"').firstMatch(headers)!.group(1)!;
      final filename = RegExp(r'filename="([^"]*)"').firstMatch(headers)?.group(1);
      final contentType = RegExp(r'content-type: *([^\r\n]+)', caseSensitive: false).firstMatch(headers)?.group(1);
      parts[name] = _MultipartPart(filename, contentType, latin1.encode(content));
    }
    return parts;
  }

  http.Response _deletePhoto(http.Request request) {
    final photoId = request.url.pathSegments.last;
    final sourceKey = photosByTripId.keys
        .where((key) => photosByTripId[key]!.any((photo) => photo['id'] == photoId))
        .firstOrNull;
    if (sourceKey == null) return _error(404, 'PHOTO_NOT_FOUND', '指定された写真が見つかりません');
    photosByTripId[sourceKey]!.removeWhere((photo) => photo['id'] == photoId);
    _addToPhotoCount(sourceKey, -1);
    return _ok(200, {'message': '写真が正常に削除されました'});
  }

  http.Response _processPhoto(http.Request request) {
    final photoId = request.url.pathSegments[2];
    final photo = photosByTripId.values.expand((photos) => photos).where((p) => p['id'] == photoId).firstOrNull;
    // 実際のサーバの検証の順（docs/05_api_design.md §5.7 の 1〜6）。写真の有無は検証の後に見る
    if (!_photoIdPattern.hasMatch(photoId)) return _error(400, 'INVALID_REQUEST', '写真IDの形式が無効です');
    final Object? body;
    try {
      body = json.decode(request.body);
    } on FormatException {
      return _error(400, 'INVALID_REQUEST', 'リクエストボディの形式が無効です');
    }
    if (body == null) return _error(400, 'INVALID_REQUEST', 'リクエストボディが指定されていません');
    // オブジェクトでないボディ（配列・数値など）は、本物と同じく処理の種類が無いものとして断る
    final step = body is Map<String, dynamic> ? body['step'] : null;
    if (body is! Map<String, dynamic> || (step != 'classify' && step != 'identify')) {
      return _error(400, 'INVALID_REQUEST', 'やり直す処理の種類が無効です');
    }
    final hint = body['hint'];
    if (hint != null && hint is! String) return _error(400, 'INVALID_REQUEST', '補足情報は文字列で指定してください');
    final trimmed = (hint as String?)?.trim() ?? '';
    if (trimmed.length > 500) return _error(400, 'INVALID_REQUEST', '補足情報は500文字以内で指定してください');
    if (photo == null) return _error(404, 'PHOTO_NOT_FOUND', '指定された写真が見つかりません');
    // 識別のやり直しは、カテゴリが図鑑の種類の写真だけ（本物の 8）
    if (step == 'identify' && !catalogKinds.any((k) => k['kind'] == photo['category'])) {
      return _error(400, 'INVALID_REQUEST', 'この写真は識別の対象ではありません');
    }
    photo['processing'] = {
      'state': 'pending',
      'step': step,
      'attempts': 0,
      'lastError': null,
      'updatedAt': processAcceptedAt,
    };
    photo['hint'] = trimmed.isEmpty ? null : trimmed;
    photo['comment'] = null;
    photo['commentSource'] = null;
    photo['updatedAt'] = processAcceptedAt;
    return _ok(202, {'photo': photo, 'urlExpiresAt': '2026-10-18T06:30:00.000Z'});
  }

  /// GET /api/photos/{photoId}: どの旅行（と旅行に属さない写真）にも無ければ 404 `PHOTO_NOT_FOUND`（本物と同じ文言）
  http.Response _getPhoto(http.Request request) {
    final photoId = request.url.pathSegments[2];
    final photo = photosByTripId.values.expand((photos) => photos).where((p) => p['id'] == photoId).firstOrNull;
    if (photo == null) return _error(404, 'PHOTO_NOT_FOUND', '指定された写真が見つかりません');
    return _ok(200, {'photo': photo, 'urlExpiresAt': '2026-10-18T06:30:00.000Z'});
  }

  http.Response _updatePhoto(http.Request request) {
    final photoId = request.url.pathSegments[2];
    final photo = photosByTripId.values.expand((photos) => photos).where((p) => p['id'] == photoId).firstOrNull;
    // 実際のサーバの検証の順（docs/05_api_design.md §5.6 の 1〜6・10。タグは送らないので検証しない）
    if (!_photoIdPattern.hasMatch(photoId)) return _error(400, 'INVALID_REQUEST', '写真IDの形式が無効です');
    final Object? body;
    try {
      body = json.decode(request.body);
    } on FormatException {
      return _error(400, 'INVALID_REQUEST', 'リクエストボディの形式が無効です');
    }
    if (body == null) return _error(400, 'INVALID_REQUEST', 'リクエストボディが指定されていません');
    if (body is! Map<String, dynamic> || !body.containsKey('comment')) {
      return _error(400, 'INVALID_REQUEST', '更新する項目が指定されていません');
    }
    final comment = body['comment'];
    if (comment != null && comment is! String) return _error(400, 'INVALID_REQUEST', 'コメントは文字列で指定してください');
    final trimmed = (comment as String?)?.trim() ?? '';
    if (trimmed.length > 500) return _error(400, 'INVALID_REQUEST', 'コメントは500文字以内で指定してください');
    if (photo == null) return _error(404, 'PHOTO_NOT_FOUND', '指定された写真が見つかりません');
    photo['comment'] = trimmed.isEmpty ? null : trimmed;
    photo['commentSource'] = trimmed.isEmpty ? null : 'user';
    photo['updatedAt'] = processAcceptedAt;
    return _ok(200, {'photo': photo, 'urlExpiresAt': '2026-10-18T06:30:00.000Z'});
  }

  http.Response _movePhotos(http.Request request) {
    final body = json.decode(request.body) as Map<String, dynamic>;
    final photoIds = (body['photoIds'] as List<dynamic>).cast<String>();
    final tripId = body['tripId'] as String?;
    final targetKey = tripId ?? 'none';
    // 実際のサーバと同じ上限と順（検証が先、旅行の有無が後。docs/05_api_design.md §5.5）
    if (photoIds.isEmpty) {
      return _error(400, 'INVALID_REQUEST', '写真IDが指定されていません');
    }
    if (photoIds.length > 200) {
      return _error(400, 'INVALID_REQUEST', '一度に移動できる写真は200枚までです');
    }
    // 外すときも `tripId: null` を明示する。キーが無いのは取り違えとして断る（実際のサーバの 7）
    if (!body.containsKey('tripId')) {
      return _error(400, 'INVALID_REQUEST', '移動先の旅行が指定されていません');
    }
    if (tripId != null && _find(tripId) == null) return _notFound();
    final moved = <String>[];
    final notFound = <String>[];
    for (final photoId in photoIds) {
      final sourceKey = photosByTripId.keys
          .where((key) => photosByTripId[key]!.any((photo) => photo['id'] == photoId))
          .firstOrNull;
      if (sourceKey == null) {
        notFound.add(photoId);
        continue;
      }
      moved.add(photoId);
      if (sourceKey == targetKey) continue;
      final photo = photosByTripId[sourceKey]!.firstWhere((photo) => photo['id'] == photoId);
      photosByTripId[sourceKey]!.remove(photo);
      photo['tripId'] = tripId;
      photosByTripId.putIfAbsent(targetKey, () => []).add(photo);
      _addToPhotoCount(sourceKey, -1);
      _addToPhotoCount(targetKey, 1);
    }
    return _ok(200, {'moved': moved, 'notFound': notFound});
  }

  /// 旅行（`none` なら旅行に属さない写真）の枚数を [delta] だけ増やす
  void _addToPhotoCount(String key, int delta) {
    if (key == 'none') {
      unassignedPhotoCount += delta;
      return;
    }
    final trip = _find(key);
    if (trip != null) trip['photoCount'] = (trip['photoCount'] as int) + delta;
  }

  http.Response _notFound() => _error(404, 'TRIP_NOT_FOUND', '指定された旅行が見つかりません');

  http.Response _ok(int status, Map<String, Object?> data) =>
      _respond(status, {'success': true, 'data': data});

  http.Response _error(int status, String code, String message) => _respond(status, {
        'success': false,
        'error': {'code': code, 'message': message},
      });

  // サーバの実際のヘッダに合わせる（charset なしの application/json。無いと日本語が化ける）
  http.Response _respond(int status, Map<String, Object?> body) =>
      http.Response(json.encode(body), status, headers: const {'content-type': 'application/json'});
}

// ---------------------------------------------------------------------------
// 旅行のテストが共有する前置き

/// タイムラインの下書き・完成版の写真の1枚（05 §5.15 の `photos`）。id は [photoJson] と同じく [number] から作る
Map<String, Object?> timelinePhotoJson(int number, String? takenAt,
    {String category = 'landscape', String? name, String? placeName}) {
  final id = number.toRadixString(16).padLeft(64, '0');
  return {
    'id': id,
    'takenAt': takenAt,
    'category': category,
    'name': name,
    'placeName': placeName,
    'thumbnailUrl': 'https://stsnaplant.blob.core.windows.net/photos/$id.thumb.jpg?sv=2024-01-01&sig=test',
  };
}

/// 場面（05 §5.15 の確かめ中の `scenes` の1つ）。印・時刻・地名・名前は [photos] から本物と同じ決まりで組む
Map<String, Object?> timelineSceneJson(List<Map<String, Object?>> photos, {String startedBy = 'ai'}) {
  List<String> distinct(String key) => [
        for (final value in {for (final photo in photos) photo[key]})
          if (value != null) value as String,
      ];
  return {
    'startPhotoId': photos.first['id'],
    'startedBy': startedBy,
    'hasFood': photos.any((photo) => photo['category'] == 'food'),
    'firstTakenAt': photos.first['takenAt'],
    'lastTakenAt': photos.last['takenAt'],
    'placeNames': distinct('placeName'),
    'names': distinct('name'),
    'photos': photos,
  };
}

/// 旅行「北海道 2026秋」の id
const hokkaidoTripId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/// 旅行「京都」の id（写真の移し先や、別の旅行の宛先に使う）
const kyotoTripId = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';

/// ステータス 500 の `ApiException.userMessage`（送信に失敗した行の理由に出る）
const serverErrorMessage = 'サーバーで問題が発生しています。しばらく待ってから再試行してください。';

/// 旅行「北海道 2026秋」（[photoCount] 枚、2026/10/05 〜 2026/10/08）の JSON
Map<String, Object?> hokkaidoTrip({int photoCount = 12, String? description}) {
  return tripJson(
    id: hokkaidoTripId,
    name: '北海道 2026秋',
    description: description,
    photoCount: photoCount,
    firstTakenAt: '2026-10-05T09:00:00',
    lastTakenAt: '2026-10-08T17:30:00',
  );
}

/// ダイアログ（`Dialog`。`AlertDialog` を含む）の中で [matching] を探す。
/// 「旅行を作る」「削除」などの文言は、画面の他の場所にも出るので、ダイアログの中に絞って探す
Finder inDialog(Finder matching) => find.descendant(of: find.byType(Dialog), matching: matching);

/// ダイアログの [label] のボタンをタップして、画面を進める
Future<void> tapInDialog(WidgetTester tester, String label) async {
  await tester.tap(inDialog(find.text(label)));
  await letFramesRun(tester);
}

/// ダイアログの旅行名の欄（最初の入力欄）に [name] を入れる
Future<void> enterTripName(WidgetTester tester, String name) async {
  await tester.enterText(inDialog(find.byType(TextField)).first, name);
}

/// ダイアログのメモの欄（2つ目の入力欄）に [memo] を入れる
Future<void> enterTripMemo(WidgetTester tester, String memo) async {
  await tester.enterText(inDialog(find.byType(TextField)).at(1), memo);
}

/// 旅行詳細画面のメニューから「編集」を選んで、編集ダイアログを開く
Future<void> openEditDialog(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.more_vert));
  await letFramesRun(tester);
  await tester.tap(find.text('編集'));
  await letFramesRun(tester);
}

/// 旅行詳細画面のメニューから「削除」を選んで、削除の確認ダイアログを開く
Future<void> openDeleteDialog(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.more_vert));
  await letFramesRun(tester);
  await tester.tap(find.text('削除'));
  await letFramesRun(tester);
}

/// 撮影日時 [label]（例 `2026年10月5日 12:30`）を読み上げ用ラベルに持つサムネイル。
/// 画像そのものはテスト環境で読み込めないので、どの写真かはこのラベルで見分ける（`tester.ensureSemantics()` が要る）。
/// ラベルに他の文言（画像の読み込み失敗の表示など）が続いていても一致するよう、部分一致で探す
Finder photoThumbnail(String label) => find.bySemanticsLabel(RegExp(RegExp.escape(label)));

/// 進み具合バナーの「写真を準備中... k/[total]」（k は準備が済んだ枚数）。k は準備の進み具合で変わるので、分母と形式で探す。
/// 準備が終わるとバナーは消えるので、これが見えている間は準備が続いている
Finder preparingBanner(int total) => find.byWidgetPredicate(
    (widget) => widget is Text && RegExp('^写真を準備中\\.\\.\\. \\d+/$total\$').hasMatch(widget.data ?? ''));

/// 進み具合バナー「写真を準備中... k/[total]」の k（準備が済んだ枚数）を読み取る。バナーが1つ出ているときに使う
int preparedCountInBanner(int total) {
  final text = (preparingBanner(total).evaluate().single.widget as Text).data!;
  return int.parse(RegExp(r'(\d+)/').firstMatch(text)!.group(1)!);
}

/// multipart/form-data の1パート。ファイルのパートは [filename] を持つ
class _MultipartPart {
  _MultipartPart(this.filename, this.contentType, this.bytes);

  final String? filename;

  /// ファイルのパートの Content-Type（無ければ null）
  final String? contentType;
  final List<int> bytes;

  /// テキストのパートの値
  String get text => utf8.decode(bytes);
}

/// 端末に API キーを保存した状態でアプリ全体を開き、旅行タブに切り替える。
/// 偽のサーバは API キーを照合するので、保存するキーは [backend] の `functionKey`（既定の 'saved-key'）。
/// 起動時のタブの図鑑も偽のサーバから種類と項目を読むが、隠れているので旅行タブの表示に影響しない
/// （項目の表紙の画像は実時間を進めると取りに行くので、図鑑に項目を置くテストで runAsync を使うときは path_provider に注意。CLAUDE.md）
Future<void> openTripsTab(WidgetTester tester, FakeTripBackend backend) async {
  useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': backend.functionKey}));
  SharedPreferences.setMockInitialValues({});
  await saveTestEndpoint(tester);
  await openApp(tester, app: SnapPlantApp(httpClient: backend.client));
  await tester.tap(find.text('旅行'));
  await letFramesRun(tester);
}

/// アプリを開く。起動時のタブは図鑑なので、何も押さずに図鑑の種類の一覧と、最初の種類の項目の一覧を読み込むまで進める
Future<void> openCatalogTab(WidgetTester tester, FakeTripBackend backend) async {
  useSecureStorage(TestFlutterSecureStoragePlatform({'api_key': backend.functionKey}));
  SharedPreferences.setMockInitialValues({});
  await saveTestEndpoint(tester);
  await openApp(tester, app: SnapPlantApp(httpClient: backend.client));
  await letFramesRun(tester);
}

/// 図鑑の項目（`GET /api/catalog/entries` の1件）。表紙の URL は Blob の場所に署名を付けた形。
/// 本物の信頼度は数（小数もある）で、説明と特徴は AI が返さなければ null（05 §3.3.1）。
/// [description]・[characteristics] を省く（既定の ''）と「{名前}の説明」「{名前}の特徴」になる（空文字の説明は作れない）
Map<String, Object?> catalogEntryJson(String kind, String name,
        {num confidence = 90, int photoCount = 1, String? description = '', String? characteristics = ''}) => {
      'kind': kind,
      'name': name,
      'confidence': confidence,
      'description': description == '' ? '$nameの説明' : description,
      'characteristics': characteristics == '' ? '$nameの特徴' : characteristics,
      'attributes': <String, Object?>{},
      'photoCount': photoCount,
      'coverThumbnailUrl': 'https://test.blob.core.windows.net/photos/${name.hashCode}.thumb.jpg?sv=2024&sig=test',
    };

/// 識別が済んだ写真（[photoJson] に分類と識別を足したもの。04 §2.1 の `identification`）。
/// [matchesKind] が false なら、分類と識別が合わなかった写真（図鑑の項目には入らない）
Map<String, Object?> identifiedPhotoJson({
  required int number,
  required String kind,
  required String name,
  String? tripId,
  String? takenAt,
  num confidence = 90,
  bool matchesKind = true,
  String? description,
  String? characteristics,
  Map<String, Object?> attributes = const {},
}) =>
    {
      ...photoJson(number: number, tripId: tripId, takenAt: takenAt),
      'category': kind,
      // 分類と合わない写真は、本物と同じく名前・説明・特徴を null、欄を空にし、理由を reason に書く（04 §3.1）。[name] などは使わない
      'identification': {
        'kind': kind,
        'matchesKind': matchesKind,
        'name': matchesKind ? name : null,
        'confidence': confidence,
        'description': matchesKind ? description : null,
        'characteristics': matchesKind ? characteristics : null,
        'attributes': matchesKind ? attributes : <String, Object?>{},
        'reason': matchesKind ? null : '写真に$kindが写っていない',
        'model': 'gpt-6-luna',
        'at': '2026-10-10T03:20:00.000Z',
      },
      'processing': {'state': 'done', 'step': null, 'attempts': 0, 'lastError': null, 'updatedAt': '2026-10-10T03:20:00.000Z'},
    };

/// 偽のサーバの [tripKey]（旅行の id。旅行に属さない写真は `none`）に写真が [count] 枚届くまで、実時間で少しずつ待つ（最長 10 秒）。
/// 写真の準備（ファイルの読み込み・ハッシュ・EXIF）は別の isolate で実時間で進むので、`tester.runAsync` の中で待つ。
/// 届かなければ、届いた枚数を添えて失敗にする。待っている間は画面を進めない（写真のサムネイルを出す前に待ち終える。
/// 出した後に実時間を進めると、画像のキャッシュが端末の機能（path_provider）を探して落ちる）
Future<void> waitUntilUploaded(WidgetTester tester, FakeTripBackend backend, String tripKey, {int count = 1}) async {
  for (var i = 0; i < 200 && (backend.photosByTripId[tripKey] ?? []).length < count; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  }
  final arrived = (backend.photosByTripId[tripKey] ?? []).length;
  if (arrived < count) fail('写真が $count 枚届くはずが、$arrived 枚しか届かなかった（待った時間は 10 秒）');
}

/// 偽のサーバに写真の送信の要求が [count] 回届くまで、実時間で少しずつ待つ（最長 10 秒）。
/// 応答を保留している（写真がまだ入っていない）間に、要求が届いたことを待つために使う。
/// 届かなければ、届いた回数を添えて失敗にする
Future<void> waitUntilUploadsReceived(WidgetTester tester, FakeTripBackend backend, int count) async {
  for (var i = 0; i < 200 && backend.uploadsReceived < count; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  }
  if (backend.uploadsReceived < count) {
    fail('写真の送信の要求が $count 回届くはずが、${backend.uploadsReceived} 回しか届かなかった');
  }
}

/// [finder] に当たるものが出るまで、実時間で少しずつ待ち、画面を進める（既定は 100 ミリ秒ずつ。上限は実時間の [timeout]、既定は 30 秒）。
/// 別の isolate での準備（ファイルの読み込み）の結果が、画面に知らせとして出るのを待つために使う。
/// 準備と送信は、1枚につき画面を2回進めるごとに進むので、数十枚以上を待つときは [step] を短くする
/// （1ミリ秒ずつなら、100枚の準備と送信が 1〜2 秒で終わる）。
/// [timeout] が尽きても出なければ、待った時間と探したものを添えて失敗にする。写真のサムネイルが出る前に待ち終える使い方に限る
/// （出した後に実時間を進めると、画像のキャッシュが端末の機能（path_provider）を探して落ちる）
Future<void> waitUntilFound(
  WidgetTester tester,
  Finder finder, {
  Duration step = const Duration(milliseconds: 100),
  Duration timeout = const Duration(seconds: 30),
}) async {
  final stopwatch = Stopwatch()..start();
  while (finder.evaluate().isEmpty) {
    if (stopwatch.elapsed > timeout) {
      fail('$finder が、実時間で ${timeout.inSeconds} 秒待っても出なかった');
    }
    await tester.runAsync(() => Future<void>.delayed(step));
    await tester.pump(step);
  }
}

/// [finder] に当たるものが出るまで、フェイクの時間を 100 ミリ秒ずつ進める（最長 10 秒分）。実時間は進めない。
/// スナックバーは順に出る（先の知らせが消えるまで、あとの知らせは待つ）ので、表示時間の具体値に頼らずに待つために使う。
/// 出なくても例外にせず戻る（検証は呼び出し側）
Future<void> pumpUntilFound(WidgetTester tester, Finder finder) async {
  for (var i = 0; i < 100 && finder.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
