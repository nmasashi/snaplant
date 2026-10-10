/// API レスポンスの封筒
///
/// サーバ（`api/src/utils/response.ts`）はすべてのレスポンスをこの形で返す。
/// - 成功: `{ success: true, data }`
/// - 失敗: `{ success: false, error: { code, message, details? } }`
class ApiResponse<T> {
  final bool success;
  final T? data;
  final ApiError? error;

  const ApiResponse({
    required this.success,
    this.data,
    this.error,
  });

  factory ApiResponse.fromJson(
    Map<String, dynamic> json,
    T Function(dynamic) fromJsonT,
  ) {
    return ApiResponse(
      success: json['success'] as bool,
      data: json['data'] != null ? fromJsonT(json['data']) : null,
      error: json['error'] != null
          ? ApiError.fromJson(json['error'] as Map<String, dynamic>)
          : null,
    );
  }

  @override
  String toString() {
    return 'ApiResponse(success: $success, data: $data, error: $error)';
  }
}

/// API エラー詳細（封筒の `error`）
///
/// ステータスコードはボディに含まれないため、ここには持たない。
class ApiError {
  final String code;
  final String message;
  final String? details;

  const ApiError({
    required this.code,
    required this.message,
    this.details,
  });

  factory ApiError.fromJson(Map<String, dynamic> json) {
    return ApiError(
      code: json['code'] as String,
      message: json['message'] as String,
      details: json['details'] as String?,
    );
  }

  @override
  String toString() {
    return 'ApiError(code: $code, message: $message)';
  }
}

/// 画像アップロード結果
class UploadResult {
  final String imagePath;
  final String? imageUrl;

  const UploadResult({
    required this.imagePath,
    this.imageUrl,
  });

  factory UploadResult.fromJson(Map<String, dynamic> json) {
    return UploadResult(
      imagePath: json['imagePath'] as String,
      imageUrl: json['imageUrl'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'imagePath': imagePath,
      'imageUrl': imageUrl,
    };
  }
}
