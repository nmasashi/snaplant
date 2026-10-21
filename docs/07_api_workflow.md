# SnapPlant APIワークフロー設計書

## 1. 概要

SnapPlant における API 呼び出しの実行順序とデータフローを定義する文書です。

**今あるワークフローは、すべて旅行アルバムのものです。** まだこの文書に取り込んでいないので、次を参照してください
（取り込みは機能が固まってから後でまとめて行う。2026-10-12 に決定）。

| 内容 | 文書 |
|---|---|
| 写真の送信・一覧・移動・削除、旅行、図鑑の API と、各エンドポイントの書く順 | [docs/travel-album/05_api_design.md](./travel-album/05_api_design.md) |
| 写真の分類と識別（キューとワーカー）、再投入と掃除のタイマー、失敗と再試行 | [docs/travel-album/06_processing_design.md](./travel-album/06_processing_design.md) |
| 途中で失敗したときに何が残り、どう直るか | [docs/travel-album/04_data_design.md](./travel-album/04_data_design.md) §7 |
| 画面から API をどう使うか、エラー時の表示 | [docs/travel-album/03_screen_design.md](./travel-album/03_screen_design.md) |

植物図鑑の登録フロー（画像のアップロードと識別 → 重複確認 → 保存または画像の更新 → 一覧）は、
API ごと 4-6 で削除しました（`docs/travel-album/06_processing_design.md` §7 の手順 5。`06_api_design.md` §1）。

## 2. 画像の Content-Type の決め方（クライアント）

写真の送信（`POST /api/photos`）で、Flutter クライアントは `image` パートの Content-Type を、拡張子や OS の申告値ではなく
ファイル先頭のシグネチャから決めます（`mobile/lib/utils/image_mime_type.dart`）。

| 形式 | 先頭のバイト列 | 送る Content-Type |
|------|---------------|------------------|
| PNG | `89 50 4E 47 0D 0A 1A 0A` | `image/png` |
| JPEG | `FF D8 FF` | `image/jpeg` |
| GIF | `GIF87a` または `GIF89a`（ASCII） | `image/gif` |
| WebP | 先頭が `RIFF`、8バイト目から `WEBP`（ASCII） | `image/webp` |

サーバは送られた Content-Type を許可する形式と照合するだけで中身は見ず、
そこから Blob の Content-Type と拡張子を決めます。そのため拡張子が `.jpg` でも
中身が PNG なら `image/png` で送ります。
どのシグネチャにも当たらない中身は `image/jpeg` として送ります。HEIC など4形式以外も
この既定値のまま受理されます（扱いは `09_backlog.md` の
「判定できない画像形式を `image/jpeg` として送る」で判断待ち）。

## 3. 運用監視

### 3.1 アラート

アラートルールは定義していない（`infrastructure/` に該当するリソースが無い）。
予算アラート（`azurerm_consumption_budget_resource_group`）だけがある（`infrastructure/README.md`）。
