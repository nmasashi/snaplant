import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text_styles.dart';

/// アイコン・見出し・説明・ボタンを縦に並べた表示（設定を促す・設定や一覧を読めなかった）
class MessageView extends StatelessWidget {
  const MessageView({
    super.key,
    required this.isLargeScreen,
    required this.icon,
    required this.title,
    required this.message,
    required this.buttonIcon,
    required this.buttonLabel,
    required this.onPressed,
    this.isError = false,
  });

  final bool isLargeScreen;
  final IconData icon;
  final String title;
  final String message;
  final IconData buttonIcon;
  final String buttonLabel;
  final VoidCallback onPressed;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: EdgeInsets.all(isLargeScreen ? 32 : 24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon,
                size: isLargeScreen ? 80 : 64,
                color: isError ? AppColors.error : AppColors.textSecondary),
            SizedBox(height: isLargeScreen ? 24 : 16),
            Text(
              title,
              style: AppTextStyles.headline2.copyWith(
                fontSize: isLargeScreen ? 28 : 24,
                color: isError ? AppColors.error : null,
              ),
              textAlign: TextAlign.center,
            ),
            SizedBox(height: isLargeScreen ? 16 : 12),
            Text(message,
                style: AppTextStyles.body1
                    .copyWith(fontSize: isLargeScreen ? 20 : 18),
                textAlign: TextAlign.center),
            SizedBox(height: isLargeScreen ? 32 : 24),
            ElevatedButton.icon(
              onPressed: onPressed,
              icon: Icon(buttonIcon),
              label: Text(buttonLabel),
              style: ElevatedButton.styleFrom(
                padding: EdgeInsets.symmetric(
                    horizontal: isLargeScreen ? 32 : 24,
                    vertical: isLargeScreen ? 20 : 16),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
