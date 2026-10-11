import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:snaplant_mobile/screens/plant_detail_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';

// サーバ（Azure Functions）は画面から見てプロセス外の依存なので、
// ApiService の HTTP 層を MockClient で差し替える。
// GET /api/plants/{id} にだけ応答し、それ以外は 404 にする（宛先の誤りを検出する）。

const _jsonHeaders = {'content-type': 'application/json'};

ApiService _serviceWherePlantWasSavedAt(String createdAt) {
  return ApiService(
    baseUrl: 'https://api.example.test',
    client: MockClient((request) async {
      if (request.method == 'GET' && request.url.path == '/api/plants/plant-1') {
        return http.Response(
          json.encode({
            'success': true,
            'data': {
              'plant': {
                'id': 'plant-1',
                'name': '桜',
                'characteristics': '春に咲く',
                'confidence': 95.0,
                'imagePath': 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
                'createdAt': createdAt,
                // 保存してから更新していない植物。「更新日時」の行を出さず、保存日時だけを見る
                'updatedAt': createdAt,
              },
            },
          }),
          200,
          headers: _jsonHeaders,
        );
      }
      return http.Response('', 404);
    }),
  );
}

void main() {
  testWidgets('保存日時は UTC ではなく端末の時刻（日本時間）で表示する', (tester) async {
    // 期待値は日本時間（UTC+9）の文字列。UTC の環境では別の値になるので、
    // 前提が満たされないときは黙って通らず、理由を添えて失敗させる
    expect(
      DateTime(2026, 10, 12).timeZoneOffset,
      const Duration(hours: 9),
      reason: 'このテストは端末のタイムゾーンが日本時間（UTC+9）であることを前提にしている',
    );
    // 既定のテスト画面（800×600）ではなく、画面が想定している実機の解像度に合わせる
    tester.view.physicalSize = const Size(1440, 2960);
    tester.view.devicePixelRatio = 3.5;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      home: PlantDetailScreen(
        plantId: 'plant-1',
        // 日本時間では 2026年10月12日 00:30（日付をまたぐ）
        apiService: _serviceWherePlantWasSavedAt('2026-10-11T15:30:00.000Z'),
      ),
    ));
    // 背景画像のプレースホルダーが回り続けるため、pumpAndSettle は終わらない。
    // 応答の反映とスクロール位置の反映に必要な分だけフレームを進める
    await tester.pump();
    await tester.pump();

    await tester.ensureVisible(find.text('保存日時:'));
    await tester.pump();

    expect(find.text('2026年10月12日 00:30'), findsOneWidget);
  });
}
