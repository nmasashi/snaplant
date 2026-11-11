package com.snaplant.mobile

import android.os.Bundle
import android.util.Log
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
        // 同じプロセスで画面が作り直されたとき（最初の画面の前の設定の変更など）は、前回が落ちたのではなく、エンジンも動いているので見ない。
        // savedInstanceState だけでは見分けられない（OS が裏で終了させたアプリを開き直すと、新しいプロセスでも渡される）。
        // プロセスの印だけでも見分けられない（戻るで閉じてプロセスが残ったまま開き直したのは、新しい起動）
        if (savedInstanceState == null || !checkedInProcess) {
            checkedInProcess = true
            // 印の読み書きに失敗しても（空きが無いなど）起動は止めない。回復の仕組みが起動を止めては元も子もない
            runCatching {
                val marker = launchMarker()
                if (marker.exists()) {
                    // エンジンが動き出す（super.onCreate）前に、エンジンと同じ関数で引いた場所（今は code_cache）から消す。
                    // 消すのは再現で原因と確かめたファイルだけにする。code_cache は Dart の一時フォルダでもあるので丸ごとは消さない
                    val cache = File(PathUtils.getCacheDirectory(applicationContext), PIPELINE_CACHE_FILE)
                    if (cache.exists() && !cache.delete()) Log.w(TAG, "描画のキャッシュを消せませんでした: $cache")
                }
                marker.createNewFile()
            }.onFailure { Log.w(TAG, "起動の印を扱えませんでした", it) }
        }
        super.onCreate(savedInstanceState)
    }

    override fun onFlutterUiDisplayed() {
        super.onFlutterUiDisplayed()
        runCatching { launchMarker().delete() }
            .onFailure { Log.w(TAG, "起動の印を消せませんでした", it) }
    }

    /** 起動の印。「キャッシュを消去」で消えない場所に置く（印ごと消えると、次の起動で捨てられない） */
    private fun launchMarker() = File(noBackupFilesDir, LAUNCH_MARKER_FILE)

    private companion object {
        const val TAG = "SnapPlant"

        /** Impeller の Vulkan の描画の下準備のキャッシュ（Flutter 3.32 のエンジンの名前） */
        const val PIPELINE_CACHE_FILE = "flutter.impeller.vkcache"
        const val LAUNCH_MARKER_FILE = "launch_in_progress"

        /** このプロセスで起動の印をもう見たか（プロセスが終われば false に戻る） */
        var checkedInProcess = false
    }
}
