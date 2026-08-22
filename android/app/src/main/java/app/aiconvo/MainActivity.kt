package app.aiconvo

import android.annotation.SuppressLint
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.net.URL

class MainActivity : AppCompatActivity() {
    companion object {
        private const val SPEECH_PERMISSION_REQUEST = 4107
    }

    inner class InkBridge {
        @JavascriptInterface
        fun setEnabled(on: Boolean) {
            runOnUiThread {
                ink.visibility = if (on) View.VISIBLE else View.GONE
                if (!on) ink.clearAll()
            }
        }
        @JavascriptInterface
        fun setErase(on: Boolean) {
            runOnUiThread { ink.erase = on }
        }
        @JavascriptInterface
        fun clearLive() {
            runOnUiThread { ink.clearLive() }
        }
        @JavascriptInterface
        fun clearAll() {
            runOnUiThread { ink.clearAll() }
        }
    }
    private lateinit var web: WebView
    private lateinit var speech: SpeechBridge
    private lateinit var ink: InkOverlay
    private lateinit var setup: View
    private lateinit var error: TextView

    private val isEinkDevice: Boolean
        get() = Build.MANUFACTURER.contains("iflytek", ignoreCase = true)
                || Build.MODEL.startsWith("XF-T5", ignoreCase = true)

    private val isPhone: Boolean
        get() = !isEinkDevice && resources.configuration.smallestScreenWidthDp < 600

    private fun deviceScript(): String = when {
        isEinkDevice -> "try{localStorage.setItem('aiconvo.theme','eink');document.documentElement.dataset.theme='eink';document.documentElement.dataset.form='eink'}catch(e){}"
        isPhone -> "try{let t=localStorage.getItem('aiconvo.theme');if(!t||t==='eink'){t='light';localStorage.setItem('aiconvo.theme',t)}document.documentElement.dataset.theme=t;document.documentElement.dataset.form='phone'}catch(e){}"
        else -> "try{document.documentElement.dataset.form='tablet'}catch(e){}"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        ink = findViewById(R.id.ink)
        setup = findViewById(R.id.setup)
        error = findViewById(R.id.error)
        val server = findViewById<EditText>(R.id.server)
        val token = findViewById<EditText>(R.id.token)
        val prefs = getSharedPreferences("aiconvo", Context.MODE_PRIVATE)
        server.setText(prefs.getString("server", "http://192.168.2.253:7433"))
        token.setText(prefs.getString("token", "4148"))
        findViewById<Button>(R.id.connect).setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            val pin = token.text.toString().trim()
            if (url.isEmpty()) {
                showError("Enter the laptop address.")
                return@setOnClickListener
            }
            prefs.edit().putString("server", url).putString("token", pin).apply()
            openServer(url, pin)
        }
        configureInk()
        speech = SpeechBridge(this, web)
        configureWebView()
        val saved = prefs.getString("server", "") ?: ""
        if (saved.isNotEmpty() && prefs.contains("token")) openServer(saved, prefs.getString("token", "") ?: "")
        else showSetup()
    }

    private fun showSetup() {
        setup.visibility = View.VISIBLE
        web.visibility = View.GONE
    }

    private fun showError(message: String) {
        error.visibility = View.VISIBLE
        error.text = message
    }

    private fun configureInk() {
        ink.listener = InkOverlay.Listener { packed, erase ->
            val safe = packed.replace("'", "")
            web.evaluateJavascript("window.fileInkAcceptPacked&&window.fileInkAcceptPacked('$safe',$erase)", null)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Phones must honor the viewport meta tag. Desktop overview mode
            // shrinks the complete Gantt into an unreadable 980 px canvas.
            loadWithOverviewMode = !isPhone
            useWideViewPort = !isPhone
            textZoom = 100
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        web.addJavascriptInterface(InkBridge(), "AiconvoInk")
        web.addJavascriptInterface(speech, "AiconvoSpeech")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                view?.evaluateJavascript(deviceScript(), null)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                view?.evaluateJavascript(deviceScript(), null)
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                val host = try { URL(error?.url ?: "").host } catch (_: Exception) { "" }
                if (host.startsWith("192.168.") || host.startsWith("10.") || host == "127.0.0.1") handler?.proceed()
                else handler?.cancel()
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) {
                    showSetup()
                    showError("Could not reach the laptop. Check Wi-Fi and that aiconvo is running.")
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                return false
            }
        }
    }

    fun requestSpeechPermission() {
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), SPEECH_PERMISSION_REQUEST)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == SPEECH_PERMISSION_REQUEST) {
            speech.onPermissionResult(
                grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED)
        }
    }

    private fun openServer(base: String, pin: String) {
        error.visibility = View.GONE
        setup.visibility = View.GONE
        web.visibility = View.VISIBLE
        val target = if (pin.isEmpty()) "$base/" else "$base/?token=$pin"
        web.loadUrl(target)
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        if (ink.visibility == View.VISIBLE && InkOverlay.isStylusTool(ev.getToolType(ev.actionIndex))) {
            ink.markStylus()
        }
        return super.dispatchGenericMotionEvent(ev)
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ink.visibility != View.VISIBLE) return super.dispatchTouchEvent(ev)
        var stylus = false
        for (i in 0 until ev.pointerCount) {
            if (InkOverlay.isStylusTool(ev.getToolType(i))) {
                stylus = true
                break
            }
        }
        if (stylus) {
            ink.requestUnbufferedDispatch(ev)
            ink.feed(ev)
            return true
        }
        if (ink.isDrawing()) {
            ink.feed(ev)
            return true
        }
        val finger = ev.getToolType(ev.actionIndex) == MotionEvent.TOOL_TYPE_FINGER
                || ev.getToolType(ev.actionIndex) == MotionEvent.TOOL_TYPE_UNKNOWN
        if (finger && SystemClock.uptimeMillis() - ink.lastStylusMs < 800) {
            return true
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onDestroy() {
        if (::speech.isInitialized) speech.destroy()
        super.onDestroy()
    }

    override fun onBackPressed() {
        when {
            setup.visibility == View.VISIBLE -> super.onBackPressed()
            web.canGoBack() -> web.goBack()
            else -> showSetup()
        }
    }
}
