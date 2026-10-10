import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:snaplant_mobile/models/plant.dart';
import 'package:snaplant_mobile/screens/identification_screen.dart';
import 'package:snaplant_mobile/services/api_service.dart';

// サーバ（Azure Functions）は画面から見てプロセス外の依存なので、
// ApiService の HTTP 層を MockClient で差し替える。
// 重複チェックは「同名の植物なし」、保存は引数で指定したレスポンスを返す。

const _jsonHeaders = {'content-type': 'application/json'};

ApiService _serviceWhereSaveReturns(int statusCode, Map<String, dynamic> body) {
  return ApiService(
    baseUrl: 'https://api.example.test',
    client: MockClient((request) async {
      if (request.url.path == '/api/plants/check-duplicate') {
        return http.Response(
          json.encode({'success': true, 'data': {'exists': false}}),
          200,
          headers: _jsonHeaders,
        );
      }
      if (request.url.path == '/api/plants/save') {
        return http.Response(json.encode(body), statusCode, headers: _jsonHeaders);
      }
      return http.Response('', 404);
    }),
  );
}

const _identificationResult = IdentificationResult(
  isPlant: true,
  confidence: 95.0,
  candidates: [
    PlantCandidate(name: '桜', characteristics: '春に咲く', confidence: 95.0),
  ],
);

/// 識別画面を一覧画面の上に積み、pop で返された値を記録する
Future<List<Object?>> _openIdentificationScreen(WidgetTester tester, ApiService apiService) async {
  // 既定のテスト画面（800×600）では保存ボタンが画面外に出てタップできない。
  // 画面が想定している実機の解像度に合わせる
  tester.view.physicalSize = const Size(1440, 2960);
  tester.view.devicePixelRatio = 3.5;
  addTearDown(tester.view.reset);

  final popped = <Object?>[];
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: TextButton(
          onPressed: () async {
            popped.add(await Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => IdentificationScreen(
                  identificationResult: _identificationResult,
                  imagePath: 'https://stsnaplant.blob.core.windows.net/images/a.jpg',
                  apiService: apiService,
                ),
              ),
            ));
          },
          child: const Text('識別画面を開く'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('識別画面を開く'));
  await tester.pumpAndSettle();
  return popped;
}

Future<void> _tapSave(WidgetTester tester) async {
  final saveButton = find.text('保存');
  await tester.ensureVisible(saveButton);
  await tester.pumpAndSettle();
  await tester.tap(saveButton);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('既に保存済みの画像を保存し直すと、その旨を伝えて一覧へ戻る', (tester) async {
    final popped = await _openIdentificationScreen(
      tester,
      _serviceWhereSaveReturns(409, {
        'success': false,
        'error': {'code': 'IMAGE_ALREADY_SAVED', 'message': 'この画像は既に保存されています'},
      }),
    );

    await _tapSave(tester);

    expect(popped, [true]);
    expect(find.text('この画像は既に保存されています'), findsOneWidget);
  });

  testWidgets('同じ409でもデータベースの競合は保存の失敗として画面に留まる', (tester) async {
    final popped = await _openIdentificationScreen(
      tester,
      _serviceWhereSaveReturns(409, {
        'success': false,
        // 画面の汎用フォールバック（'植物の保存に失敗しました'）と区別できるよう、サーバの文言は別にする
        'error': {'code': 'DATABASE_ERROR', 'message': 'データベースで競合が発生しました'},
      }),
    );

    await _tapSave(tester);

    expect(popped, isEmpty);
    expect(find.text('データベースで競合が発生しました'), findsOneWidget);
  });
}
