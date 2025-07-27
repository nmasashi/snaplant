import 'package:flutter/foundation.dart';

/// 植物データモデル
class Plant {
  final String id;
  final String name;
  final String? scientificName;
  final String? familyName;
  final String? description;
  final String characteristics;
  final double confidence;
  final String imagePath;
  final DateTime createdAt;
  final DateTime updatedAt;

  const Plant({
    required this.id,
    required this.name,
    this.scientificName,
    this.familyName,
    this.description,
    required this.characteristics,
    required this.confidence,
    required this.imagePath,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Plant.fromJson(Map<String, dynamic> json) {
    return Plant(
      id: json['id'] as String,
      name: json['name'] as String,
      scientificName: json['scientificName'] as String?,
      familyName: json['familyName'] as String?,
      description: json['description'] as String?,
      characteristics: json['characteristics'] as String,
      confidence: (json['confidence'] as num).toDouble(),
      imagePath: json['imagePath'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'scientificName': scientificName,
      'familyName': familyName,
      'description': description,
      'characteristics': characteristics,
      'confidence': confidence,
      'imagePath': imagePath,
      'createdAt': createdAt.toIso8601String(),
      'updatedAt': updatedAt.toIso8601String(),
    };
  }

  Plant copyWith({
    String? id,
    String? name,
    String? scientificName,
    String? familyName,
    String? description,
    String? characteristics,
    double? confidence,
    String? imagePath,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return Plant(
      id: id ?? this.id,
      name: name ?? this.name,
      scientificName: scientificName ?? this.scientificName,
      familyName: familyName ?? this.familyName,
      description: description ?? this.description,
      characteristics: characteristics ?? this.characteristics,
      confidence: confidence ?? this.confidence,
      imagePath: imagePath ?? this.imagePath,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  @override
  String toString() {
    return 'Plant(id: $id, name: $name, confidence: $confidence)';
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is Plant && other.id == id;
  }

  @override
  int get hashCode => id.hashCode;
}

/// 植物要約（一覧表示用）
class PlantSummary {
  final String id;
  final String name;
  final String characteristics;
  final String imagePath;
  final double confidence;
  final DateTime createdAt;

  const PlantSummary({
    required this.id,
    required this.name,
    required this.characteristics,
    required this.imagePath,
    required this.confidence,
    required this.createdAt,
  });

  factory PlantSummary.fromJson(Map<String, dynamic> json) {
    return PlantSummary(
      id: json['id'] as String,
      name: json['name'] as String,
      characteristics: json['characteristics'] as String,
      imagePath: json['imagePath'] as String,
      confidence: (json['confidence'] as num).toDouble(),
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'characteristics': characteristics,
      'imagePath': imagePath,
      'confidence': confidence,
      'createdAt': createdAt.toIso8601String(),
    };
  }
}

/// 植物作成リクエスト
class PlantCreateRequest {
  final String name;
  final String? scientificName;
  final String? familyName;
  final String? description;
  final String characteristics;
  final double confidence;
  final String imagePath;

  const PlantCreateRequest({
    required this.name,
    this.scientificName,
    this.familyName,
    this.description,
    required this.characteristics,
    required this.confidence,
    required this.imagePath,
  });

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'scientificName': scientificName,
      'familyName': familyName,
      'description': description,
      'characteristics': characteristics,
      'confidence': confidence,
      'imagePath': imagePath,
    };
  }
}

/// 植物識別候補
class PlantCandidate {
  final String name;
  final String? scientificName;
  final String? familyName;
  final String? description;
  final String characteristics;
  final double confidence;

  const PlantCandidate({
    required this.name,
    this.scientificName,
    this.familyName,
    this.description,
    required this.characteristics,
    required this.confidence,
  });

  factory PlantCandidate.fromJson(Map<String, dynamic> json) {
    return PlantCandidate(
      name: json['name'] as String,
      scientificName: json['scientificName'] as String?,
      familyName: json['familyName'] as String?,
      description: json['description'] as String?,
      characteristics: json['characteristics'] as String,
      confidence: (json['confidence'] as num).toDouble(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'scientificName': scientificName,
      'familyName': familyName,
      'description': description,
      'characteristics': characteristics,
      'confidence': confidence,
    };
  }
}

/// 植物識別結果
class IdentificationResult {
  final bool isPlant;
  final double? confidence;
  final String? reason;
  final List<PlantCandidate> candidates;

  const IdentificationResult({
    required this.isPlant,
    this.confidence,
    this.reason,
    required this.candidates,
  });

  factory IdentificationResult.fromJson(Map<String, dynamic> json) {
    return IdentificationResult(
      isPlant: json['isPlant'] as bool,
      confidence: json['confidence'] != null 
          ? (json['confidence'] as num).toDouble() 
          : null,
      reason: json['reason'] as String?,
      candidates: (json['candidates'] as List<dynamic>)
          .map((e) => PlantCandidate.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'isPlant': isPlant,
      'confidence': confidence,
      'reason': reason,
      'candidates': candidates.map((e) => e.toJson()).toList(),
    };
  }
}

/// 重複チェック用の簡略化された植物データ
class DuplicatePlant {
  final String id;
  final String name;
  final String imagePath;
  final double confidence;
  final DateTime createdAt;

  const DuplicatePlant({
    required this.id,
    required this.name,
    required this.imagePath,
    required this.confidence,
    required this.createdAt,
  });

  factory DuplicatePlant.fromJson(Map<String, dynamic> json) {
    return DuplicatePlant(
      id: json['id'] as String,
      name: json['name'] as String,
      imagePath: json['imagePath'] as String,
      confidence: (json['confidence'] as num).toDouble(),
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'imagePath': imagePath,
      'confidence': confidence,
      'createdAt': createdAt.toIso8601String(),
    };
  }
}

/// 重複確認結果
class DuplicateCheckResult {
  final bool exists;
  final DuplicatePlant? plant;

  const DuplicateCheckResult({
    required this.exists,
    this.plant,
  });

  factory DuplicateCheckResult.fromJson(Map<String, dynamic> json) {
    if (kDebugMode) {
      print('DuplicateCheckResult.fromJson: json=$json');
      if (json['plant'] != null) {
        print('DuplicateCheckResult.fromJson: plant=${json['plant']}');
      }
    }
    return DuplicateCheckResult(
      exists: json['exists'] as bool,
      plant: json['plant'] != null 
          ? DuplicatePlant.fromJson(json['plant'] as Map<String, dynamic>)
          : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'exists': exists,
      'plant': plant?.toJson(),
    };
  }
}