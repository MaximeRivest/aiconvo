package app.rockfrog.chattering

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * One place that knows how to reach the chattering server from this device.
 *
 * The server is addressed by its Tailscale address, which works the same at
 * home (Tailscale takes the direct LAN path) and away. The only thing that can
 * break that route is Tailscale being off, so before a user-initiated
 * connection this asks Tailscale to connect and waits briefly for the VPN
 * network to appear. Background work (notifications) never starts the VPN:
 * a user who switched Tailscale off on purpose must stay in control.
 */
object ServerReach {
    private const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
    private const val TAILSCALE_RECEIVER = "com.tailscale.ipn.IPNReceiver"
    private const val TAILSCALE_CONNECT = "com.tailscale.ipn.CONNECT_VPN"
    private const val MIN_START_INTERVAL_MS = 15_000L

    /** Probe outcome for [probe]: HTTP status, or null when nothing answered. */
    class Probe(val status: Int?, val error: String?)

    @Volatile private var lastStartMs = 0L

    /** "host:port" or "http://host:port/" become "http://host:port". */
    fun normalizeBase(raw: String): String {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) return s
        if (!s.contains("://")) s = "http://$s"
        return s
    }

    fun host(base: String): String = try { URL(base).host ?: "" } catch (_: Exception) { "" }

    /** Tailscale addresses come from 100.64.0.0/10. */
    fun isTailnetHost(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4 || parts[0] != "100") return false
        val second = parts[1].toIntOrNull() ?: return false
        return second in 64..127 && parts.drop(2).all { it.toIntOrNull() in 0..255 }
    }

    /** Home LAN, loopback or tailnet: the places a self-signed Chattering lives. */
    fun isPrivateHost(host: String): Boolean {
        if (host == "127.0.0.1" || host == "localhost") return true
        if (host.startsWith("192.168.") || host.startsWith("10.")) return true
        val parts = host.split('.')
        if (parts.size == 4 && parts[0] == "172") {
            val second = parts[1].toIntOrNull() ?: return false
            if (second in 16..31) return true
        }
        return isTailnetHost(host)
    }

    fun hasVpn(ctx: Context): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        return cm.allNetworks.any { n ->
            cm.getNetworkCapabilities(n)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        }
    }

    fun tailscaleInstalled(ctx: Context): Boolean = try {
        ctx.packageManager.getPackageInfo(TAILSCALE_PACKAGE, 0); true
    } catch (_: PackageManager.NameNotFoundException) { false }

    /** Asks the Tailscale app to connect. Rate-limited so retries do not spam it. */
    fun startTailscale(ctx: Context): Boolean {
        if (!tailscaleInstalled(ctx)) return false
        val now = SystemClock.elapsedRealtime()
        if (now - lastStartMs < MIN_START_INTERVAL_MS) return true
        lastStartMs = now
        return try {
            ctx.sendBroadcast(Intent(TAILSCALE_CONNECT).setClassName(TAILSCALE_PACKAGE, TAILSCALE_RECEIVER))
            true
        } catch (_: Exception) { false }
    }

    /** True when the server is on the tailnet but no VPN network exists yet. */
    fun needsTailscale(ctx: Context, base: String): Boolean =
        isTailnetHost(host(base)) && !hasVpn(ctx)

    /**
     * Makes sure a route to [base] exists, starting Tailscale when the server
     * is a tailnet address and no VPN is up. [onDone] runs on the main thread
     * with (routeReady, note); note explains a failure in plain words.
     */
    fun ensure(ctx: Context, base: String, timeoutMs: Long = 10_000L, onDone: (Boolean, String?) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        if (!needsTailscale(ctx, base)) { main.post { onDone(true, null) }; return }
        if (!tailscaleInstalled(ctx)) {
            main.post { onDone(false, "The server is a Tailscale address but Tailscale is not installed on this device.") }
            return
        }
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (cm == null) { main.post { onDone(false, "No network service.") }; return }
        startTailscale(ctx)
        var finished = false
        lateinit var callback: ConnectivityManager.NetworkCallback
        val finish = { ok: Boolean, note: String? ->
            if (!finished) {
                finished = true
                try { cm.unregisterNetworkCallback(callback) } catch (_: Exception) {}
                onDone(ok, note)
            }
        }
        callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { main.post { finish(true, null) } }
        }
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_VPN)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build()
        try { cm.registerNetworkCallback(request, callback) } catch (_: Exception) {}
        main.postDelayed({
            finish(hasVpn(ctx), if (hasVpn(ctx)) null else "Tailscale did not connect. Open the Tailscale app and turn it on.")
        }, timeoutMs)
    }

    /** Blocking form of [ensure] for worker threads. Never call on the main thread. */
    fun ensureBlocking(ctx: Context, base: String, timeoutMs: Long = 10_000L): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return !needsTailscale(ctx, base)
        val latch = CountDownLatch(1)
        var result = false
        ensure(ctx, base, timeoutMs) { ok, _ -> result = ok; latch.countDown() }
        latch.await(timeoutMs + 1000, TimeUnit.MILLISECONDS)
        return result
    }

    /**
     * An HTTP client for [base]. A self-signed certificate is accepted only
     * for private and tailnet addresses, mirroring what the WebView does:
     * on those networks the peer is already authenticated by the network
     * itself, and a certificate error would just mean "your own server".
     */
    fun httpClient(base: String): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
        if (base.startsWith("https://") && isPrivateHost(host(base))) {
            val trust = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }
            val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
            builder.sslSocketFactory(ssl.socketFactory, trust).hostnameVerifier { _, _ -> true }
        }
        return builder.build()
    }

    /** ws(s):// form of [base] for the speech relay. */
    fun webSocketBase(base: String): String = when {
        base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
        base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
        else -> "ws://$base"
    }

    /**
     * Fast check that the server answers and accepts the token. Uses a tiny
     * authenticated endpoint so 200 means "in", 401 means "wrong token" and
     * null means "nothing there". Runs on a worker thread; [onDone] on main.
     */
    fun probe(base: String, token: String, onDone: (Probe) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        Thread {
            val result = try {
                val client = httpClient(base).newBuilder().readTimeout(6, TimeUnit.SECONDS).build()
                val req = Request.Builder().url("$base/api/voice/state")
                    .apply { if (token.isNotEmpty()) header("Authorization", "Bearer $token") }
                    .build()
                client.newCall(req).execute().use { Probe(it.code(), null) }
            } catch (e: Exception) {
                Probe(null, e.message ?: e.javaClass.simpleName)
            }
            main.post { onDone(result) }
        }.start()
    }
}
