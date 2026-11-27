package org.hancel.file

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File

/**
 * Android share-panel intake (ACTION_SEND) — SKELETON, not yet wired to the web app.
 *
 * Current behaviour: copies the shared file from its `content://` URI into the app
 * cache (`cacheDir/share-inbox/`) and records it in `filesDir/pending-share.json`.
 * The web layer does not read that marker yet; see `docs/mobile.md` §6 for the
 * remaining work (emit a Tauri event from Kotlin, or let Rust poll the marker at
 * startup, then hand the file to the normal "add file" flow).
 */
object ShareIntake {
    private const val INBOX = "share-inbox"
    private const val MARKER = "pending-share.json"

    fun handleIntent(context: Context, intent: Intent?) {
        if (intent == null || intent.action != Intent.ACTION_SEND) return
        val uri = streamUri(intent) ?: return
        val appContext = context.applicationContext
        // Copy off the main thread: the payload can be hundreds of megabytes.
        Thread {
            try {
                val dir = File(appContext.cacheDir, INBOX).apply { mkdirs() }
                val name = displayName(appContext, uri) ?: "shared-${System.currentTimeMillis()}.bin"
                val target = File(dir, name)
                appContext.contentResolver.openInputStream(uri)?.use { input ->
                    target.outputStream().use { output -> input.copyTo(output) }
                } ?: return@Thread
                val marker = JSONObject()
                    .put("name", name)
                    .put("path", target.absolutePath)
                    .put("size", target.length())
                    .put("receivedAt", System.currentTimeMillis())
                File(appContext.filesDir, MARKER).writeText(marker.toString())
            } catch (_: Throwable) {
                // Share intake is best effort here; the full implementation reports
                // failures back through a Tauri event (docs/mobile.md §6).
            }
        }.start()
    }

    private fun streamUri(intent: Intent): Uri? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        }
    }

    private fun displayName(context: Context, uri: Uri): String? {
        val cursor = context.contentResolver.query(uri, null, null, null, null) ?: return null
        cursor.use {
            if (!it.moveToFirst()) return null
            val index = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index < 0) return null
            return it.getString(index)?.replace('/', '_')?.replace('\\', '_')
        }
    }
}
