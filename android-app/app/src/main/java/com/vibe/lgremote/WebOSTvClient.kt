package com.vibe.lgremote

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class WebOSTvClient(
    private val onEvent: (String, JSONObject) -> Unit
) {
    private val httpClient: OkHttpClient = buildUnsafeOkHttpClient()
    private var mainWs: WebSocket? = null
    private var pointerWs: WebSocket? = null
    private val msgCounter = AtomicInteger(0)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    private val subscriptions = ConcurrentHashMap<String, (JSONObject) -> Unit>()

    @Volatile var connected: Boolean = false
    @Volatile var demoMode: Boolean = false
    @Volatile var currentTv: JSONObject? = null
    @Volatile var volume: Int = 20
    @Volatile var muted: Boolean = false
    @Volatile var apps: JSONArray = JSONArray()
    @Volatile var inputs: JSONArray = JSONArray()

    private fun buildUnsafeOkHttpClient(): OkHttpClient {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, trustAll, SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustAll[0] as X509TrustManager)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }

    fun getStatusJson(): JSONObject = JSONObject().apply {
        put("connected", connected)
        put("demo", demoMode)
        put("tv", currentTv ?: JSONObject.NULL)
        put("volume", volume)
        put("muted", muted)
        put("apps", apps)
        put("inputs", inputs)
    }

    suspend fun connectDemo(): JSONObject {
        disconnect()
        demoMode = true
        connected = true
        volume = 28
        muted = false
        currentTv = JSONObject().apply {
            put("id", "demo-tv")
            put("ip", "demo-tv")
            put("name", "LG OLED C4 55\" (Demo)")
            put("model", "OLED55C4PSA (Demo)")
            put("demo", true)
        }
        apps = JSONArray().apply {
            listOf(
                Triple("youtube.leanback.v4", "YouTube", "#FF0000"),
                Triple("netflix", "Netflix", "#E50914"),
                Triple("com.fptplay.app", "FPT Play", "#FF6B00"),
                Triple("com.vtvgo.app", "VTV Go", "#0055A5"),
                Triple("spotify-beehive", "Spotify", "#1DB954"),
                Triple("com.vieon.app", "VieON", "#00C853"),
                Triple("com.webos.app.browser", "Trình duyệt Web", "#2563EB"),
                Triple("com.apple.appletv", "Apple TV", "#1F2937"),
                Triple("amazon", "Prime Video", "#00A8E1"),
                Triple("com.palm.app.settings", "Cài đặt TV", "#475569")
            ).forEach { (id, title, color) ->
                put(JSONObject().apply {
                    put("id", id)
                    put("title", title)
                    put("iconColor", color)
                })
            }
        }
        inputs = JSONArray().apply {
            listOf(
                Triple("HDMI_1", "HDMI 1 (PS5)", true),
                Triple("HDMI_2", "HDMI 2 (Soundbar eARC)", true),
                Triple("HDMI_3", "HDMI 3", false),
                Triple("HDMI_4", "HDMI 4 (PC)", true)
            ).forEach { (id, label, conn) ->
                put(JSONObject().apply {
                    put("id", id)
                    put("label", label)
                    put("connected", conn)
                })
            }
        }
        val st = getStatusJson()
        onEvent("status", st)
        return st
    }

    suspend fun connectReal(tvInfo: JSONObject, savedClientKey: String): Pair<JSONObject, String> =
        withContext(Dispatchers.IO) {
            disconnect()
            val ip = tvInfo.optString("ip")
            val prefPort = tvInfo.optInt("port", 3001)
            val endpoints = if (prefPort == 3000) {
                listOf("ws://$ip:3000" to 3000, "wss://$ip:3001" to 3001)
            } else {
                listOf("wss://$ip:3001" to 3001, "ws://$ip:3000" to 3000)
            }

            var lastErr: Exception? = null
            for ((url, port) in endpoints) {
                try {
                    openMainSocket(url)
                    val newKey = register(savedClientKey, tvInfo.optString("name").ifEmpty { "LG TV ($ip)" }, ip)
                    demoMode = false
                    connected = true
                    currentTv = JSONObject(tvInfo.toString()).apply {
                        put("port", port)
                        put("clientKey", newKey)
                        put("demo", false)
                    }
                    try { connectPointerSocket() } catch (_: Exception) {}
                    subscribeVolume()
                    refreshMetadata()
                    val st = getStatusJson()
                    onEvent("status", st)
                    return@withContext Pair(st, newKey)
                } catch (e: Exception) {
                    lastErr = e
                    disconnect()
                }
            }
            throw lastErr ?: RuntimeException("Không thể kết nối tới TV tại $ip")
        }

    private suspend fun openMainSocket(url: String) {
        val openDeferred = CompletableDeferred<Unit>()
        val req = Request.Builder().url(url).build()
        val ws = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                mainWs = webSocket
                if (!openDeferred.isCompleted) openDeferred.complete(Unit)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!openDeferred.isCompleted) {
                    openDeferred.completeExceptionally(t)
                }
                handleClosed()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleClosed()
            }
        })
        try {
            withTimeout(5500L) { openDeferred.await() }
        } catch (e: Exception) {
            try { ws.cancel() } catch (_: Exception) {}
            throw e
        }
    }

    private fun handleMessage(raw: String) {
        val msg = try { JSONObject(raw) } catch (_: Exception) { return }
        val type = msg.optString("type")
        val id = msg.optString("id")
        val payload = msg.optJSONObject("payload") ?: JSONObject()

        when (type) {
            "registered" -> {
                pending.remove(id)?.complete(payload)
            }
            "response" -> {
                if (payload.optString("pairingType") == "PROMPT") {
                    onEvent("pairing_prompt", JSONObject().apply {
                        put("message", "Hãy bấm \"Chấp nhận\" (Accept) trên màn hình TV LG của bạn!")
                    })
                    return
                }
                pending.remove(id)?.complete(payload)
                subscriptions[id]?.invoke(payload)
            }
            "error" -> {
                pending.remove(id)?.completeExceptionally(
                    RuntimeException(msg.optString("error", "TV trả về lỗi"))
                )
            }
        }
    }

    private fun handleClosed() {
        val wasConnected = connected
        connected = false
        pointerWs?.close(1000, null)
        pointerWs = null
        pending.values.forEach { it.completeExceptionally(RuntimeException("Mất kết nối với TV")) }
        pending.clear()
        subscriptions.clear()
        if (wasConnected && !demoMode) {
            onEvent("status", getStatusJson())
            onEvent("toast", JSONObject().apply {
                put("type", "warn")
                put("message", "Đã ngắt kết nối với TV LG")
            })
        }
    }

    private suspend fun register(clientKey: String, name: String, ip: String): String {
        val id = "reg_${msgCounter.incrementAndGet()}"
        val def = CompletableDeferred<JSONObject>()
        pending[id] = def

        val permissions = JSONArray(listOf(
            "LAUNCH", "LAUNCH_WEBAPP", "APP_TO_APP", "CLOSE", "TEST_OPEN", "TEST_PROTECTED",
            "CONTROL_AUDIO", "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK",
            "CONTROL_INPUT_MEDIA_RECORDING", "CONTROL_INPUT_MEDIA_PLAYBACK",
            "CONTROL_INPUT_TV", "CONTROL_POWER", "READ_APP_STATUS", "READ_CURRENT_CHANNEL",
            "READ_INPUT_DEVICE_LIST", "READ_NETWORK_STATE", "READ_RUNNING_APPS",
            "READ_TV_CHANNEL_LIST", "WRITE_NOTIFICATION_TOAST", "READ_POWER_STATE",
            "READ_COUNTRY_INFO", "CONTROL_INPUT_TEXT", "CONTROL_MOUSE_AND_KEYBOARD",
            "READ_INSTALLED_APPS"
        ))

        val manifest = JSONObject().apply {
            put("manifestVersion", 1)
            put("appVersion", "1.1")
            put("signed", JSONObject().apply {
                put("created", "20140509")
                put("appId", "com.lge.test")
                put("vendorId", "com.lge")
                put("localizedAppNames", JSONObject().apply {
                    put("", "LG Remote App")
                    put("vi-VN", "Điều khiển TV LG")
                })
                put("localizedVendorNames", JSONObject().apply { put("", "LG Electronics") })
                put("serial", "2f930e2d2cfe083771f68e4fe7bb07")
            })
            put("permissions", permissions)
            put("signatures", JSONArray().put(JSONObject().apply {
                put("signatureVersion", 1)
                put("signature", "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9")
            }))
        }

        val payload = JSONObject().apply {
            put("forcePairing", false)
            put("pairingType", "PROMPT")
            put("manifest", manifest)
            if (clientKey.isNotEmpty()) put("client-key", clientKey)
        }

        val req = JSONObject().apply {
            put("type", "register")
            put("id", id)
            put("payload", payload)
        }
        mainWs?.send(req.toString()) ?: throw RuntimeException("Socket chưa sẵn sàng")

        val res = withTimeout(45000L) { def.await() }
        return res.optString("client-key").ifEmpty { clientKey }
    }

    suspend fun request(uri: String, payload: JSONObject = JSONObject(), timeoutMs: Long = 7000L): JSONObject {
        val ws = mainWs ?: throw RuntimeException("Chưa kết nối với TV")
        val id = "req_${msgCounter.incrementAndGet()}"
        val def = CompletableDeferred<JSONObject>()
        pending[id] = def
        val msg = JSONObject().apply {
            put("id", id)
            put("type", "request")
            put("uri", uri)
            put("payload", payload)
        }
        ws.send(msg.toString())
        return withTimeout(timeoutMs) { def.await() }
    }

    private fun subscribeVolume() {
        val ws = mainWs ?: return
        val id = "sub_${msgCounter.incrementAndGet()}"
        subscriptions[id] = { payload ->
            val vs = payload.optJSONObject("volumeStatus")
            val v = when {
                payload.has("volume") -> payload.optInt("volume", volume)
                vs != null && vs.has("volume") -> vs.optInt("volume", volume)
                else -> volume
            }
            val m = when {
                payload.has("muted") -> payload.optBoolean("muted", muted)
                vs != null && vs.has("muteStatus") -> vs.optBoolean("muteStatus", muted)
                else -> muted
            }
            volume = v
            muted = m
            onEvent("volume", JSONObject().apply {
                put("volume", volume)
                put("muted", muted)
            })
        }
        ws.send(JSONObject().apply {
            put("id", id)
            put("type", "subscribe")
            put("uri", "ssap://audio/getVolume")
            put("payload", JSONObject())
        }.toString())
    }

    suspend fun refreshMetadata() {
        if (demoMode) return
        try {
            val volRes = request("ssap://audio/getVolume")
            val vs = volRes.optJSONObject("volumeStatus")
            if (volRes.has("volume")) volume = volRes.optInt("volume", volume)
            else if (vs != null && vs.has("volume")) volume = vs.optInt("volume", volume)
            if (volRes.has("muted")) muted = volRes.optBoolean("muted", muted)
            else if (vs != null && vs.has("muteStatus")) muted = vs.optBoolean("muteStatus", muted)
        } catch (_: Exception) {}

        try {
            val appsRes = request("ssap://com.webos.applicationManager/listLaunchPoints")
            val lp = appsRes.optJSONArray("launchPoints") ?: JSONArray()
            val out = JSONArray()
            for (i in 0 until lp.length()) {
                val a = lp.getJSONObject(i)
                out.put(JSONObject().apply {
                    put("id", a.optString("id"))
                    put("title", a.optString("title").ifEmpty { a.optString("id") })
                    put("iconColor", a.optString("iconColor").ifEmpty { "#334155" })
                })
            }
            apps = out
        } catch (_: Exception) {}

        try {
            val inRes = request("ssap://tv/getExternalInputList")
            val devs = inRes.optJSONArray("devices") ?: JSONArray()
            val out = JSONArray()
            for (i in 0 until devs.length()) {
                val d = devs.getJSONObject(i)
                out.put(JSONObject().apply {
                    put("id", d.optString("id"))
                    put("label", d.optString("label").ifEmpty { d.optString("id") })
                    put("connected", d.optBoolean("connected", false))
                })
            }
            inputs = out
        } catch (_: Exception) {}
    }

    private suspend fun connectPointerSocket() {
        val res = request("ssap://com.webos.service.networkinput/getPointerInputSocket")
        val socketPath = res.optString("socketPath")
        if (socketPath.isEmpty()) return
        val openDef = CompletableDeferred<Unit>()
        httpClient.newWebSocket(Request.Builder().url(socketPath).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                pointerWs = webSocket
                if (!openDef.isCompleted) openDef.complete(Unit)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!openDef.isCompleted) openDef.completeExceptionally(t)
                if (pointerWs == webSocket) pointerWs = null
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (pointerWs == webSocket) pointerWs = null
            }
        })
        withTimeout(4000L) { openDef.await() }
    }

    private suspend fun ensurePointer(): WebSocket? {
        if (pointerWs != null) return pointerWs
        return try {
            connectPointerSocket()
            pointerWs
        } catch (_: Exception) {
            null
        }
    }

    suspend fun executeCommand(action: String, payload: JSONObject) {
        if (!connected) throw RuntimeException("Chưa kết nối TV LG nào. Hãy quét hoặc chọn TV trước.")

        if (demoMode) {
            when (action) {
                "volume_up" -> {
                    volume = (volume + 2).coerceAtMost(100)
                    muted = false
                    onEvent("volume", JSONObject().apply { put("volume", volume); put("muted", muted) })
                }
                "volume_down" -> {
                    volume = (volume - 2).coerceAtLeast(0)
                    muted = false
                    onEvent("volume", JSONObject().apply { put("volume", volume); put("muted", muted) })
                }
                "volume_set" -> {
                    volume = payload.optInt("volume", volume).coerceIn(0, 100)
                    muted = false
                    onEvent("volume", JSONObject().apply { put("volume", volume); put("muted", muted) })
                }
                "mute_toggle" -> {
                    muted = !muted
                    onEvent("volume", JSONObject().apply { put("volume", volume); put("muted", muted) })
                }
            }
            return
        }

        when (action) {
            "button" -> {
                val pws = ensurePointer() ?: throw RuntimeException("Không mở được kết nối phím điều khiển")
                pws.send("type:button\nname:${payload.optString("name")}\n\n")
            }
            "pointer_move" -> {
                val pws = ensurePointer() ?: return
                val dx = Math.round(payload.optDouble("dx", 0.0))
                val dy = Math.round(payload.optDouble("dy", 0.0))
                pws.send("type:move\ndx:$dx\ndy:$dy\ndown:0\n\n")
            }
            "pointer_click" -> {
                val pws = ensurePointer() ?: return
                pws.send("type:click\n\n")
            }
            "pointer_scroll" -> {
                val pws = ensurePointer() ?: return
                val dx = Math.round(payload.optDouble("dx", 0.0))
                val dy = Math.round(payload.optDouble("dy", 0.0))
                pws.send("type:scroll\ndx:$dx\ndy:$dy\n\n")
            }
            "volume_up" -> request("ssap://audio/volumeUp")
            "volume_down" -> request("ssap://audio/volumeDown")
            "volume_set" -> request("ssap://audio/setVolume", JSONObject().put("volume", payload.optInt("volume", 20).coerceIn(0, 100)))
            "mute_toggle" -> request("ssap://audio/setMute", JSONObject().put("mute", !muted))
            "channel_up" -> request("ssap://tv/channelUp")
            "channel_down" -> request("ssap://tv/channelDown")
            "power_off" -> request("ssap://system/turnOff")
            "media_play" -> request("ssap://media.controls/play")
            "media_pause" -> request("ssap://media.controls/pause")
            "media_stop" -> request("ssap://media.controls/stop")
            "media_rewind" -> request("ssap://media.controls/rewind")
            "media_ff" -> request("ssap://media.controls/fastForward")
            "launch_app" -> request("ssap://system.launcher/launch", JSONObject().put("id", payload.optString("id")))
            "switch_input" -> request("ssap://tv/switchInput", JSONObject().put("inputId", payload.optString("inputId")))
            "text_insert" -> request("ssap://com.webos.service.ime/insertText", JSONObject().apply {
                put("text", payload.optString("text"))
                put("replace", 0)
            })
            "text_delete" -> request("ssap://com.webos.service.ime/deleteCharacters", JSONObject().put("count", payload.optInt("count", 1)))
            "text_enter" -> request("ssap://com.webos.service.ime/sendEnterKey")
            "toast" -> request("ssap://system.notifications/createToast", JSONObject().put("message", payload.optString("message")))
            "open_url" -> request("ssap://system.launcher/open", JSONObject().put("target", payload.optString("url")))
            "refresh_meta" -> {
                refreshMetadata()
                onEvent("status", getStatusJson())
            }
        }
    }

    fun disconnect() {
        pointerWs?.close(1000, null)
        pointerWs = null
        mainWs?.close(1000, null)
        mainWs = null
        connected = false
        demoMode = false
        currentTv = null
        pending.clear()
        subscriptions.clear()
    }
}
