/**
 * Standalone Browser Engine for LG webOS Remote (GitHub Pages / Static Web Mode)
 * - Direct WebSocket SSAP connection to LG webOS TVs (wss://<ip>:3001 / ws://<ip>:3000)
 * - Built-in Virtual Demo TV (no backend required)
 * - LocalStorage Recent TVs & client-key persistence
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'lg_webos_remote_tvs_v1';

  const CLIENT_MANIFEST = {
    forcePairing: false,
    pairingType: 'PROMPT',
    manifest: {
      manifestVersion: 1,
      appVersion: '1.1',
      signed: {
        created: '20140509',
        appId: 'com.lge.test',
        vendorId: 'com.lge',
        localizedAppNames: {
          '': 'LG Remote Web',
          'vi-VN': 'Điều khiển TV LG (Web)',
          'en-US': 'LG webOS Web Remote'
        },
        localizedVendorNames: {
          '': 'LG Electronics'
        },
        serial: '2f930e2d2cfe083771f68e4fe7bb07'
      },
      permissions: [
        'LAUNCH',
        'LAUNCH_WEBAPP',
        'APP_TO_APP',
        'CLOSE',
        'TEST_OPEN',
        'TEST_PROTECTED',
        'CONTROL_AUDIO',
        'CONTROL_DISPLAY',
        'CONTROL_INPUT_JOYSTICK',
        'CONTROL_INPUT_MEDIA_RECORDING',
        'CONTROL_INPUT_MEDIA_PLAYBACK',
        'CONTROL_INPUT_TV',
        'CONTROL_POWER',
        'READ_APP_STATUS',
        'READ_CURRENT_CHANNEL',
        'READ_INPUT_DEVICE_LIST',
        'READ_NETWORK_STATE',
        'READ_RUNNING_APPS',
        'READ_TV_CHANNEL_LIST',
        'WRITE_NOTIFICATION_TOAST',
        'READ_POWER_STATE',
        'READ_COUNTRY_INFO',
        'CONTROL_INPUT_TEXT',
        'CONTROL_MOUSE_AND_KEYBOARD',
        'READ_INSTALLED_APPS'
      ],
      signatures: [
        {
          signatureVersion: 1,
          signature:
            'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9'
        }
      ]
    }
  };

  // --- LocalStorage Recent TVs ---
  const browserStorage = {
    getAll() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },
    saveAll(list) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      } catch {}
    },
    getByIp(ip) {
      return this.getAll().find((t) => t.ip === ip) || null;
    },
    upsert(tv) {
      const list = this.getAll();
      const idx = list.findIndex((t) => t.ip === tv.ip || (tv.id && t.id === tv.id));
      const existing = idx >= 0 ? list[idx] : {};
      const merged = {
        ...existing,
        ...tv,
        id: tv.id || existing.id || tv.ip,
        lastConnected: Date.now()
      };
      if (idx >= 0) list[idx] = merged;
      else list.unshift(merged);
      list.sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));
      this.saveAll(list);
      return merged;
    },
    remove(idOrIp) {
      const list = this.getAll().filter((t) => t.id !== idOrIp && t.ip !== idOrIp);
      this.saveAll(list);
    }
  };

  // --- Direct Browser WebOS SSAP Client ---
  class DirectWebOSTV {
    constructor({ ip, port = 3001, clientKey = '', name = '', onEvent }) {
      this.ip = ip;
      this.port = port;
      this.clientKey = clientKey || '';
      this.name = name || `LG TV (${ip})`;
      this.onEvent = onEvent || (() => {});
      this.ws = null;
      this.pointerWs = null;
      this.connected = false;
      this.registered = false;
      this.msgId = 0;
      this.pending = new Map();
      this.subscriptions = new Map();
    }

    async connect() {
      this.disconnect();
      const isHttps = location.protocol === 'https:';
      // On HTTPS (GitHub Pages), browsers block ws:// (Mixed Content), so use wss://:3001
      const endpoints = isHttps
        ? [`wss://${this.ip}:3001`]
        : this.port === 3000
          ? [`ws://${this.ip}:3000`, `wss://${this.ip}:3001`]
          : [`wss://${this.ip}:3001`, `ws://${this.ip}:3000`];

      let lastErr = null;
      for (const url of endpoints) {
        try {
          await this._openSocket(url);
          this.port = url.startsWith('wss://') ? 3001 : 3000;
          await this._register();
          this._connectPointerSocket().catch(() => {});
          return {
            ip: this.ip,
            port: this.port,
            clientKey: this.clientKey,
            name: this.name
          };
        } catch (err) {
          lastErr = err;
          this.disconnect();
        }
      }

      if (isHttps) {
        throw new Error(
          `Không kết nối được wss://${this.ip}:3001. Hãy bấm "Tin cậy chứng chỉ TV" (mở https://${this.ip}:3001 và bấm Tiếp tục) rồi thử lại, hoặc kiểm tra TV đang bật cùng Wi-Fi.`
        );
      }
      throw lastErr || new Error(`Không thể kết nối tới TV tại ${this.ip}`);
    }

    _openSocket(url) {
      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket(url);
        } catch (err) {
          return reject(err);
        }

        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error(`Timeout kết nối ${url}`));
        }, 5500);

        ws.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.ws = ws;
          this.connected = true;
          this._attachSocketHandlers(ws);
          resolve();
        };

        ws.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Lỗi kết nối WebSocket tới ${url}`));
        };
      });
    }

    _attachSocketHandlers(ws) {
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (msg.type === 'registered') {
          this.registered = true;
          if (msg.payload && msg.payload['client-key']) {
            this.clientKey = msg.payload['client-key'];
          }
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg.payload || {});
          }
          return;
        }

        if (msg.type === 'response') {
          if (msg.payload && msg.payload.pairingType === 'PROMPT') {
            this.onEvent({
              event: 'pairing_prompt',
              data: { message: 'Hãy dùng remote TV bấm "Chấp nhận" (Accept) trên màn hình TV LG!' }
            });
            return;
          }
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg.payload || {});
          }
          const sub = this.subscriptions.get(msg.id);
          if (sub) sub(msg.payload || {});
          return;
        }

        if (msg.type === 'error') {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.reject(new Error(msg.error || 'TV trả về lỗi'));
          }
        }
      };

      ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.registered = false;
        if (this.pointerWs) {
          try { this.pointerWs.close(); } catch {}
          this.pointerWs = null;
        }
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Mất kết nối với TV'));
        }
        this.pending.clear();
        this.subscriptions.clear();
        if (wasConnected) {
          this.onEvent({ event: 'disconnected', data: {} });
        }
      };
    }

    _register() {
      return new Promise((resolve, reject) => {
        const id = `reg_${++this.msgId}`;
        const payload = {
          ...CLIENT_MANIFEST,
          'client-key': this.clientKey || undefined
        };
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Hết thời gian chờ xác nhận ghép đôi trên TV (45 giây).'));
        }, 45000);
        this.pending.set(id, { resolve, reject, timer });
        this.ws.send(JSON.stringify({ type: 'register', id, payload }));
      });
    }

    request(uri, payload = {}, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return reject(new Error('Chưa kết nối với TV'));
        }
        const id = `req_${++this.msgId}`;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Timeout lệnh ${uri}`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.ws.send(JSON.stringify({ id, type: 'request', uri, payload }));
      });
    }

    subscribe(uri, callback, payload = {}) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
      const id = `sub_${++this.msgId}`;
      this.subscriptions.set(id, callback);
      this.ws.send(JSON.stringify({ id, type: 'subscribe', uri, payload }));
      return id;
    }

    async _connectPointerSocket() {
      const res = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
      if (!res || !res.socketPath) return;

      let sockUrl = res.socketPath;
      if (location.protocol === 'https:' && sockUrl.startsWith('ws://')) {
        sockUrl = sockUrl.replace(/^ws:\/\//, 'wss://');
      }

      return new Promise((resolve, reject) => {
        const pws = new WebSocket(sockUrl);
        pws.onopen = () => {
          this.pointerWs = pws;
          resolve();
        };
        pws.onerror = () => reject(new Error('Không mở được Pointer Socket'));
        pws.onclose = () => {
          if (this.pointerWs === pws) this.pointerWs = null;
        };
      });
    }

    async ensurePointerSocket() {
      if (this.pointerWs && this.pointerWs.readyState === WebSocket.OPEN) return true;
      try {
        await this._connectPointerSocket();
        return Boolean(this.pointerWs && this.pointerWs.readyState === WebSocket.OPEN);
      } catch {
        return false;
      }
    }

    async sendButton(buttonName) {
      const ok = await this.ensurePointerSocket();
      if (!ok) throw new Error('Không thể mở kết nối phím điều khiển (Pointer Socket)');
      this.pointerWs.send(`type:button\nname:${buttonName}\n\n`);
    }

    async movePointer(dx, dy, drag = 0) {
      const ok = await this.ensurePointerSocket();
      if (!ok) return;
      this.pointerWs.send(`type:move\ndx:${Math.round(dx)}\ndy:${Math.round(dy)}\ndown:${drag ? 1 : 0}\n\n`);
    }

    async clickPointer() {
      const ok = await this.ensurePointerSocket();
      if (!ok) return;
      this.pointerWs.send(`type:click\n\n`);
    }

    async scrollPointer(dx, dy) {
      const ok = await this.ensurePointerSocket();
      if (!ok) return;
      this.pointerWs.send(`type:scroll\ndx:${Math.round(dx)}\ndy:${Math.round(dy)}\n\n`);
    }

    getVolume() { return this.request('ssap://audio/getVolume'); }
    setVolume(volume) { return this.request('ssap://audio/setVolume', { volume: Math.max(0, Math.min(100, Number(volume))) }); }
    volumeUp() { return this.request('ssap://audio/volumeUp'); }
    volumeDown() { return this.request('ssap://audio/volumeDown'); }
    setMute(mute) { return this.request('ssap://audio/setMute', { mute: Boolean(mute) }); }
    channelUp() { return this.request('ssap://tv/channelUp'); }
    channelDown() { return this.request('ssap://tv/channelDown'); }
    turnOff() { return this.request('ssap://system/turnOff'); }
    mediaPlay() { return this.request('ssap://media.controls/play'); }
    mediaPause() { return this.request('ssap://media.controls/pause'); }
    mediaStop() { return this.request('ssap://media.controls/stop'); }
    mediaRewind() { return this.request('ssap://media.controls/rewind'); }
    mediaFastForward() { return this.request('ssap://media.controls/fastForward'); }
    listApps() { return this.request('ssap://com.webos.applicationManager/listLaunchPoints'); }
    launchApp(id, params = {}) { return this.request('ssap://system.launcher/launch', { id, params }); }
    getInputs() { return this.request('ssap://tv/getExternalInputList'); }
    switchInput(inputId) { return this.request('ssap://tv/switchInput', { inputId }); }
    insertText(text, replace = 0) { return this.request('ssap://com.webos.service.ime/insertText', { text: String(text), replace }); }
    deleteCharacters(count = 1) { return this.request('ssap://com.webos.service.ime/deleteCharacters', { count }); }
    sendEnterKey() { return this.request('ssap://com.webos.service.ime/sendEnterKey'); }
    createToast(message) { return this.request('ssap://system.notifications/createToast', { message: String(message) }); }
    openUrl(target) { return this.request('ssap://system.launcher/open', { target: String(target) }); }

    disconnect() {
      if (this.pointerWs) {
        try { this.pointerWs.close(); } catch {}
        this.pointerWs = null;
      }
      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
      this.connected = false;
      this.registered = false;
    }
  }

  // --- Virtual Demo TV (runs 100% in Browser) ---
  class BrowserVirtualWebOSTV {
    constructor() {
      this.ip = 'demo-tv';
      this.port = 3001;
      this.name = 'LG OLED C4 55" (Demo)';
      this.connected = false;
      this.volume = 28;
      this.muted = false;
      this.channel = 7;
      this._volCb = null;
    }
    async connect() {
      this.connected = true;
      return { ip: this.ip, port: this.port, clientKey: 'demo-key', name: this.name };
    }
    subscribe(uri, callback) {
      if (uri === 'ssap://audio/getVolume') {
        this._volCb = callback;
        callback({ volume: this.volume, muted: this.muted });
      }
      return 'demo_sub';
    }
    _emitVol() {
      if (this._volCb) this._volCb({ volume: this.volume, muted: this.muted });
    }
    async sendButton(buttonName) { return { ok: true, button: buttonName }; }
    async movePointer() { return { ok: true }; }
    async clickPointer() { return { ok: true }; }
    async scrollPointer() { return { ok: true }; }
    async getVolume() { return { volume: this.volume, muted: this.muted, returnValue: true }; }
    async setVolume(v) {
      this.volume = Math.max(0, Math.min(100, Number(v)));
      this.muted = false;
      this._emitVol();
      return { volume: this.volume, muted: this.muted, returnValue: true };
    }
    async volumeUp() { return this.setVolume(this.volume + 2); }
    async volumeDown() { return this.setVolume(this.volume - 2); }
    async setMute(m) {
      this.muted = Boolean(m);
      this._emitVol();
      return { volume: this.volume, muted: this.muted, returnValue: true };
    }
    async channelUp() { this.channel++; return { channel: this.channel, returnValue: true }; }
    async channelDown() { this.channel = Math.max(1, this.channel - 1); return { channel: this.channel, returnValue: true }; }
    async turnOff() { return { returnValue: true }; }
    async mediaPlay() { return { returnValue: true }; }
    async mediaPause() { return { returnValue: true }; }
    async mediaStop() { return { returnValue: true }; }
    async mediaRewind() { return { returnValue: true }; }
    async mediaFastForward() { return { returnValue: true }; }
    async listApps() {
      return {
        returnValue: true,
        launchPoints: [
          { id: 'youtube.leanback.v4', title: 'YouTube', iconColor: '#FF0000' },
          { id: 'netflix', title: 'Netflix', iconColor: '#E50914' },
          { id: 'com.fptplay.app', title: 'FPT Play', iconColor: '#FF6B00' },
          { id: 'com.vtvgo.app', title: 'VTV Go', iconColor: '#0055A5' },
          { id: 'spotify-beehive', title: 'Spotify', iconColor: '#1DB954' },
          { id: 'com.vieon.app', title: 'VieON', iconColor: '#00C853' },
          { id: 'com.webos.app.browser', title: 'Trình duyệt Web', iconColor: '#2563EB' },
          { id: 'com.apple.appletv', title: 'Apple TV', iconColor: '#1F2937' },
          { id: 'amazon', title: 'Prime Video', iconColor: '#00A8E1' },
          { id: 'com.webos.app.photovideo', title: 'Ảnh & Video', iconColor: '#7C3AED' },
          { id: 'com.webos.app.music', title: 'Âm nhạc', iconColor: '#DB2777' },
          { id: 'com.palm.app.settings', title: 'Cài đặt TV', iconColor: '#475569' }
        ]
      };
    }
    async launchApp(id) { return { returnValue: true, id }; }
    async getInputs() {
      return {
        returnValue: true,
        devices: [
          { id: 'HDMI_1', label: 'HDMI 1 (PS5)', connected: true },
          { id: 'HDMI_2', label: 'HDMI 2 (Soundbar eARC)', connected: true },
          { id: 'HDMI_3', label: 'HDMI 3', connected: false },
          { id: 'HDMI_4', label: 'HDMI 4 (PC)', connected: true }
        ]
      };
    }
    async switchInput(inputId) { return { returnValue: true, inputId }; }
    async insertText(text) { return { returnValue: true, text }; }
    async deleteCharacters(count) { return { returnValue: true, count }; }
    async sendEnterKey() { return { returnValue: true }; }
    async createToast(message) { return { returnValue: true, message }; }
    async openUrl(target) { return { returnValue: true, target }; }
    disconnect() { this.connected = false; }
  }

  // --- Unified Standalone Web Backend Controller ---
  class StandaloneWebBackend {
    constructor() {
      this.activeTV = null;
      this.activeTVInfo = null;
      this.tvState = {
        connected: false,
        demo: false,
        volume: 20,
        muted: false,
        apps: [],
        inputs: []
      };
      this.eventHandler = () => {};
    }

    setEventHandler(fn) {
      this.eventHandler = fn || (() => {});
    }

    emit(event, data = {}) {
      this.eventHandler({ event, data });
    }

    getStatus() {
      return {
        connected: this.tvState.connected,
        demo: this.tvState.demo,
        tv: this.activeTVInfo,
        volume: this.tvState.volume,
        muted: this.tvState.muted,
        apps: this.tvState.apps,
        inputs: this.tvState.inputs
      };
    }

    async refreshMetadata(tv) {
      try {
        const [vol, appsRes, inputsRes] = await Promise.allSettled([
          tv.getVolume(),
          tv.listApps(),
          tv.getInputs()
        ]);

        if (vol.status === 'fulfilled' && vol.value) {
          this.tvState.volume = Number(vol.value.volume ?? vol.value.volumeStatus?.volume ?? this.tvState.volume);
          this.tvState.muted = Boolean(vol.value.muted ?? vol.value.volumeStatus?.muteStatus ?? this.tvState.muted);
        }

        if (appsRes.status === 'fulfilled' && appsRes.value && Array.isArray(appsRes.value.launchPoints)) {
          this.tvState.apps = appsRes.value.launchPoints.map((a) => ({
            id: a.id,
            title: a.title || a.id,
            iconColor: a.iconColor || '#334155',
            largeIcon: a.largeIcon || ''
          }));
        }

        if (inputsRes.status === 'fulfilled' && inputsRes.value && Array.isArray(inputsRes.value.devices)) {
          this.tvState.inputs = inputsRes.value.devices.map((d) => ({
            id: d.id,
            label: d.label || d.id,
            connected: Boolean(d.connected)
          }));
        }
      } catch {}
    }

    async connect({ ip, port = 3001, name, model, demo = false }) {
      if (this.activeTV) {
        this.activeTV.disconnect();
        this.activeTV = null;
      }

      this.tvState = {
        connected: false,
        demo: Boolean(demo),
        volume: 20,
        muted: false,
        apps: [],
        inputs: []
      };

      if (demo || ip === 'demo-tv') {
        const virtual = new BrowserVirtualWebOSTV();
        await virtual.connect();
        this.activeTV = virtual;
        this.activeTVInfo = {
          id: 'demo-tv',
          ip: 'demo-tv',
          name: virtual.name,
          model: 'OLED55C4PSA (Demo)',
          demo: true
        };
        this.tvState.connected = true;
        this.tvState.demo = true;

        virtual.subscribe('ssap://audio/getVolume', (payload) => {
          this.tvState.volume = Number(payload.volume ?? this.tvState.volume);
          this.tvState.muted = Boolean(payload.muted ?? this.tvState.muted);
          this.emit('volume', { volume: this.tvState.volume, muted: this.tvState.muted });
        });

        await this.refreshMetadata(virtual);
        const status = this.getStatus();
        this.emit('status', status);
        return status;
      }

      const saved = browserStorage.getByIp(ip);
      const tv = new DirectWebOSTV({
        ip,
        port: port || (saved && saved.port) || 3001,
        clientKey: (saved && saved.clientKey) || '',
        name: name || (saved && saved.name) || `LG TV (${ip})`,
        onEvent: (ev) => {
          if (ev.event === 'disconnected') {
            this.tvState.connected = false;
            this.emit('status', this.getStatus());
            this.emit('toast', { message: 'Đã ngắt kết nối với TV LG', type: 'warn' });
          } else {
            this.emit(ev.event, ev.data);
          }
        }
      });

      const info = await tv.connect();
      this.activeTV = tv;
      this.activeTVInfo = browserStorage.upsert({
        ip: info.ip,
        port: info.port,
        name: info.name || name || `LG TV (${ip})`,
        model: model || (saved && saved.model) || 'LG webOS TV',
        clientKey: info.clientKey || (saved && saved.clientKey) || ''
      });

      this.tvState.connected = true;
      this.tvState.demo = false;

      tv.subscribe('ssap://audio/getVolume', (payload) => {
        const v = payload.volume ?? payload.volumeStatus?.volume;
        const m = payload.muted ?? payload.volumeStatus?.muteStatus;
        if (typeof v === 'number') this.tvState.volume = v;
        if (typeof m === 'boolean') this.tvState.muted = m;
        this.emit('volume', { volume: this.tvState.volume, muted: this.tvState.muted });
      });

      await this.refreshMetadata(tv);
      const status = this.getStatus();
      this.emit('status', status);
      return status;
    }

    disconnect() {
      if (this.activeTV) {
        this.activeTV.disconnect();
        this.activeTV = null;
      }
      this.activeTVInfo = null;
      this.tvState.connected = false;
      this.tvState.demo = false;
      const status = this.getStatus();
      this.emit('status', status);
      return status;
    }

    getRecentTVs() {
      return browserStorage.getAll();
    }

    deleteTV(id) {
      browserStorage.remove(id);
    }

    async detectLocalSubnet() {
      // 1. Check saved TVs first
      const saved = browserStorage.getAll();
      for (const tv of saved) {
        const m = String(tv.ip || '').match(/^(\d+\.\d+\.\d+)\.\d+$/);
        if (m) return m[1];
      }

      // 2. Try WebRTC local IPv4 candidate (works in browsers that allow local ICE)
      try {
        if (typeof RTCPeerConnection !== 'undefined') {
          const ip = await new Promise((resolve) => {
            let done = false;
            const pc = new RTCPeerConnection({ iceServers: [] });
            const finish = (val) => {
              if (done) return;
              done = true;
              try { pc.close(); } catch {}
              resolve(val);
            };
            const timer = setTimeout(() => finish(null), 1200);
            pc.createDataChannel('scan');
            pc.onicecandidate = (e) => {
              if (!e || !e.candidate || !e.candidate.candidate) return;
              const match = e.candidate.candidate.match(/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/);
              if (match) {
                clearTimeout(timer);
                finish(match[1]);
              }
            };
            pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish(null));
          });
          if (ip) {
            const m = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
            if (m) return m[1];
          }
        }
      } catch {}

      return '192.168.1';
    }

    _probeWs(url, timeoutMs) {
      return new Promise((resolve) => {
        const start = performance.now();
        let settled = false;
        let ws;
        try {
          ws = new WebSocket(url);
        } catch {
          return resolve({ status: 'blocked', elapsed: 0 });
        }
        const finish = (status) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({ status, elapsed: Math.round(performance.now() - start) });
        };
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        ws.onopen = () => finish('open');
        ws.onerror = () => finish('error');
      });
    }

    async _probeHost(ip) {
      const isHttps = location.protocol === 'https:';
      const url = isHttps ? `wss://${ip}:3001` : `ws://${ip}:3000`;
      const r1 = await this._probeWs(url, 900);

      if (r1.status === 'open') {
        return {
          ip,
          port: isHttps ? 3001 : 3000,
          name: `LG webOS TV (${ip})`,
          model: 'LG webOS · Sẵn sàng kết nối',
          trusted: true
        };
      }

      if (r1.status !== 'error') return null;

      // Secondary control probe on closed port 3099 to separate LG TV (open TLS 3001) from closed-port hosts
      const r2 = await this._probeWs(isHttps ? `wss://${ip}:3099` : `ws://${ip}:3099`, 550);
      const isLikelyLG =
        r2.status === 'timeout' ||
        (r2.status === 'error' && r1.elapsed >= 25 && r1.elapsed > r2.elapsed * 1.8);

      if (!isLikelyLG) return null;

      return {
        ip,
        port: isHttps ? 3001 : 3000,
        name: `LG webOS TV (${ip})`,
        model: isHttps ? 'Cổng 3001 mở · Cần tin cậy SSL' : 'Cổng 3000 mở',
        trusted: !isHttps
      };
    }

    async scanSubnet(subnetPrefix, onProgress) {
      const clean = String(subnetPrefix || '192.168.1').trim().replace(/\.$/, '');
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
        throw new Error('Dải mạng không hợp lệ (VD: 192.168.1)');
      }

      const found = [];
      const total = 254;
      const batchSize = 24;
      let scanned = 0;

      for (let start = 1; start <= total; start += batchSize) {
        const batch = [];
        for (let i = start; i < start + batchSize && i <= total; i++) {
          batch.push(this._probeHost(`${clean}.${i}`));
        }
        const results = await Promise.all(batch);
        for (const tv of results) {
          if (tv) found.push(tv);
        }
        scanned = Math.min(total, start + batchSize - 1);
        if (onProgress) onProgress({ scanned, total, found: [...found] });
      }

      // Sort trusted TVs first
      found.sort((a, b) => Number(b.trusted) - Number(a.trusted));
      return found;
    }

    async executeCommand(action, payload = {}) {
      if (!this.activeTV || !this.tvState.connected) {
        throw new Error('Chưa kết nối với TV LG. Hãy chọn TV hoặc bật Chế độ Demo.');
      }

      switch (action) {
        case 'button':
          await this.activeTV.sendButton(payload.name);
          break;
        case 'pointer_move':
          await this.activeTV.movePointer(payload.dx || 0, payload.dy || 0, payload.drag || 0);
          break;
        case 'pointer_click':
          await this.activeTV.clickPointer();
          break;
        case 'pointer_scroll':
          await this.activeTV.scrollPointer(payload.dx || 0, payload.dy || 0);
          break;
        case 'volume_up':
          await this.activeTV.volumeUp();
          break;
        case 'volume_down':
          await this.activeTV.volumeDown();
          break;
        case 'volume_set':
          await this.activeTV.setVolume(payload.volume);
          this.tvState.volume = Number(payload.volume);
          this.emit('volume', { volume: this.tvState.volume, muted: this.tvState.muted });
          break;
        case 'mute_toggle':
          this.tvState.muted = !this.tvState.muted;
          await this.activeTV.setMute(this.tvState.muted);
          this.emit('volume', { volume: this.tvState.volume, muted: this.tvState.muted });
          break;
        case 'channel_up':
          await this.activeTV.channelUp();
          break;
        case 'channel_down':
          await this.activeTV.channelDown();
          break;
        case 'power_off':
          await this.activeTV.turnOff();
          if (this.tvState.demo) {
            this.emit('toast', { message: 'TV Demo đã nhận lệnh tắt nguồn', type: 'info' });
          }
          break;
        case 'media_play':
          await this.activeTV.mediaPlay();
          break;
        case 'media_pause':
          await this.activeTV.mediaPause();
          break;
        case 'media_stop':
          await this.activeTV.mediaStop();
          break;
        case 'media_rewind':
          await this.activeTV.mediaRewind();
          break;
        case 'media_ff':
          await this.activeTV.mediaFastForward();
          break;
        case 'launch_app':
          await this.activeTV.launchApp(payload.id, payload.params || {});
          break;
        case 'switch_input':
          await this.activeTV.switchInput(payload.inputId);
          break;
        case 'text_insert':
          await this.activeTV.insertText(payload.text || '');
          break;
        case 'text_delete':
          await this.activeTV.deleteCharacters(payload.count || 1);
          break;
        case 'text_enter':
          await this.activeTV.sendEnterKey();
          break;
        case 'toast':
          await this.activeTV.createToast(payload.message || '');
          break;
        case 'open_url':
          await this.activeTV.openUrl(payload.url || '');
          break;
        case 'refresh_meta':
          await this.refreshMetadata(this.activeTV);
          this.emit('status', this.getStatus());
          break;
        default:
          throw new Error(`Lệnh không hỗ trợ: ${action}`);
      }
      return { ok: true };
    }
  }

  window.DirectWebOSBackend = new StandaloneWebBackend();
})();
