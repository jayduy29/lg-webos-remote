package com.vibe.lgremote

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

class TvDiscovery(private val context: Context) {

    fun getLocalWifiIp(): String {
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return ""
            var fallback = ""
            while (interfaces.hasMoreElements()) {
                val nif = interfaces.nextElement()
                if (!nif.isUp || nif.isLoopback) continue
                val addrs = nif.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val ip = addr.hostAddress ?: continue
                        val name = nif.name.lowercase()
                        if (name.contains("wlan") || name.contains("wifi")) {
                            return ip
                        }
                        if (fallback.isEmpty() && !ip.startsWith("169.254.")) {
                            fallback = ip
                        }
                    }
                }
            }
            return fallback
        } catch (_: Exception) {
            return ""
        }
    }

    private fun probePort(ip: String, port: Int, timeoutMs: Int = 320): Boolean {
        return try {
            Socket().use { s ->
                s.connect(InetSocketAddress(ip, port), timeoutMs)
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    suspend fun probeWebOSTv(ip: String, timeoutMs: Int = 360): Int? = withContext(Dispatchers.IO) {
        val p3001 = async { probePort(ip, 3001, timeoutMs) }
        val p3000 = async { probePort(ip, 3000, timeoutMs) }
        when {
            p3001.await() -> 3001
            p3000.await() -> 3000
            else -> null
        }
    }

    private fun fetchUpnpXml(location: String): Map<String, String> {
        val out = mutableMapOf<String, String>()
        try {
            val conn = (URL(location).openConnection() as HttpURLConnection).apply {
                connectTimeout = 1800
                readTimeout = 1800
            }
            val xml = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            conn.disconnect()
            fun extract(tag: String): String {
                val regex = Regex("<$tag[^>]*>([^<]+)</$tag>", RegexOption.IGNORE_CASE)
                return regex.find(xml)?.groupValues?.getOrNull(1)?.trim() ?: ""
            }
            out["friendlyName"] = extract("friendlyName")
            out["modelName"] = extract("modelName")
            out["udn"] = extract("UDN")
        } catch (_: Exception) {
        }
        return out
    }

    private suspend fun discoverSSDP(timeoutMs: Long = 2600L): Map<String, JSONObject> =
        withContext(Dispatchers.IO) {
            val found = ConcurrentHashMap<String, JSONObject>()
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val lock = wifi?.createMulticastLock("lg_ssdp_lock")?.apply {
                setReferenceCounted(false)
                try { acquire() } catch (_: Exception) {}
            }

            try {
                DatagramSocket().use { socket ->
                    socket.broadcast = true
                    socket.soTimeout = 450

                    val targets = listOf(
                        "urn:lge-com:service:webos-second-screen:1",
                        "urn:schemas-upnp-org:device:MediaRenderer:1",
                        "ssdp:all"
                    )
                    val group = InetAddress.getByName("239.255.255.250")

                    fun sendSearch() {
                        for (st in targets) {
                            val msg = "M-SEARCH * HTTP/1.1\r\n" +
                                "HOST: 239.255.255.250:1900\r\n" +
                                "MAN: \"ssdp:discover\"\r\n" +
                                "MX: 2\r\n" +
                                "ST: $st\r\n\r\n"
                            val bytes = msg.toByteArray(Charsets.UTF_8)
                            try {
                                socket.send(DatagramPacket(bytes, bytes.size, group, 1900))
                            } catch (_: Exception) {}
                        }
                    }

                    sendSearch()
                    val endTime = System.currentTimeMillis() + timeoutMs
                    var resent = false
                    val buf = ByteArray(4096)

                    while (System.currentTimeMillis() < endTime) {
                        if (!resent && System.currentTimeMillis() > endTime - (timeoutMs / 2)) {
                            resent = true
                            sendSearch()
                        }
                        try {
                            val pkt = DatagramPacket(buf, buf.size)
                            socket.receive(pkt)
                            val ip = pkt.address?.hostAddress ?: continue
                            val text = String(pkt.data, 0, pkt.length, Charsets.UTF_8)
                            val lower = text.lowercase()
                            if (lower.contains("lge-com") || lower.contains("webos") || lower.contains("lge")) {
                                val locMatch = Regex("(?i)location:\\s*(\\S+)").find(text)
                                val location = locMatch?.groupValues?.getOrNull(1)?.trim() ?: ""
                                if (!found.containsKey(ip) || location.isNotEmpty()) {
                                    found[ip] = JSONObject().apply {
                                        put("ip", ip)
                                        put("location", location)
                                        put("via", "ssdp")
                                    }
                                }
                            }
                        } catch (_: Exception) {
                            // socket timeout chunk
                        }
                    }
                }
            } catch (_: Exception) {
            } finally {
                try { lock?.release() } catch (_: Exception) {}
            }

            // Enrich with UPnP XML
            val enriched = ConcurrentHashMap<String, JSONObject>()
            coroutineScope {
                found.values.map { raw ->
                    async(Dispatchers.IO) {
                        val ip = raw.optString("ip")
                        val location = raw.optString("location")
                        val info = if (location.isNotEmpty()) fetchUpnpXml(location) else emptyMap()
                        val port = probeWebOSTv(ip, 450) ?: 3001
                        enriched[ip] = JSONObject().apply {
                            put("ip", ip)
                            put("port", port)
                            put("name", info["friendlyName"].orEmpty().ifEmpty { "LG webOS TV ($ip)" })
                            put("model", info["modelName"].orEmpty().ifEmpty { "LG webOS Smart TV" })
                            put("id", info["udn"].orEmpty().ifEmpty { "lg-$ip" })
                            put("via", "ssdp")
                            put("online", true)
                        }
                    }
                }.awaitAll()
            }
            enriched
        }

    private suspend fun scanSubnet(): List<JSONObject> = withContext(Dispatchers.IO) {
        val localIp = getLocalWifiIp()
        val parts = localIp.split(".")
        if (parts.size != 4) return@withContext emptyList()
        val prefix = "${parts[0]}.${parts[1]}.${parts[2]}"
        val ips = (1..254).map { "$prefix.$it" }.filter { it != localIp }

        val found = mutableListOf<JSONObject>()
        // Scan in batches of 48 for fast ~2.5s sweep
        for (chunk in ips.chunked(48)) {
            val hits = coroutineScope {
                chunk.map { ip ->
                    async(Dispatchers.IO) {
                        val port = probeWebOSTv(ip, 300)
                        if (port != null) {
                            JSONObject().apply {
                                put("ip", ip)
                                put("port", port)
                                put("name", "LG webOS TV ($ip)")
                                put("model", "webOS TV (Port $port)")
                                put("id", "lg-$ip")
                                put("via", "wifi-scan")
                                put("online", true)
                            }
                        } else null
                    }
                }.awaitAll().filterNotNull()
            }
            found.addAll(hits)
        }
        found
    }

    suspend fun discoverAll(savedTvs: List<JSONObject>): Pair<JSONArray, JSONArray> =
        coroutineScope {
            val ssdpDef = async { discoverSSDP(2600L) }
            val subnetDef = async { scanSubnet() }
            val recentDef = async { checkRecentOnline(savedTvs) }

            val merged = LinkedHashMap<String, JSONObject>()
            val ssdpMap = ssdpDef.await()
            ssdpMap.forEach { (ip, obj) -> merged[ip] = obj }

            for (tv in subnetDef.await()) {
                val ip = tv.optString("ip")
                if (!merged.containsKey(ip)) {
                    merged[ip] = tv
                }
            }

            val savedByIp = savedTvs.associateBy { it.optString("ip") }
            val discoveredArr = JSONArray()
            for ((ip, obj) in merged) {
                val saved = savedByIp[ip]
                if (saved != null) {
                    if (!obj.optString("via").contains("ssdp") && saved.optString("name").isNotEmpty()) {
                        obj.put("name", saved.optString("name"))
                    }
                    if (saved.optString("mac").isNotEmpty()) {
                        obj.put("mac", saved.optString("mac"))
                    }
                    obj.put("paired", saved.optString("clientKey").isNotEmpty())
                }
                discoveredArr.put(obj)
            }

            Pair(discoveredArr, recentDef.await())
        }

    suspend fun checkRecentOnline(savedTvs: List<JSONObject>): JSONArray = coroutineScope {
        val checked = savedTvs.map { tv ->
            async(Dispatchers.IO) {
                val copy = JSONObject(tv.toString())
                val port = probeWebOSTv(copy.optString("ip"), 420)
                copy.put("online", port != null)
                if (port != null) copy.put("port", port)
                copy.put("paired", copy.optString("clientKey").isNotEmpty())
                copy
            }
        }.awaitAll()
        JSONArray().apply { checked.forEach { put(it) } }
    }

    suspend fun sendWakeOnLan(macAddress: String, ipAddress: String?) = withContext(Dispatchers.IO) {
        val cleanMac = macAddress.replace(Regex("[^0-9a-fA-F]"), "")
        if (cleanMac.length != 12) {
            throw IllegalArgumentException("Địa chỉ MAC không hợp lệ để bật TV (Wake-on-LAN).")
        }
        val macBytes = ByteArray(6) { i ->
            cleanMac.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        val packet = ByteArray(6 + 16 * 6)
        for (i in 0 until 6) packet[i] = 0xFF.toByte()
        for (i in 0 until 16) {
            System.arraycopy(macBytes, 0, packet, 6 + i * 6, 6)
        }

        val targets = mutableListOf("255.255.255.255")
        if (!ipAddress.isNullOrBlank()) {
            val parts = ipAddress.split(".")
            if (parts.size == 4) targets.add("${parts[0]}.${parts[1]}.${parts[2]}.255")
        }

        DatagramSocket().use { socket ->
            socket.broadcast = true
            for (target in targets) {
                val addr = InetAddress.getByName(target)
                socket.send(DatagramPacket(packet, packet.size, addr, 9))
                socket.send(DatagramPacket(packet, packet.size, addr, 7))
            }
        }
    }
}
