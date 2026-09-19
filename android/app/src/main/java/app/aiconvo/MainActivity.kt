package app.aiconvo

import android.annotation.SuppressLint
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
import android.webkit.ValueCallback
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    companion object {
        private const val SPEECH_PERMISSION_REQUEST = 4107
        private const val FILE_CHOOSER_REQUEST = 4108
        private const val NOTIFY_PERMISSION_REQUEST = 4109
    }

    // Settings page toggle for reply notifications. On Android 13+ the
    // notification permission is asked first; the service starts once the
    // user answers yes, and the page is told the final state either way.
    inner class NotifyBridge {
        @JavascriptInterface
        fun isEnabled(): Boolean = NotifyService.isEnabled(this@MainActivity)

        @JavascriptInterface
        fun setEnabled(on: Boolean) {
            runOnUiThread {
                if (!on) { NotifyService.setEnabled(this@MainActivity, false); tellPageNotify(false); return@runOnUiThread }
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFY_PERMISSION_REQUEST)
                    return@runOnUiThread
                }
                NotifyService.setEnabled(this@MainActivity, true)
                tellPageNotify(true)
            }
        }
    }

    private fun tellPageNotify(on: Boolean) {
        web.evaluateJavascript("window.nativeNotifyChanged&&window.nativeNotifyChanged($on)", null)
    }

    // The pending <input type=file> callback. The WebView contract: answer
    // exactly once, with null on cancel, or the page never opens a picker again.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

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
    private lateinit var status: TextView

    /** Where the page is (being) loaded from; SpeechBridge reuses it. */
    @Volatile var serverBase: String = ""; private set
    @Volatile var serverToken: String = ""; private set

    // Connection state machine. Each openServer() bumps the generation so a
    // slow probe from an earlier attempt cannot flip the screen afterwards.
    private enum class Conn { IDLE, CONNECTING, LOADED, FAILED }
    private var conn = Conn.IDLE
    private var connectGeneration = 0
    private var pendingKey: String? = null
    private var pageOk = false
    private var lastAutoRetryMs = 0L
    private val main = Handler(Looper.getMainLooper())
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

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
        status = findViewById(R.id.status)
        val server = findViewById<EditText>(R.id.server)
        val token = findViewById<EditText>(R.id.token)
        val prefs = getSharedPreferences("aiconvo", Context.MODE_PRIVATE)
        server.setText(prefs.getString("server", "http://100.86.49.54:7433"))
        token.setText(prefs.getString("token", ""))
        findViewById<Button>(R.id.connect).setOnClickListener {
            val url = ServerReach.normalizeBase(server.text.toString())
            val pin = token.text.toString().trim()
            if (url.isEmpty()) {
                showError("Enter the server address.")
                return@setOnClickListener
            }
            prefs.edit().putString("server", url).putString("token", pin).apply()
            openServer(url, pin)
        }
        configureInk()
        speech = SpeechBridge(this, web)
        configureWebView()
        val saved = prefs.getString("server", "") ?: ""
        if (saved.isNotEmpty() && prefs.contains("token")) openServer(saved, prefs.getString("token", "") ?: "", intent?.getStringExtra(NotifyService.EXTRA_KEY))
        else showSetup()
        NotifyService.startIfEnabled(this)
    }

    // A tapped notification lands here (singleTask): jump the loaded page to
    // that conversation instead of reloading everything.
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val key = intent?.getStringExtra(NotifyService.EXTRA_KEY) ?: return
        if (web.visibility != View.VISIBLE) return
        val encoded = Uri.encode(key)
        web.evaluateJavascript("location.hash='#$encoded'", null)
    }

    override fun onResume() {
        super.onResume()
        NotifyService.appOnScreen = true
        // Coming back to a failed screen: the user may have fixed Wi-Fi or
        // Tailscale in the meantime, so try again without being asked.
        if (conn == Conn.FAILED) autoRetry()
    }

    override fun onPause() {
        NotifyService.appOnScreen = false
        super.onPause()
    }

    // A network change (Wi-Fi joined, mobile data, Tailscale up) is the
    // moment a failed connection becomes possible again. Only failures are
    // retried: a loaded page keeps its own event stream alive.
    override fun onStart() {
        super.onStart()
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post { if (conn == Conn.FAILED) autoRetry() }
            }
        }
        try { cm.registerDefaultNetworkCallback(cb); networkCallback = cb } catch (_: Exception) {}
    }

    override fun onStop() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        networkCallback?.let { try { cm?.unregisterNetworkCallback(it) } catch (_: Exception) {} }
        networkCallback = null
        super.onStop()
    }

    /** Retries the last connection at most once every few seconds. */
    private fun autoRetry(): Boolean {
        val now = SystemClock.uptimeMillis()
        if (now - lastAutoRetryMs < 3000 || serverBase.isEmpty()) return false
        lastAutoRetryMs = now
        openServer(serverBase, serverToken, pendingKey)
        return true
    }

    private fun showSetup() {
        status.visibility = View.GONE
        setup.visibility = View.VISIBLE
        web.visibility = View.GONE
    }

    private fun showError(message: String) {
        error.visibility = View.VISIBLE
        error.text = message
    }

    private fun showStatus(message: String) {
        status.text = message
        status.visibility = View.VISIBLE
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
        web.addJavascriptInterface(NotifyBridge(), "AiconvoNotify")
        web.addJavascriptInterface(AppBridge(), "AiconvoApp")
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                val intent = try {
                    params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                } catch (_: Exception) {
                    Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                }
                if (params?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
                return try {
                    startActivityForResult(Intent.createChooser(intent, "Choose"), FILE_CHOOSER_REQUEST)
                    true
                } catch (_: Exception) {
                    fileChooserCallback = null
                    callback?.onReceiveValue(null)
                    false
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                view?.evaluateJavascript(deviceScript(), null)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                view?.evaluateJavascript(deviceScript(), null)
            }

            // Self-signed certificates are the norm for a personal server on
            // the home LAN or the tailnet; anywhere else they stay an error.
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                val host = ServerReach.host(error?.url ?: "")
                if (ServerReach.isPrivateHost(host)) handler?.proceed() else handler?.cancel()
            }

            override fun onPageCommitVisible(view: WebView?, url: String?) {
                pageOk = true
                if (conn == Conn.CONNECTING) { conn = Conn.LOADED; status.visibility = View.GONE }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame != true) return
                // The page itself failed (server went away, network switched
                // mid-load). Go through the same connect path: it starts
                // Tailscale when that is what is missing, and otherwise
                // explains the failure instead of leaving a white page.
                conn = Conn.FAILED
                pageOk = false
                if (!autoRetry()) fail(reachFailureText(ServerReach.host(serverBase), error?.description?.toString()))
            }

            // The page routes links to other sites through AiconvoApp
            // .openExternal (it knows a link from the machine switcher; this
            // side does not). Here only non-web schemes (mailto:, tel:,
            // intent:) are handed out: the WebView cannot show them and
            // would replace aiconvo with an error page.
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                val scheme = url.scheme?.lowercase() ?: return false
                if (scheme == "http" || scheme == "https" || scheme == "file" || scheme == "about" || scheme == "javascript") return false
                return openOutside(url)
            }
        }
    }

    fun requestSpeechPermission() {
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), SPEECH_PERMISSION_REQUEST)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_CHOOSER_REQUEST) return
        val cb = fileChooserCallback ?: return
        fileChooserCallback = null
        val uris = mutableListOf<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
            if (uris.isEmpty()) data.data?.let { uris.add(it) }
        }
        cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
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
        } else if (requestCode == NOTIFY_PERMISSION_REQUEST) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            NotifyService.setEnabled(this, granted)
            tellPageNotify(granted)
        }
    }

    // Hand a URL to whatever app handles it (browser, mail, maps). Returns
    // true when something took it; false lets the WebView load it as the
    // last resort on a device with no handler at all.
    private fun openOutside(url: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: Exception) {
            false
        }
    }

    // Page-side bridge: a link to another site leaves for the device
    // browser instead of replacing aiconvo inside this WebView (which has no
    // way back on a device without a navigation bar). When no app can take
    // the URL, the WebView loads it after all: a page is better than nothing.
    inner class AppBridge {
        @JavascriptInterface
        fun openExternal(url: String) {
            runOnUiThread {
                val parsed = try { Uri.parse(url) } catch (_: Exception) { null } ?: return@runOnUiThread
                if (!openOutside(parsed)) web.loadUrl(url)
            }
        }
    }

    /**
     * Connects in three steps, each explained on screen: make sure a route
     * exists (start Tailscale if the address needs it), check that the server
     * answers with this token, then load the page. Each failure lands on the
     * setup screen with the actual reason; the network callback and onResume
     * retry it on their own once conditions change.
     */
    private fun openServer(rawBase: String, pin: String, conversationKey: String? = null) {
        val base = ServerReach.normalizeBase(rawBase)
        if (base.isEmpty()) { showSetup(); return }
        serverBase = base
        serverToken = pin
        pendingKey = conversationKey
        val generation = ++connectGeneration
        conn = Conn.CONNECTING
        error.visibility = View.GONE
        setup.visibility = View.GONE
        val host = ServerReach.host(base)
        // An already loaded page stays on screen while a retry runs behind it.
        if (web.visibility != View.VISIBLE) {
            web.visibility = View.VISIBLE
            showStatus(if (ServerReach.needsTailscale(this, base)) "Starting Tailscale…" else "Connecting to $host…")
        }
        ServerReach.ensure(this, base) { routeOk, note ->
            if (generation != connectGeneration) return@ensure
            if (!routeOk) { fail(note ?: "No route to $host."); return@ensure }
            if (status.visibility == View.VISIBLE) showStatus("Connecting to $host…")
            ServerReach.probe(base, pin) { probe ->
                if (generation != connectGeneration) return@probe
                when (probe.status) {
                    200 -> {
                        val hash = if (conversationKey != null) "#" + Uri.encode(conversationKey) else ""
                        val target = if (pin.isEmpty()) "$base/$hash" else "$base/?token=$pin$hash"
                        web.loadUrl(target)
                    }
                    401, 403 -> fail("$host answered, but the token is wrong. It is in ~/.cache/aiconvo/lan-token on the server.")
                    null -> fail(reachFailureText(host, probe.error))
                    else -> fail("$host answered with HTTP ${probe.status}.")
                }
            }
        }
    }

    private fun reachFailureText(host: String, detail: String?): String {
        val where = when {
            ServerReach.isTailnetHost(host) && !ServerReach.hasVpn(this) -> "Tailscale is off, so $host cannot be reached."
            ServerReach.isTailnetHost(host) -> "Tailscale is on but $host does not answer. Is aiconvo running there?"
            else -> "$host does not answer on this network. Is aiconvo running, and is this device on the same network?"
        }
        return if (detail.isNullOrBlank()) where else "$where ($detail)"
    }

    private fun fail(message: String) {
        conn = Conn.FAILED
        // A page that is still showing stays; a broken or never-loaded one
        // gives way to the setup screen with the reason.
        if (pageOk) status.visibility = View.GONE
        else { showSetup(); showError(message) }
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
            else -> { connectGeneration++; conn = Conn.IDLE; showSetup() }
        }
    }
}
