package com.vibe.lgremote

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class TvStorage(context: Context) {
    private val prefs = context.getSharedPreferences("lg_webos_tvs", Context.MODE_PRIVATE)

    fun loadAll(): MutableList<JSONObject> {
        val raw = prefs.getString("tvs", "[]") ?: "[]"
        val list = mutableListOf<JSONObject>()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                list.add(arr.getJSONObject(i))
            }
        } catch (_: Exception) {
        }
        list.sortByDescending { it.optLong("lastConnected", 0L) }
        return list
    }

    private fun saveAll(list: List<JSONObject>) {
        val arr = JSONArray()
        list.forEach { arr.put(it) }
        prefs.edit().putString("tvs", arr.toString()).apply()
    }

    fun getByIp(ip: String): JSONObject? {
        return loadAll().firstOrNull { it.optString("ip") == ip }
    }

    fun upsert(tv: JSONObject): JSONObject {
        val list = loadAll()
        val ip = tv.optString("ip")
        val id = tv.optString("id").ifEmpty { "lg-$ip" }
        val mac = tv.optString("mac")
        val now = System.currentTimeMillis()

        val idx = list.indexOfFirst {
            it.optString("ip") == ip ||
                (id.isNotEmpty() && it.optString("id") == id) ||
                (mac.isNotEmpty() && it.optString("mac").equals(mac, ignoreCase = true))
        }

        val merged = if (idx >= 0) JSONObject(list[idx].toString()) else JSONObject()
        merged.put("id", merged.optString("id").ifEmpty { id })
        merged.put("ip", ip)
        merged.put("name", tv.optString("name").ifEmpty { merged.optString("name").ifEmpty { "LG webOS TV ($ip)" } })
        merged.put("model", tv.optString("model").ifEmpty { merged.optString("model").ifEmpty { "LG webOS Smart TV" } })
        merged.put("mac", mac.ifEmpty { merged.optString("mac") })
        if (tv.has("clientKey") && tv.optString("clientKey").isNotEmpty()) {
            merged.put("clientKey", tv.optString("clientKey"))
        } else if (!merged.has("clientKey")) {
            merged.put("clientKey", "")
        }
        merged.put("port", tv.optInt("port", merged.optInt("port", 3001)))
        merged.put("lastConnected", tv.optLong("lastConnected", now))
        merged.put("paired", merged.optString("clientKey").isNotEmpty())

        if (idx >= 0) {
            list[idx] = merged
        } else {
            list.add(0, merged)
        }
        saveAll(list)
        return merged
    }

    fun delete(idOrIp: String): List<JSONObject> {
        val remaining = loadAll().filterNot {
            it.optString("id") == idOrIp || it.optString("ip") == idOrIp
        }
        saveAll(remaining)
        return remaining
    }
}
