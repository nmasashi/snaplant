package com.snaplant.mobile

import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import java.io.File

/**
 * 起動の途中で落ちたら、次の起動で描画の下準備のキャッシュ（code_cache）を捨ててから起動する。
 *
 * Impeller（Vulkan）は描画の下準備を code_cache/flutter.impeller.vkcache に残し、次の起動でドライバに読ませる。
 * ファイルが壊れていると、ドライバによっては読む途中で落ちる（SC-03K の Adreno のドライバで、
 * 2026-11 に起動のたびに落ち続けた）。落ちるのは Dart が動く前で、アプリからは受け止められないので、
 * 起動の印を最初の画面が出るまで残し、印が残ったまま起動したら前回は画面が出る前に落ちたとみなす。
 * 1回は落ちるが、立ち上がらないままにはならない
 */
class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // 印の読み書きに失敗しても（空きが無いなど）起動は止めない。回復の仕組みが起動を止めては元も子もない
        runCatching {
            val marker = launchMarker()
            if (marker.exists()) {
                // エンジンが動き出す（super.onCreate）前に消す。直ったのは「キャッシュを消去」だったので、
                // vkcache だけでなく code_cache の中身を全部捨てる（実行時に作り直すものだけが置かれる場所で、
                // アプリの更新でも OS が消す）。写真のキャッシュがある cache には触らない
                codeCacheDir.listFiles()?.forEach { it.deleteRecursively() }
            }
            marker.createNewFile()
        }
        super.onCreate(savedInstanceState)
    }

    override fun onFlutterUiDisplayed() {
        super.onFlutterUiDisplayed()
        runCatching { launchMarker().delete() }
    }

    /** 起動の印。「キャッシュを消去」で消えない場所に置く（印ごと消えると、次の起動で捨てられない） */
    private fun launchMarker() = File(noBackupFilesDir, LAUNCH_MARKER_FILE)

    private companion object {
        const val LAUNCH_MARKER_FILE = "launch_in_progress"
    }
}
