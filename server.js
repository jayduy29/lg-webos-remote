const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const storage = require('./lib/storage');
const discovery = require('./lib/discovery');
const { WebOSTV, VirtualWebOSTV } = require('./lib/webos');

const PORT = Number(process.env.PORT) || 3080;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let activeTV = null;
let activeTVInfo = null;
let tvState = {
  connected: false,
  demo: false,
  volume: 0,
  muted: false,
  apps: [],
  inputs: []
};

function broadcast(event, data = {}) {
  const payload = JSON.stringify({ event, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

async function refreshTVMetadata(tv) {
  try {
    const [vol, appsRes, inputsRes] = await Promise.allSettled([
      tv.getVolume(),
      tv.listApps(),
      tv.getInputs()
    ]);

    if (vol.status === 'fulfilled' && vol.value) {
      tvState.volume = Number(vol.value.volume ?? vol.value.volumeStatus?.volume ?? tvState.volume);
      tvState.muted = Boolean(vol.value.muted ?? vol.value.volumeStatus?.muteStatus ?? tvState.muted);
    }

    if (appsRes.status === 'fulfilled' && appsRes.value && Array.isArray(appsRes.value.launchPoints)) {
      tvState.apps = appsRes.value.launchPoints.map((a) => ({
        id: a.id,
        title: a.title || a.id,
        iconColor: a.iconColor || '#334155',
        largeIcon: a.largeIcon || ''
      }));
    }

    if (inputsRes.status === 'fulfilled' && inputsRes.value && Array.isArray(inputsRes.value.devices)) {
      tvState.inputs = inputsRes.value.devices.map((d) => ({
        id: d.id,
        label: d.label || d.id,
        connected: Boolean(d.connected)
      }));
    }
  } catch {
    // ignore partial metadata failures
  }
}

async function connectToTV({ ip, port = 3001, name, model, mac, demo = false }) {
  if (activeTV) {
    activeTV.disconnect();
    activeTV = null;
  }

  tvState = {
    connected: false,
    demo: Boolean(demo),
    volume: 0,
    muted: false,
    apps: [],
    inputs: []
  };

  if (demo || ip === 'demo-tv') {
    const virtual = new VirtualWebOSTV();
    await virtual.connect();
    activeTV = virtual;
    activeTVInfo = {
      id: 'demo-tv',
      ip: 'demo-tv',
      name: virtual.name,
      model: 'OLED55C4PSA (Demo)',
      mac: 'AA:BB:CC:DD:EE:FF',
      demo: true
    };
    tvState.connected = true;
    tvState.demo = true;

    virtual.subscribe('ssap://audio/getVolume', (payload) => {
      tvState.volume = Number(payload.volume ?? tvState.volume);
      tvState.muted = Boolean(payload.muted ?? tvState.muted);
      broadcast('volume', { volume: tvState.volume, muted: tvState.muted });
    });

    await refreshTVMetadata(virtual);
    broadcast('status', getStatusPayload());
    return getStatusPayload();
  }

  const saved = storage.getTVByIp(ip);
  const arpMap = await discovery.getArpTable();
  const resolvedMac = mac || (saved && saved.mac) || arpMap.get(ip) || '';

  const tv = new WebOSTV({
    ip,
    port: port || (saved && saved.port) || 3001,
    clientKey: (saved && saved.clientKey) || '',
    name: name || (saved && saved.name) || `LG webOS TV (${ip})`
  });

  tv.on('prompt', (info) => {
    broadcast('pairing_prompt', { ip, name: tv.name, message: info.message });
  });

  tv.on('disconnected', () => {
    if (activeTV === tv) {
      tvState.connected = false;
      broadcast('status', getStatusPayload());
      broadcast('toast', { type: 'warn', message: `Đã ngắt kết nối với ${tv.name}` });
    }
  });

  const regResult = await tv.connect();
  activeTV = tv;

  const savedRecord = storage.upsertTV({
    id: (saved && saved.id) || resolvedMac || `lg-${ip}`,
    ip,
    port: regResult.port,
    name: name || (saved && saved.name) || `LG webOS TV (${ip})`,
    model: model || (saved && saved.model) || 'LG webOS Smart TV',
    mac: resolvedMac,
    clientKey: regResult.clientKey,
    lastConnected: Date.now()
  });

  activeTVInfo = { ...savedRecord, demo: false };
  tvState.connected = true;
  tvState.demo = false;

  tv.subscribe('ssap://audio/getVolume', (payload) => {
    const vol = payload.volume ?? payload.volumeStatus?.volume;
    const muted = payload.muted ?? payload.volumeStatus?.muteStatus;
    if (vol !== undefined) tvState.volume = Number(vol);
    if (muted !== undefined) tvState.muted = Boolean(muted);
    broadcast('volume', { volume: tvState.volume, muted: tvState.muted });
  });

  await refreshTVMetadata(tv);
  broadcast('status', getStatusPayload());
  return getStatusPayload();
}

function getStatusPayload() {
  return {
    connected: Boolean(activeTV && tvState.connected),
    demo: tvState.demo,
    tv: activeTVInfo,
    volume: tvState.volume,
    muted: tvState.muted,
    apps: tvState.apps,
    inputs: tvState.inputs
  };
}

// REST API Routes
app.get('/api/network-info', async (req, res) => {
  try {
    const interfaces = discovery.getLocalInterfaces();
    const primary = interfaces.find((i) => !i.isVirtual) || interfaces[0] || { address: 'localhost', name: 'Local' };
    const url = `http://${primary.address}:${PORT}`;
    const qrDataUrl = await QRCode.toDataURL(url, {
      margin: 1,
      width: 220,
      color: { dark: '#f8fafc', light: '#0f172a' }
    });
    res.json({
      ip: primary.address,
      interfaceName: primary.name,
      port: PORT,
      url,
      qrDataUrl,
      interfaces
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json(getStatusPayload());
});

app.get('/api/tvs', async (req, res) => {
  try {
    const saved = storage.loadTVs();
    if (req.query.check === '1') {
      const checked = await discovery.checkRecentTVsOnline(saved);
      return res.json({ tvs: checked });
    }
    res.json({
      tvs: saved.map((t) => ({
        ...t,
        paired: Boolean(t.clientKey),
        online: activeTVInfo && activeTVInfo.ip === t.ip && tvState.connected ? true : null
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tvs/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const remaining = storage.deleteTV(id);
  res.json({ ok: true, tvs: remaining });
});

app.post('/api/scan', async (req, res) => {
  try {
    const saved = storage.loadTVs();
    const [discovered, recentChecked] = await Promise.all([
      discovery.discoverAllTVs(saved),
      discovery.checkRecentTVsOnline(saved)
    ]);

    // Update MAC addresses for any saved TV we discovered
    for (const d of discovered) {
      const existing = storage.getTVByIp(d.ip);
      if (existing && (d.mac || (d.via && d.via.includes('ssdp')))) {
        storage.upsertTV({
          ...existing,
          mac: d.mac || existing.mac,
          name: d.via && d.via.includes('ssdp') ? d.name : existing.name,
          model: d.via && d.via.includes('ssdp') ? d.model : existing.model
        });
      }
    }

    res.json({
      discovered,
      recent: recentChecked
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connect', async (req, res) => {
  try {
    const status = await connectToTV(req.body || {});
    res.json({ ok: true, status });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  if (activeTV) {
    activeTV.disconnect();
    activeTV = null;
  }
  activeTVInfo = null;
  tvState.connected = false;
  tvState.demo = false;
  broadcast('status', getStatusPayload());
  res.json({ ok: true });
});

app.post('/api/wol', async (req, res) => {
  try {
    const { mac, ip } = req.body || {};
    let targetMac = mac;
    if (!targetMac && ip) {
      const saved = storage.getTVByIp(ip);
      targetMac = saved && saved.mac;
    }
    const result = await discovery.sendWakeOnLan(targetMac, ip);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// WebSocket Bridge for low-latency remote & touchpad control
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'status', data: getStatusPayload() }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    const { action, payload = {}, reqId } = msg;
    const reply = (ok, data = {}, error = null) => {
      if (ws.readyState === 1 && reqId) {
        ws.send(JSON.stringify({ event: 'reply', reqId, ok, data, error }));
      }
    };

    try {
      if (action === 'ping') {
        return reply(true, { pong: true });
      }

      if (!activeTV || !tvState.connected) {
        return reply(false, {}, 'Chưa kết nối TV LG nào. Hãy chọn hoặc quét TV trước.');
      }

      switch (action) {
        case 'button':
          await activeTV.sendButton(payload.name);
          break;
        case 'pointer_move':
          await activeTV.movePointer(payload.dx || 0, payload.dy || 0, payload.drag || 0);
          break;
        case 'pointer_click':
          await activeTV.clickPointer();
          break;
        case 'pointer_scroll':
          await activeTV.scrollPointer(payload.dx || 0, payload.dy || 0);
          break;
        case 'volume_up':
          await activeTV.volumeUp();
          break;
        case 'volume_down':
          await activeTV.volumeDown();
          break;
        case 'volume_set':
          await activeTV.setVolume(payload.volume);
          break;
        case 'mute_toggle':
          await activeTV.setMute(!tvState.muted);
          break;
        case 'channel_up':
          await activeTV.channelUp();
          break;
        case 'channel_down':
          await activeTV.channelDown();
          break;
        case 'power_off':
          await activeTV.turnOff();
          break;
        case 'media_play':
          await activeTV.mediaPlay();
          break;
        case 'media_pause':
          await activeTV.mediaPause();
          break;
        case 'media_stop':
          await activeTV.mediaStop();
          break;
        case 'media_rewind':
          await activeTV.mediaRewind();
          break;
        case 'media_ff':
          await activeTV.mediaFastForward();
          break;
        case 'launch_app':
          await activeTV.launchApp(payload.id, payload.params || {});
          break;
        case 'switch_input':
          await activeTV.switchInput(payload.inputId);
          break;
        case 'text_insert':
          await activeTV.insertText(payload.text || '', payload.replace ? 1 : 0);
          break;
        case 'text_delete':
          await activeTV.deleteCharacters(payload.count || 1);
          break;
        case 'text_enter':
          await activeTV.sendEnterKey();
          break;
        case 'toast':
          await activeTV.createToast(payload.message || '');
          break;
        case 'open_url':
          await activeTV.openUrl(payload.url || '');
          break;
        case 'refresh_meta':
          await refreshTVMetadata(activeTV);
          broadcast('status', getStatusPayload());
          break;
        default:
          return reply(false, {}, `Lệnh không hỗ trợ: ${action}`);
      }

      reply(true, { ok: true });
    } catch (err) {
      reply(false, {}, err.message || 'Lỗi gửi lệnh tới TV');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ifaces = discovery.getLocalInterfaces().filter((i) => !i.isVirtual);
  const lanIp = ifaces[0] ? ifaces[0].address : 'localhost';
  console.log('\n==================================================');
  console.log('  LG webOS Remote Web App is running!');
  console.log(`  Local PC : http://localhost:${PORT}`);
  console.log(`  Mobile   : http://${lanIp}:${PORT}`);
  console.log('==================================================\n');
});
