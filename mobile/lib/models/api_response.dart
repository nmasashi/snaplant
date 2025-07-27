/// API レスポンスの基本構造
class ApiResponse<T> {
  final bool success;
  final T? data;
  final String? error;
  final String? message;

  const ApiResponse({
    required this.success,
    this.data,
    this.error,
    this.message,
  });

  factory ApiResponse.success(T data, [String? message]) {
    return ApiResponse(
      success: true,
      data: data,
      message: message,
    );
  }

  factory ApiResponse.error(String error, [String? message]) {
    return ApiResponse(
      success: false,
      error: error,
      message: message,
    );
  }

  factory ApiResponse.fromJson(
    Map<String, dynamic> json,
    T Function(dynamic) fromJsonT,
  ) {
    return ApiResponse(
      success: json['success'] as bool? ?? true,
      data: json['data'] != null ? fromJsonT(json['data']) : null,
      error: json['error'] as String?,
      message: json['message'] as String?,
    );
  }

  Map<String, dynamic> toJson(dynamic Function(T) toJsonT) {
    return {
      'success': success,
      'data': data != null ? toJsonT(data as T) : null,
      'error': error,
      'message': message,
    };
  }

  @override
  String toString() {
    return 'ApiResponse(success: $success, data: $data, error: $error, message: $message)';
  }
}

/// API エラー詳細
class ApiError {
  final String code;
  final String message;
  final String? detail;
  final int statusCode;

  const ApiError({
    required this.code,
    required this.message,
    this.detail,
    required this.statusCode,
  });

  factory ApiError.fromJson(Map<String, dynamic> json) {
    return ApiError(
      code: json['code'] as String,
      message: json['message'] as String,
      detail: json['detail'] as String?,
      statusCode: json['statusCode'] as int,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'code': code,
      'message': message,
      'detail': detail,
      'statusCode': statusCode,
    };
  }

  @override
  String toString() {
    return 'ApiError(code: $code, message: $message, statusCode: $statusCode)';
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