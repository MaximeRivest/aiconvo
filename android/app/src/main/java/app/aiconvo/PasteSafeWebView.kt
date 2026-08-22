package app.aiconvo

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.AttributeSet
import android.util.Base64
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputContentInfo
import android.webkit.WebView
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

class PasteSafeWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : WebView(context, attrs) {

    override fun startActionMode(callback: ActionMode.Callback): ActionMode? {
        return super.startActionMode(wrapActionMode(callback))
    }

    override fun startActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
        return super.startActionMode(wrapActionMode(callback), type)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val pasteKey = event.action == KeyEvent.ACTION_DOWN && (
            event.keyCode == KeyEvent.KEYCODE_PASTE ||
                (event.isCtrlPressed && event.keyCode == KeyEvent.KEYCODE_V)
            )
        if (pasteKey && tryPasteImageFromClipboard()) return true
        return super.dispatchKeyEvent(event)
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val base = super.onCreateInputConnection(outAttrs) ?: return null
        return object : InputConnectionWrapper(base, true) {
            override fun commitContent(inputContentInfo: InputContentInfo, flags: Int, opts: Bundle?): Boolean {
                return try {
                    inputContentInfo.requestPermission()
                    injectImageUri(inputContentInfo.contentUri)
                    true
                } catch (_: Exception) {
                    true
                }
            }
        }
    }

    private fun wrapActionMode(callback: ActionMode.Callback): ActionMode.Callback {
        return object : ActionMode.Callback {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                return callback.onCreateActionMode(mode, menu)
            }
            override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
                return callback.onPrepareActionMode(mode, menu)
            }
            override fun onDestroyActionMode(mode: ActionMode) {
                callback.onDestroyActionMode(mode)
            }
            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                val title = item.title?.toString()?.lowercase() ?: ""
                val paste = item.itemId == android.R.id.paste ||
                    item.itemId == android.R.id.pasteAsPlainText ||
                    title.contains("paste")
                if (paste && tryPasteImageFromClipboard()) {
                    mode.finish()
                    return true
                }
                return callback.onActionItemClicked(mode, item)
            }
        }
    }

    fun tryPasteImageFromClipboard(): Boolean {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
        val clip = cm.primaryClip ?: return false
        for (i in 0 until clip.itemCount) {
            val item = clip.getItemAt(i)
            val uri = item.uri
            if (uri != null && looksLikeImage(uri, clip.description?.getMimeType(i))) {
                injectImageUri(uri)
                return true
            }
        }
        return false
    }

    private fun looksLikeImage(uri: Uri, mime: String?): Boolean {
        val m = (mime ?: context.contentResolver.getType(uri) ?: uri.toString()).lowercase()
        return m.startsWith("image/") || m.contains("png") || m.contains("jpeg") ||
            m.contains("jpg") || m.contains("webp")
    }

    private fun injectImageUri(uri: Uri) {
        thread(name = "aiconvo-paste") {
            val jpeg = decodeSampledJpeg(uri) ?: return@thread
            val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
            post {
                evaluateJavascript(
                    "window.aiconvoAcceptImage&&window.aiconvoAcceptImage('image/jpeg','$b64')",
                    null
                )
            }
        }
    }

    private fun decodeSampledJpeg(uri: Uri): ByteArray? {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        val max = 960
        while (bounds.outWidth / sample > max || bounds.outHeight / sample > max) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bmp = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        return try {
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 72, out)
            out.toByteArray()
        } finally {
            bmp.recycle()
        }
    }
}
