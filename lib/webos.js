const EventEmitter = require('events');
const WebSocket = require('ws');

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
        '': 'LG Remote App',
        'vi-VN': 'Điều khiển TV LG',
        'en-US': 'LG webOS Remote'
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

class WebOSTV extends EventEmitter {
  constructor({ ip, port = 3001, clientKey = '', name = '' }) {
    super();
    this.ip = ip;
    this.port = port;
    this.clientKey = clientKey || '';
    this.name = name || `LG TV (${ip})`;
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

    // Try wss://ip:3001 first (webOS 6+/22/23/24), then fallback to ws://ip:3000
    const endpoints =
      this.port === 3000
        ? [`ws://${this.ip}:3000`, `wss://${this.ip}:3001`]
        : [`wss://${this.ip}:3001`, `ws://${this.ip}:3000`];

    let lastError = null;
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
        lastError = err;
        this.disconnect();
      }
    }

    throw lastError || new Error(`Không thể kết nối tới TV tại ${this.ip}`);
  }

  _openSocket(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        rejectUnauthorized: false,
        handshakeTimeout: 5000
      });

      const timer = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error(`Timeout kết nối ${url}`));
      }, 5500);

      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.connected = true;
        this._attachSocketHandlers(ws);
        resolve();
      });

      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  _attachSocketHandlers(ws) {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
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
        this.emit('registered', { clientKey: this.clientKey });
        return;
      }

      if (msg.type === 'response') {
        if (msg.payload && msg.payload.pairingType === 'PROMPT') {
          this.emit('prompt', {
            message: 'Hãy bấm "Chấp nhận" (Accept) trên màn hình TV LG của bạn!'
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
        if (sub) {
          sub(msg.payload || {});
        }
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
    });

    ws.on('close', () => {
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
        this.emit('disconnected');
      }
    });
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

    return new Promise((resolve, reject) => {
      const pws = new WebSocket(res.socketPath, { rejectUnauthorized: false });
      pws.once('open', () => {
        this.pointerWs = pws;
        resolve();
      });
      pws.once('error', reject);
      pws.on('close', () => {
        if (this.pointerWs === pws) this.pointerWs = null;
      });
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

  // Standard SSAP Commands
  getVolume() {
    return this.request('ssap://audio/getVolume');
  }
  setVolume(volume) {
    return this.request('ssap://audio/setVolume', { volume: Math.max(0, Math.min(100, Number(volume))) });
  }
  volumeUp() {
    return this.request('ssap://audio/volumeUp');
  }
  volumeDown() {
    return this.request('ssap://audio/volumeDown');
  }
  setMute(mute) {
    return this.request('ssap://audio/setMute', { mute: Boolean(mute) });
  }
  channelUp() {
    return this.request('ssap://tv/channelUp');
  }
  channelDown() {
    return this.request('ssap://tv/channelDown');
  }
  turnOff() {
    return this.request('ssap://system/turnOff');
  }
  mediaPlay() {
    return this.request('ssap://media.controls/play');
  }
  mediaPause() {
    return this.request('ssap://media.controls/pause');
  }
  mediaStop() {
    return this.request('ssap://media.controls/stop');
  }
  mediaRewind() {
    return this.request('ssap://media.controls/rewind');
  }
  mediaFastForward() {
    return this.request('ssap://media.controls/fastForward');
  }
  listApps() {
    return this.request('ssap://com.webos.applicationManager/listLaunchPoints');
  }
  launchApp(id, params = {}) {
    return this.request('ssap://system.launcher/launch', { id, params });
  }
  getInputs() {
    return this.request('ssap://tv/getExternalInputList');
  }
  switchInput(inputId) {
    return this.request('ssap://tv/switchInput', { inputId });
  }
  insertText(text, replace = 0) {
    return this.request('ssap://com.webos.service.ime/insertText', { text: String(text), replace });
  }
  deleteCharacters(count = 1) {
    return this.request('ssap://com.webos.service.ime/deleteCharacters', { count });
  }
  sendEnterKey() {
    return this.request('ssap://com.webos.service.ime/sendEnterKey');
  }
  createToast(message) {
    return this.request('ssap://system.notifications/createToast', { message: String(message) });
  }
  openUrl(target) {
    return this.request('ssap://system.launcher/open', { target: String(target) });
  }

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

/**
 * Virtual LG webOS TV Simulator for instant Demo / UI Testing
 */
class VirtualWebOSTV extends EventEmitter {
  constructor() {
    super();
    this.ip = 'demo-tv';
    this.port = 3001;
    this.name = 'LG OLED C4 55" (Demo)';
    this.connected = false;
    this.registered = false;
    this.volume = 28;
    this.muted = false;
    this.channel = 7;
    this.currentApp = 'youtube.leanback.v4';
  }

  async connect() {
    this.connected = true;
    this.registered = true;
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

  async sendButton(buttonName) {
    return { ok: true, demo: true, button: buttonName };
  }
  async movePointer(dx, dy) {
    return { ok: true, dx, dy };
  }
  async clickPointer() {
    return { ok: true };
  }
  async scrollPointer(dx, dy) {
    return { ok: true, dx, dy };
  }
  async getVolume() {
    return { volume: this.volume, muted: this.muted, returnValue: true };
  }
  async setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Number(v)));
    this.muted = false;
    this._emitVol();
    return { volume: this.volume, muted: this.muted, returnValue: true };
  }
  async volumeUp() {
    return this.setVolume(this.volume + 2);
  }
  async volumeDown() {
    return this.setVolume(this.volume - 2);
  }
  async setMute(m) {
    this.muted = Boolean(m);
    this._emitVol();
    return { volume: this.volume, muted: this.muted, returnValue: true };
  }
  async channelUp() {
    this.channel++;
    return { channel: this.channel, returnValue: true };
  }
  async channelDown() {
    this.channel = Math.max(1, this.channel - 1);
    return { channel: this.channel, returnValue: true };
  }
  async turnOff() {
    return { returnValue: true, demoMessage: 'TV Demo đã nhận lệnh tắt nguồn' };
  }
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
  async launchApp(id) {
    this.currentApp = id;
    return { returnValue: true, id };
  }
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
  async switchInput(inputId) {
    return { returnValue: true, inputId };
  }
  async insertText(text) {
    return { returnValue: true, text };
  }
  async deleteCharacters(count) {
    return { returnValue: true, count };
  }
  async sendEnterKey() {
    return { returnValue: true };
  }
  async createToast(message) {
    return { returnValue: true, message };
  }
  async openUrl(target) {
    return { returnValue: true, target };
  }
  disconnect() {
    this.connected = false;
    this.registered = false;
  }
}

module.exports = {
  WebOSTV,
  VirtualWebOSTV
};
