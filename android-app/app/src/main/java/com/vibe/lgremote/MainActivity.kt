package com.vibe.lgremote

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var storage: TvStorage
    private lateinit var discovery: TvDiscovery
    private lateinit var tvClient: WebOSTvClient
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        storage = TvStorage(this)
        discovery = TvDiscovery(this)
        tvClient = WebOSTvClient { event, data ->
            emitToJs(event, data)
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#09090b"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            addJavascriptInterface(NativeBridge(), "NativeLGRemote")
        }

        setContentView(webView)
        webView.loadUrl("file:///android_asset/www/index.html")
    }

    private fun emitToJs(event: String, data: JSONObject) {
        val payload = JSONObject().apply {
            put("event", event)
            put("data", data)
        }.toString()
        val quoted = JSONObject.quote(payload)
        runOnUiThread {
            webView.evaluateJavascript("window.__onNativeEvent && window.__onNativeEvent($quoted);", null)
        }
    }

    private fun resolveJsCall(callId: String, ok: Boolean, data: Any? = null, error: String? = null) {
        val res = JSONObject().apply {
            put("callId", callId)
            put("ok", ok)
            if (data != null) put("data", data)
            if (error != null) put("error", error)
        }.toString()
        val quoted = JSONObject.quote(res)
        runOnUiThread {
            webView.evaluateJavascript("window.__onNativeResponse && window.__onNativeResponse($quoted);", null)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (tvClient.connected) {
            when (keyCode) {
                KeyEvent.KEYCODE_VOLUME_UP -> {
                    scope.launch(Dispatchers.IO) {
                        try { tvClient.executeCommand("volume_up", JSONObject()) } catch (_: Exception) {}
                    }
                    return true
                }
                KeyEvent.KEYCODE_VOLUME_DOWN -> {
                    scope.launch(Dispatchers.IO) {
                        try { tvClient.executeCommand("volume_down", JSONObject()) } catch (_: Exception) {}
                    }
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        super.onDestroy()
        tvClient.disconnect()
        scope.cancel()
    }

    inner class NativeBridge {
        @JavascriptInterface
        fun call(callId: String, method: String, argsJson: String) {
            val args = try { JSONObject(argsJson) } catch (_: Exception) { JSONObject() }
            scope.launch(Dispatchers.IO) {
                try {
                    when (method) {
                        "networkInfo" -> {
                            val ip = discovery.getLocalWifiIp()
                            resolveJsCall(callId, true, JSONObject().apply {
                                put("ip", ip.ifEmpty { "Chưa có Wi-Fi" })
                                put("interfaceName", "Wi-Fi điện thoại")
                                put("nativeAndroid", true)
                            })
                        }
                        "status" -> {
                            resolveJsCall(callId, true, tvClient.getStatusJson())
                        }
                        "getTvs" -> {
                            val saved = storage.loadAll()
                            val check = args.optBoolean("check", false)
                            val arr = if (check) {
                                discovery.checkRecentOnline(saved)
                            } else {
                                JSONArray().apply { saved.forEach { put(it) } }
                            }
                            resolveJsCall(callId, true, JSONObject().put("tvs", arr))
                        }
                        "deleteTv" -> {
                            val rem = storage.delete(args.optString("id"))
                            val arr = JSONArray().apply { rem.forEach { put(it) } }
                            resolveJsCall(callId, true, JSONObject().put("tvs", arr))
                        }
                        "scan" -> {
                            val saved = storage.loadAll()
                            val (discovered, recent) = discovery.discoverAll(saved)
                            for (i in 0 until discovered.length()) {
                                val d = discovered.getJSONObject(i)
                                val existing = storage.getByIp(d.optString("ip"))
                                if (existing != null && d.optString("via").contains("ssdp")) {
                                    storage.upsert(JSONObject(existing.toString()).apply {
                                        put("name", d.optString("name"))
                                        put("model", d.optString("model"))
                                    })
                                }
                            }
                            resolveJsCall(callId, true, JSONObject().apply {
                                put("discovered", discovered)
                                put("recent", recent)
                            })
                        }
                        "connect" -> {
                            val isDemo = args.optBoolean("demo", false) || args.optString("ip") == "demo-tv"
                            if (isDemo) {
                                val st = tvClient.connectDemo()
                                resolveJsCall(callId, true, JSONObject().put("status", st))
                            } else {
                                val ip = args.optString("ip")
                                val saved = storage.getByIp(ip)
                                val savedKey = saved?.optString("clientKey").orEmpty()
                                val (st, newKey) = tvClient.connectReal(args, savedKey)
                                storage.upsert(JSONObject(args.toString()).apply {
                                    put("clientKey", newKey)
                                    put("lastConnected", System.currentTimeMillis())
                                })
                                resolveJsCall(callId, true, JSONObject().put("status", st))
                            }
                        }
                        "disconnect" -> {
                            tvClient.disconnect()
                            val st = tvClient.getStatusJson()
                            emitToJs("status", st)
                            resolveJsCall(callId, true, JSONObject().put("ok", true))
                        }
                        "wol" -> {
                            var mac = args.optString("mac")
                            val ip = args.optString("ip")
                            if (mac.isEmpty() && ip.isNotEmpty()) {
                                mac = storage.getByIp(ip)?.optString("mac").orEmpty()
                            }
                            discovery.sendWakeOnLan(mac, ip)
                            resolveJsCall(callId, true, JSONObject().put("ok", true))
                        }
                        "command" -> {
                            val action = args.optString("action")
                            val payload = args.optJSONObject("payload") ?: JSONObject()
                            tvClient.executeCommand(action, payload)
                            resolveJsCall(callId, true, JSONObject().put("ok", true))
                        }
                        else -> resolveJsCall(callId, false, null, "Lệnh không hỗ trợ: $method")
                    }
                } catch (e: Exception) {
                    resolveJsCall(callId, false, null, e.message ?: "Lỗi kết nối TV")
                }
            }
        }
    }
}
