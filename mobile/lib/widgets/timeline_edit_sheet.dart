import 'package:flutter/material.dart';
import '../models/timeline.dart';
import '../services/api_service.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// 編集シートの欄（docs/03_screen_design.md §8.5）
class TimelineEditField {
  const TimelineEditField(
      {required this.key,
      required this.label,
      required this.maxLength,
      required this.initial});

  /// 送るときの項目名（`title`・`summary`・`label`・`note`）
  final String key;
  final String label;
  final int maxLength;

  /// 今の文（無ければ null）
  final String? initial;
}

/// 日・場面の文を直す、下から出るシート（§8.5）
///
/// 閉じるときの結果: 保存できたら応答（[TimelineOverview]）、タイムラインが変わった・旅行が無いなら [ApiException]
/// （呼ぶ側が知らせて読み直す）、キャンセル・何も変えずに保存したら null
class TimelineEditSheet extends StatefulWidget {
  const TimelineEditSheet(
      {super.key,
      required this.title,
      required this.fields,
      required this.hint,
      required this.onSave});

  final String title;
  final List<TimelineEditField> fields;

  /// 欄の下の添え書き（空にしたときに戻る文。日と場面で違う。§8.5）
  final String hint;

  /// 変えた欄だけ（空にした欄は null）を送る
  final Future<TimelineOverview> Function(Map<String, String?> changes) onSave;

  @override
  State<TimelineEditSheet> createState() => _TimelineEditSheetState();
}

class _TimelineEditSheetState extends State<TimelineEditSheet> {
  late final List<TextEditingController> _controllers = [
    for (final field in widget.fields)
      TextEditingController(text: field.initial ?? ''),
  ];
  // 保存している間は閉じられず、ボタンも押せない（§8.5）
  bool _saving = false;
  // 保存に失敗したときの文言（シートの中に出す）
  String? _errorMessage;

  @override
  void dispose() {
    for (final controller in _controllers) {
      controller.dispose();
    }
    super.dispose();
  }

  /// 変えた欄（前後の空白を除いて比べる。空にした欄は null）
  Map<String, String?> _changes() {
    final changes = <String, String?>{};
    for (final (index, field) in widget.fields.indexed) {
      final text = _controllers[index].text.trim();
      if (text != (field.initial ?? '').trim()) {
        changes[field.key] = text.isEmpty ? null : text;
      }
    }
    return changes;
  }

  Future<void> _save() async {
    // 押せなくする描き直しが届く前に続けて押されても、送るのは1回（2回目の応答で、閉じかけのシートの下の画面まで閉じないように）
    if (_saving) return;
    final changes = _changes();
    if (changes.isEmpty) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _saving = true;
      _errorMessage = null;
    });
    try {
      final overview = await widget.onSave(changes);
      if (!mounted) return;
      Navigator.pop(context, overview);
    } catch (e) {
      debugPrint('TimelineEditSheet: 保存のエラー: $e');
      if (!mounted) return;
      if (e is ApiException && (e.isTimelineChanged || e.isTripNotFound)) {
        // 呼ぶ側が知らせて読み直す
        Navigator.pop(context, e);
        return;
      }
      setState(() {
        _saving = false;
        _errorMessage = e is ApiException ? e.userMessage : '保存に失敗しました';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final errorMessage = _errorMessage;
    return PopScope(
      canPop: !_saving,
      child: Padding(
        // キーボードの分だけ上げる
        padding:
            EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.title, style: AppTextStyles.headline3),
              const SizedBox(height: 12),
              for (final (index, field) in widget.fields.indexed) ...[
                TextField(
                  controller: _controllers[index],
                  enabled: !_saving,
                  maxLength: field.maxLength,
                  maxLines: null,
                  decoration: InputDecoration(labelText: field.label),
                ),
                const SizedBox(height: 8),
              ],
              Text(widget.hint,
                  style: AppTextStyles.caption
                      .copyWith(color: AppColors.textSecondary)),
              if (errorMessage != null) ...[
                const SizedBox(height: 8),
                Text(errorMessage, style: AppTextStyles.error),
              ],
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _saving ? null : () => Navigator.pop(context),
                    child: const Text('キャンセル'),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton(
                    onPressed: _saving ? null : _save,
                    child: const Text('保存'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
