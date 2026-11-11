package com.snaplant.mobile

import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.util.PathUtils
import java.io.File

/**
 * 起動の途中で落ちたら、次の起動で描画の下準備のキャッシュを捨ててから起動する。
 *
 * Impeller（Vulkan）は描画の下準備をキャッシュのファイルに残し、次の起動でドライバに読ませる。
 * ファイルが壊れていると、ドライバによっては読む途中で落ちる（SC-03K の Adreno のドライバで、
 * 2026-11 に起動のたびに落ち続けた）。落ちるのは Dart が動く前で、アプリからは受け止められないので、
 * 起動の印を最初の画面が出るまで残し、印が残ったまま起動したら前回は画面が出る前に落ちたとみなす。
 * 1回は落ちるが、立ち上がらないままにはならない
 */
class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // エンジンが読む前に消す（super.onCreate でエンジンが動き出す）
        val marker = launchMarker()
        if (marker.exists()) {
            // エンジンがキャッシュを置く場所を、エンジンと同じ関数で引く（今は code_cache）
            File(PathUtils.getCacheDirectory(this), PIPELINE_CACHE_FILE).delete()
        }
        marker.createNewFile()
        super.onCreate(savedInstanceState)
    }

    override fun onFlutterUiDisplayed() {
        super.onFlutterUiDisplayed()
        launchMarker().delete()
    }

    /** 起動の印。「キャッシュを消去」で消えない場所に置く（印ごと消えると、次の起動で捨てられない） */
    private fun launchMarker() = File(noBackupFilesDir, LAUNCH_MARKER_FILE)

    private companion object {
        /** Impeller の Vulkan の描画の下準備のキャッシュ（Flutter 3.32 のエンジンの名前） */
        const val PIPELINE_CACHE_FILE = "flutter.impeller.vkcache"
        const val LAUNCH_MARKER_FILE = "launch_in_progress"
    }
}
