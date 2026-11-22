(() => {
  'use strict';

  // State
  const isNative = typeof window.NativeLGRemote !== 'undefined';
  let isStandalone = false;
  const directBackend = window.DirectWebOSBackend || null;
  let ws = null;
  let reqCounter = 0;
  const pendingReqs = new Map();
  const nativeCalls = new Map();

  window.__onNativeResponse = (raw) => {
    try {
      const msg = JSON.parse(raw);
      const cb = nativeCalls.get(msg.callId);
      if (cb) {
        nativeCalls.delete(msg.callId);
        cb(msg);
      }
    } catch {}
  };

  window.__onNativeEvent = (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleServerEvent(msg);
    } catch {}
  };

  function callNative(method, args = {}) {
    return new Promise((resolve) => {
      const callId = `n_${++reqCounter}`;
      nativeCalls.set(callId, resolve);
      window.NativeLGRemote.call(callId, method, JSON.stringify(args));
    });
  }
  let state = {
    connected: false,
    demo: false,
    tv: null,
    volume: 20,
    muted: false,
    apps: [],
    inputs: []
  };
  let recentTVs = [];
  let discoveredTVs = [];
  let networkInfo = null;
  let volumeDragging = false;

  // Helpers
  const $ = (id) => document.getElementById(id);

  function haptic(ms = 14) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch {}
  }

  function showToast(message, type = 'info') {
    const container = $('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s';
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  function formatRelativeTime(ts) {
    if (!ts) return 'Chưa rõ';
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 60) return 'Vừa xong';
    if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
    return `${Math.floor(diff / 86400)} ngày trước`;
  }

  function handleServerEvent(msg) {
    if (msg.event === 'status') {
      applyStatus(msg.data);
    } else if (msg.event === 'volume') {
      state.volume = Number(msg.data.volume ?? state.volume);
      state.muted = Boolean(msg.data.muted ?? state.muted);
      renderVolume();
    } else if (msg.event === 'pairing_prompt') {
      $('pairingText').textContent =
        msg.data.message || 'Hãy bấm "Chấp nhận" (Accept) trên màn hình TV LG!';
      $('pairingModal').classList.remove('hidden');
    } else if (msg.event === 'toast') {
      showToast(msg.data.message, msg.data.type || 'info');
    } else if (msg.event === 'reply' && msg.reqId) {
      const cb = pendingReqs.get(msg.reqId);
      if (cb) {
        pendingReqs.delete(msg.reqId);
        cb(msg);
      }
    }
  }

  // WebSocket Bridge (or Native Android / Standalone Web init)
  function connectWS() {
    if (isNative) {
      callNative('status').then((res) => {
        if (res.ok && res.data) applyStatus(res.data);
      });
      return;
    }

    if (isStandalone && directBackend) {
      directBackend.setEventHandler(handleServerEvent);
      applyStatus(directBackend.getStatus());
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {};

    ws.onmessage = (ev) => {
      try {
        handleServerEvent(JSON.parse(ev.data));
      } catch {}
    };

    ws.onclose = () => {
      if (!isStandalone) {
        setTimeout(connectWS, 1500);
      }
    };
  }

  function sendCommand(action, payload = {}, silent = false) {
    if (isNative) {
      return callNative('command', { action, payload }).then((res) => {
        if (!res.ok && res.error && !silent) {
          showToast(res.error, 'err');
        }
        return res;
      });
    }

    if (isStandalone && directBackend) {
      return directBackend
        .executeCommand(action, payload)
        .then(() => ({ ok: true }))
        .catch((err) => {
          if (!silent) showToast(err.message || 'Lỗi gửi lệnh tới TV', 'err');
          return { ok: false, error: err.message };
        });
    }

    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (!silent) showToast('Đang kết nối lại server...', 'warn');
        return resolve({ ok: false });
      }
      const reqId = `c_${++reqCounter}`;
      pendingReqs.set(reqId, (res) => {
        if (!res.ok && res.error && !silent) {
          showToast(res.error, 'err');
        }
        resolve(res);
      });
      ws.send(JSON.stringify({ action, payload, reqId }));
    });
  }

  // Render Status
  function applyStatus(data) {
    state = { ...state, ...data };
    $('pairingModal').classList.add('hidden');

    const dot = $('statusDot');
    const nameEl = $('activeTvName');
    const subEl = $('activeTvSub');

    if (state.connected && state.tv) {
      dot.className = `status-dot ${state.demo ? 'demo' : 'online'}`;
      nameEl.textContent = state.tv.name || state.tv.ip;
      subEl.textContent = state.demo
        ? 'Đang chạy Chế độ Demo (TV ảo)'
        : `${state.tv.ip} · Đã kết nối`;
      $('btnDemoMode').textContent = state.demo ? 'Tắt Demo' : 'Bật Demo';
    } else {
      dot.className = 'status-dot offline';
      nameEl.textContent = 'Chưa kết nối TV';
      subEl.textContent = 'Chạm để quét Wi-Fi / chọn TV gần đây';
      $('btnDemoMode').textContent = 'Bật Demo';
    }

    renderVolume();
    renderInputs();
    renderApps();
    renderRecentTVs();
    renderDiscoveredTVs();
  }

  function renderVolume() {
    if (!volumeDragging) {
      $('volumeSlider').value = state.volume;
    }
    $('volumeValue').textContent = state.muted ? 'Tắt' : state.volume;
    $('btnMute').classList.toggle('muted', state.muted);
  }

  function renderInputs() {
    const strip = $('inputsList');
    if (!state.connected || !state.inputs || state.inputs.length === 0) {
      strip.innerHTML = '<div class="empty-chip">Kết nối TV để tải cổng HDMI / Input</div>';
      return;
    }
    strip.innerHTML = '';
    for (const inp of state.inputs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `input-chip ${inp.connected ? 'connected' : ''}`;
      btn.textContent = inp.label;
      btn.onclick = async () => {
        haptic();
        const res = await sendCommand('switch_input', { inputId: inp.id });
        if (res.ok) showToast(`Đã chuyển sang ${inp.label}`, 'ok');
      };
      strip.appendChild(btn);
    }
  }

  function renderApps() {
    const grid = $('appsGrid');
    const q = ($('appSearchInput').value || '').trim().toLowerCase();

    if (!state.connected || !state.apps || state.apps.length === 0) {
      grid.innerHTML =
        '<div class="empty-state">Kết nối TV (hoặc bật Chế độ Demo ở tab Quét TV) để mở ứng dụng</div>';
      return;
    }

    const filtered = state.apps.filter(
      (a) => a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
    );

    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty-state">Không tìm thấy ứng dụng phù hợp</div>';
      return;
    }

    grid.innerHTML = '';
    for (const app of filtered) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'app-tile';
      const initial = (app.title || '?').trim().slice(0, 2).toUpperCase();
      const color = app.iconColor || '#334155';
      tile.innerHTML = `
        <div class="app-badge" style="background:${color}">${escapeHtml(initial)}</div>
        <span class="app-title">${escapeHtml(app.title)}</span>
      `;
      tile.onclick = async () => {
        haptic();
        const res = await sendCommand('launch_app', { id: app.id });
        if (res.ok) showToast(`Đang mở ${app.title}...`, 'ok');
      };
      grid.appendChild(tile);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Tab Navigation
  function switchTab(tabName) {
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tabName}`);
    });
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.tab === tabName);
    });
    if (tabName === 'tvs') {
      loadRecentTVs(false);
    }
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      haptic(8);
      switchTab(btn.dataset.tab);
    });
  });

  document.querySelectorAll('[data-tab-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      haptic(8);
      switchTab(btn.dataset.tabJump);
    });
  });

  $('btnTvPill').addEventListener('click', () => {
    haptic(8);
    switchTab('tvs');
  });

  // Remote Button Handlers
  document.querySelectorAll('[data-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      haptic(14);
      sendCommand('button', { name: btn.dataset.btn });
    });
  });

  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      haptic(14);
      sendCommand(btn.dataset.action);
    });
  });

  document.querySelectorAll('[data-launch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      haptic(16);
      const res = await sendCommand('launch_app', { id: btn.dataset.launch });
      if (res.ok) showToast(`Đang mở ${btn.textContent.trim()}...`, 'ok');
    });
  });

  // Volume Slider & Mute
  let volTimer = null;
  $('volumeSlider').addEventListener('pointerdown', () => { volumeDragging = true; });
  $('volumeSlider').addEventListener('pointerup', () => { volumeDragging = false; });
  $('volumeSlider').addEventListener('input', (e) => {
    const val = Number(e.target.value);
    $('volumeValue').textContent = val;
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      sendCommand('volume_set', { volume: val });
    }, 60);
  });

  $('btnMute').addEventListener('click', () => {
    haptic();
    sendCommand('mute_toggle');
  });

  // Power Button
  $('btnPower').addEventListener('click', async () => {
    haptic(25);
    if (state.connected) {
      const res = await sendCommand('power_off');
      if (res.ok) showToast('Đã gửi lệnh tắt TV', 'ok');
      return;
    }
    // If not connected, try Wake-on-LAN on most recent TV with MAC
    const candidate = recentTVs.find((t) => t.mac);
    if (candidate) {
      await wakeTV(candidate);
    } else {
      showToast('Hãy kết nối TV hoặc lưu TV có địa chỉ MAC để bật từ xa', 'warn');
      switchTab('tvs');
    }
  });

  // Numpad Toggle
  $('btnToggleNumpad').addEventListener('click', () => {
    haptic(10);
    const drawer = $('numpadDrawer');
    const isHidden = drawer.classList.toggle('hidden');
    $('btnToggleNumpad').classList.toggle('active', !isHidden);
  });

  // Keyboard Modal
  $('btnOpenKeyboard').addEventListener('click', () => {
    haptic(10);
    $('keyboardModal').classList.remove('hidden');
    setTimeout(() => $('tvTextInput').focus(), 80);
  });
  $('btnCloseKeyboard').addEventListener('click', () => {
    $('keyboardModal').classList.add('hidden');
  });
  $('keyboardModal').addEventListener('click', (e) => {
    if (e.target === $('keyboardModal')) $('keyboardModal').classList.add('hidden');
  });
  $('btnTvSendText').addEventListener('click', async () => {
    const text = $('tvTextInput').value;
    if (!text) return;
    haptic();
    const res = await sendCommand('text_insert', { text });
    if (res.ok) {
      $('tvTextInput').value = '';
      showToast('Đã gửi chữ lên TV', 'ok');
    }
  });
  $('tvTextInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('btnTvSendText').click();
    }
  });
  $('btnTvBackspace').addEventListener('click', () => {
    haptic();
    sendCommand('text_delete', { count: 1 });
  });
  $('btnTvSendEnter').addEventListener('click', () => {
    haptic();
    sendCommand('text_enter');
  });

  // Apps tab utilities
  $('appSearchInput').addEventListener('input', renderApps);
  $('btnRefreshApps').addEventListener('click', () => {
    haptic();
    sendCommand('refresh_meta');
    showToast('Đang tải lại danh sách ứng dụng...', 'info');
  });
  $('btnSendToast').addEventListener('click', async () => {
    const msg = $('toastMsgInput').value.trim();
    if (!msg) return;
    haptic();
    const res = await sendCommand('toast', { message: msg });
    if (res.ok) {
      $('toastMsgInput').value = '';
      showToast('Đã gửi thông báo lên màn hình TV!', 'ok');
    }
  });
  $('btnOpenUrl').addEventListener('click', async () => {
    let url = $('openUrlInput').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    haptic();
    const res = await sendCommand('open_url', { url });
    if (res.ok) showToast('Đang mở trang web trên TV...', 'ok');
  });

  // Magic Touchpad (Air Mouse)
  (function setupTouchpad() {
    const surface = $('touchpadArea');
    const cursor = $('touchRipple');
    const scrollRail = $('scrollRail');

    let active = false;
    let lastX = 0;
    let lastY = 0;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let accumDx = 0;
    let accumDy = 0;
    let rafPending = false;
    let twoFingerY = null;

    function flushMove() {
      rafPending = false;
      if (Math.abs(accumDx) >= 1 || Math.abs(accumDy) >= 1) {
        sendCommand('pointer_move', { dx: accumDx, dy: accumDy }, true);
        accumDx = 0;
        accumDy = 0;
      }
    }

    function updateCursor(clientX, clientY, show) {
      const rect = surface.getBoundingClientRect();
      cursor.style.left = `${clientX - rect.left}px`;
      cursor.style.top = `${clientY - rect.top}px`;
      cursor.classList.toggle('active', show);
    }

    surface.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        twoFingerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        active = false;
        return;
      }
      const t = e.touches[0];
      active = true;
      lastX = startX = t.clientX;
      lastY = startY = t.clientY;
      startTime = Date.now();
      updateCursor(t.clientX, t.clientY, true);
    }, { passive: false });

    surface.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 2 && twoFingerY !== null) {
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const dy = (midY - twoFingerY) * 2.2;
        twoFingerY = midY;
        if (Math.abs(dy) >= 2) {
          sendCommand('pointer_scroll', { dx: 0, dy: Math.round(dy) }, true);
        }
        return;
      }
      if (!active || e.touches.length !== 1) return;
      const t = e.touches[0];
      const sens = Number($('sensitivitySlider').value) || 1.8;
      accumDx += (t.clientX - lastX) * sens;
      accumDy += (t.clientY - lastY) * sens;
      lastX = t.clientX;
      lastY = t.clientY;
      updateCursor(t.clientX, t.clientY, true);
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushMove);
      }
    }, { passive: false });

    surface.addEventListener('touchend', (e) => {
      e.preventDefault();
      twoFingerY = null;
      cursor.classList.remove('active');
      if (!active) return;
      active = false;
      const dist = Math.hypot(lastX - startX, lastY - startY);
      const elapsed = Date.now() - startTime;
      if (dist < 10 && elapsed < 260) {
        haptic(12);
        sendCommand('pointer_click', {}, true);
      }
    }, { passive: false });

    // Desktop Mouse Support for Touchpad
    surface.addEventListener('mousedown', (e) => {
      active = true;
      lastX = startX = e.clientX;
      lastY = startY = e.clientY;
      startTime = Date.now();
      updateCursor(e.clientX, e.clientY, true);
    });
    window.addEventListener('mousemove', (e) => {
      if (!active) return;
      const sens = Number($('sensitivitySlider').value) || 1.8;
      accumDx += (e.clientX - lastX) * sens;
      accumDy += (e.clientY - lastY) * sens;
      lastX = e.clientX;
      lastY = e.clientY;
      updateCursor(e.clientX, e.clientY, true);
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushMove);
      }
    });
    window.addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      cursor.classList.remove('active');
      const dist = Math.hypot(lastX - startX, lastY - startY);
      const elapsed = Date.now() - startTime;
      if (dist < 6 && elapsed < 250) {
        sendCommand('pointer_click', {}, true);
      }
    });

    // Dedicated Scroll Rail
    let railY = null;
    scrollRail.addEventListener('touchstart', (e) => {
      e.preventDefault();
      railY = e.touches[0].clientY;
    }, { passive: false });
    scrollRail.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (railY === null) return;
      const y = e.touches[0].clientY;
      const dy = (railY - y) * 2.5;
      railY = y;
      if (Math.abs(dy) >= 2) {
        sendCommand('pointer_scroll', { dx: 0, dy: Math.round(dy) }, true);
      }
    }, { passive: false });
    scrollRail.addEventListener('touchend', () => { railY = null; });

    $('btnTouchClick').addEventListener('click', () => {
      haptic(16);
      sendCommand('pointer_click');
    });
  })();

  // TV Discovery & Recent TVs
  async function loadRecentTVs(checkOnline = false) {
    try {
      let data;
      if (isNative) {
        const r = await callNative('getTvs', { check: checkOnline });
        data = r.data || {};
      } else if (isStandalone && directBackend) {
        data = { tvs: directBackend.getRecentTVs() };
      } else {
        const res = await fetch(`/api/tvs${checkOnline ? '?check=1' : ''}`);
        data = await res.json();
      }
      recentTVs = Array.isArray(data.tvs) ? data.tvs : [];
      renderRecentTVs();
    } catch {
      // ignore
    }
  }

  function renderRecentTVs() {
    const list = $('recentTvList');
    if (!recentTVs || recentTVs.length === 0) {
      list.innerHTML = '<div class="empty-state">Chưa có TV gần đây. Hãy quét Wi-Fi hoặc nhập IP.</div>';
      return;
    }

    list.innerHTML = '';
    for (const tv of recentTVs) {
      const isCurrent = state.connected && state.tv && state.tv.ip === tv.ip;
      const el = document.createElement('div');
      el.className = `tv-item ${isCurrent ? 'is-active' : ''}`;
      const statusBadge = isCurrent
        ? '<span class="badge online">Đang kết nối</span>'
        : tv.online === true
          ? '<span class="badge online">Online</span>'
          : tv.online === false
            ? '<span class="badge offline">Đang tắt</span>'
            : '<span class="badge offline">Gần đây</span>';

      el.innerHTML = `
        <div class="tv-item-head">
          <div class="tv-item-info">
            <div class="tv-item-name">${escapeHtml(tv.name)}</div>
            <div class="tv-item-meta">${escapeHtml(tv.ip)} · ${formatRelativeTime(tv.lastConnected)}${tv.mac ? ` · ${escapeHtml(tv.mac)}` : ''}</div>
          </div>
          ${statusBadge}
        </div>
        <div class="tv-item-actions">
          <button class="btn-primary btn-sm" data-connect-ip="${escapeHtml(tv.ip)}" type="button">
            ${isCurrent ? 'Đã kết nối' : 'Kết nối'}
          </button>
          ${tv.mac ? `<button class="btn-secondary btn-sm" data-wol-ip="${escapeHtml(tv.ip)}" type="button">Bật TV</button>` : ''}
          <button class="btn-danger-sm" data-del-id="${escapeHtml(tv.id || tv.ip)}" type="button" title="Xóa">✕</button>
        </div>
      `;

      el.querySelector('[data-connect-ip]').onclick = () => connectTV(tv);
      const wolBtn = el.querySelector('[data-wol-ip]');
      if (wolBtn) wolBtn.onclick = () => wakeTV(tv);
      el.querySelector('[data-del-id]').onclick = () => deleteSavedTV(tv.id || tv.ip);

      list.appendChild(el);
    }
  }

  function renderDiscoveredTVs() {
    const list = $('discoveredList');
    if (!discoveredTVs || discoveredTVs.length === 0) {
      return;
    }
    list.innerHTML = '';
    for (const tv of discoveredTVs) {
      const isCurrent = state.connected && state.tv && state.tv.ip === tv.ip;
      const needsTrust = isStandalone && location.protocol === 'https:' && tv.trusted === false;
      const el = document.createElement('div');
      el.className = `tv-item ${isCurrent ? 'is-active' : ''}`;
      el.innerHTML = `
        <div class="tv-item-head">
          <div class="tv-item-info">
            <div class="tv-item-name">${escapeHtml(tv.name)}</div>
            <div class="tv-item-meta">${escapeHtml(tv.ip)} · ${escapeHtml(tv.model || 'LG webOS')} ${tv.mac ? `· ${escapeHtml(tv.mac)}` : ''}</div>
          </div>
          <span class="badge ${tv.trusted ? 'online' : 'wifi'}">${tv.trusted ? 'Sẵn sàng' : 'Wi-Fi'}</span>
        </div>
        <div class="tv-item-actions">
          ${needsTrust ? `<button class="btn-secondary btn-sm" data-trust-ip="${escapeHtml(tv.ip)}" type="button">🔒 Tin cậy</button>` : ''}
          <button class="btn-primary btn-sm" data-disc-connect="1" type="button">
            ${isCurrent ? 'Đang kết nối' : 'Kết nối ngay'}
          </button>
        </div>
      `;
      const trustBtn = el.querySelector('[data-trust-ip]');
      if (trustBtn) {
        trustBtn.onclick = () => {
          haptic();
          window.open(`https://${tv.ip}:3001`, '_blank', 'noopener');
          showToast('Bấm "Nâng cao → Tiếp tục" ở tab vừa mở, sau đó quay lại bấm Kết nối ngay!', 'info');
        };
      }
      el.querySelector('[data-disc-connect]').onclick = () => connectTV(tv);
      list.appendChild(el);
    }
  }

  async function scanWifiTVs() {
    const btn = $('btnScanWifi');
    const spinner = $('scanSpinner');
    const text = $('scanBtnText');

    btn.disabled = true;
    spinner.classList.remove('hidden');
    text.textContent = 'Đang quét...';

    if (isStandalone && directBackend) {
      const subnet = ($('subnetPrefixInput')?.value || '192.168.1').trim();
      const progWrap = $('webScanProgressWrap');
      const progFill = $('webScanProgressFill');
      const progText = $('webScanProgressText');
      progWrap?.classList.remove('hidden');
      if (progFill) progFill.style.width = '2%';
      if (progText) progText.textContent = `0% (${subnet}.1–254)`;
      $('discoveredList').innerHTML =
        `<div class="empty-state">Đang quét dải Wi-Fi ${escapeHtml(subnet)}.1 → .254 (cổng LG 3001)...</div>`;

      try {
        discoveredTVs = [];
        const found = await directBackend.scanSubnet(subnet, ({ scanned, total, found: partial }) => {
          const pct = Math.round((scanned / total) * 100);
          if (progFill) progFill.style.width = `${pct}%`;
          if (progText) progText.textContent = `${pct}% (${scanned}/${total})`;
          if (partial.length > discoveredTVs.length) {
            discoveredTVs = partial;
            renderDiscoveredTVs();
          }
        });
        discoveredTVs = found;
        if (discoveredTVs.length === 0) {
          $('discoveredList').innerHTML =
            `<div class="empty-state">Không tìm thấy TV LG trên dải <strong>${escapeHtml(subnet)}.x</strong>. Hãy thử chọn dải mạng khác (VD: 192.168.0.x), đảm bảo điện thoại & TV cùng Wi-Fi, bật "LG Connect Apps" trên TV, hoặc nhập IP thủ công bên dưới.</div>`;
        } else {
          renderDiscoveredTVs();
          showToast(`Tìm thấy ${discoveredTVs.length} thiết bị LG trên Wi-Fi!`, 'ok');
        }
      } catch (err) {
        showToast('Lỗi quét Wi-Fi: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
        spinner.classList.add('hidden');
        text.textContent = 'Quét lại';
      }
      return;
    }

    $('discoveredList').innerHTML =
      '<div class="empty-state">Đang quét SSDP & toàn bộ dải Wi-Fi (cổng 3000/3001)...</div>';

    try {
      let data;
      if (isNative) {
        const r = await callNative('scan');
        if (!r.ok) throw new Error(r.error || 'Lỗi quét Wi-Fi');
        data = r.data || {};
      } else {
        const res = await fetch('/api/scan', { method: 'POST' });
        data = await res.json();
      }
      discoveredTVs = Array.isArray(data.discovered) ? data.discovered : [];
      if (Array.isArray(data.recent)) {
        recentTVs = data.recent;
        renderRecentTVs();
      }
      if (discoveredTVs.length === 0) {
        $('discoveredList').innerHTML =
          '<div class="empty-state">Không tìm thấy TV LG nào đang bật trên mạng Wi-Fi này. Hãy chắc chắn TV đang bật & bật tính năng "LG Connect Apps" trong Cài đặt mạng TV.</div>';
      } else {
        renderDiscoveredTVs();
        showToast(`Tìm thấy ${discoveredTVs.length} TV LG trên Wi-Fi!`, 'ok');
      }
    } catch (err) {
      showToast('Lỗi quét mạng Wi-Fi: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      spinner.classList.add('hidden');
      text.textContent = 'Quét lại';
    }
  }

  async function connectTV(tv) {
    haptic(18);
    showToast(`Đang kết nối tới ${tv.name || tv.ip}...`, 'info');
    try {
      let statusObj;
      if (isNative) {
        const r = await callNative('connect', tv);
        $('pairingModal').classList.add('hidden');
        if (!r.ok) throw new Error(r.error || 'Không thể kết nối TV');
        statusObj = r.data.status;
      } else if (isStandalone && directBackend) {
        statusObj = await directBackend.connect(tv);
        $('pairingModal').classList.add('hidden');
      } else {
        const res = await fetch('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tv)
        });
        const data = await res.json();
        $('pairingModal').classList.add('hidden');
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Không thể kết nối TV');
        }
        statusObj = data.status;
      }
      applyStatus(statusObj);
      loadRecentTVs(false);
      showToast(`Đã kết nối ${statusObj.tv.name}!`, 'ok');
      switchTab('remote');
    } catch (err) {
      $('pairingModal').classList.add('hidden');
      showToast(err.message, 'err');
    }
  }

  async function wakeTV(tv) {
    haptic(18);
    if (isStandalone) {
      showToast('Trình duyệt không hỗ trợ gửi gói UDP Wake-on-LAN. Hãy bật TV bằng remote hoặc dùng app Android / Node server.', 'warn');
      return;
    }
    try {
      if (isNative) {
        const r = await callNative('wol', { mac: tv.mac, ip: tv.ip });
        if (!r.ok) throw new Error(r.error || 'Không gửi được lệnh Wake-on-LAN');
      } else {
        const res = await fetch('/api/wol', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mac: tv.mac, ip: tv.ip })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Không gửi được lệnh Wake-on-LAN');
      }
      showToast(`Đã gửi tín hiệu bật TV (${tv.name || tv.ip})!`, 'ok');
    } catch (err) {
      showToast(err.message, 'err');
    }
  }

  async function deleteSavedTV(id) {
    haptic();
    if (isNative) {
      await callNative('deleteTv', { id });
    } else if (isStandalone && directBackend) {
      directBackend.deleteTV(id);
    } else {
      await fetch(`/api/tvs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
    loadRecentTVs(false);
    showToast('Đã xóa khỏi danh sách TV gần đây', 'info');
  }

  $('btnScanWifi').addEventListener('click', () => {
    haptic();
    scanWifiTVs();
  });

  $('btnCheckRecent').addEventListener('click', () => {
    haptic();
    loadRecentTVs(true);
    showToast('Đang kiểm tra trạng thái TV gần đây...', 'info');
  });

  $('btnConnectManual').addEventListener('click', () => {
    const ip = $('manualIpInput').value.trim();
    if (!ip) return showToast('Vui lòng nhập địa chỉ IP của TV', 'warn');
    connectTV({ ip, name: `LG webOS TV (${ip})` });
  });

  const btnTrustCert = $('btnTrustCert');
  if (btnTrustCert) {
    btnTrustCert.addEventListener('click', () => {
      const ip = $('manualIpInput').value.trim();
      if (!ip) {
        showToast('Hãy nhập địa chỉ IP của TV LG trước (VD: 192.168.1.50)', 'warn');
        $('manualIpInput').focus();
        return;
      }
      window.open(`https://${ip}:3001`, '_blank', 'noopener');
      showToast('Hãy bấm "Nâng cao → Tiếp tục truy cập" ở tab vừa mở, sau đó quay lại đây bấm Kết nối!', 'info');
    });
  }

  $('btnDemoMode').addEventListener('click', async () => {
    haptic(16);
    if (state.connected && state.demo) {
      if (isNative) {
        await callNative('disconnect');
      } else if (isStandalone && directBackend) {
        directBackend.disconnect();
      } else {
        await fetch('/api/disconnect', { method: 'POST' });
      }
      showToast('Đã tắt Chế độ Demo', 'info');
    } else {
      await connectTV({ demo: true, ip: 'demo-tv', name: 'LG OLED C4 55" (Demo)' });
    }
  });

  $('btnCancelPairing').addEventListener('click', () => {
    $('pairingModal').classList.add('hidden');
  });

  // Network Info & QR Modal
  async function loadNetworkInfo() {
    if (isNative) {
      $('btnOpenQr').classList.add('hidden');
      const mobileCard = $('mobileUrlBox')?.closest('.card');
      if (mobileCard) mobileCard.classList.add('hidden');
      try {
        const r = await callNative('networkInfo');
        if (r.ok && r.data) {
          $('wifiNetworkLabel').textContent = `Wi-Fi hiện tại: ${r.data.ip} · Quét SSDP & dải LAN`;
        }
      } catch {}
      return false;
    }

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1800);
      const res = await fetch('/api/network-info', { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('No backend');
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('Not JSON');
      networkInfo = await res.json();
      if (!networkInfo || !networkInfo.url) throw new Error('Invalid');
      $('mobileUrlBox').textContent = networkInfo.url;
      $('wifiNetworkLabel').textContent = `Mạng hiện tại: ${networkInfo.interfaceName} (${networkInfo.ip})`;
      $('qrImage').src = networkInfo.qrDataUrl;
      $('qrUrlText').textContent = networkInfo.url;
      return true;
    } catch {
      // No local Node.js backend -> activate Standalone Web Mode (GitHub Pages / static hosting)
      isStandalone = true;
      const pageUrl = location.href.split('#')[0];
      $('mobileUrlBox').textContent = pageUrl;
      $('qrUrlText').textContent = pageUrl;
      $('qrImage').src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(pageUrl)}`;
      $('webModeBanner')?.classList.remove('hidden');
      $('webSubnetBox')?.classList.remove('hidden');
      $('btnCheckRecent')?.classList.add('hidden');
      if (location.protocol === 'https:') {
        $('trustCertRow')?.classList.remove('hidden');
      }
      if (directBackend) {
        const detectedSubnet = await directBackend.detectLocalSubnet();
        const subnetInput = $('subnetPrefixInput');
        if (subnetInput) subnetInput.value = detectedSubnet;
        $('wifiNetworkLabel').textContent = `Quét trực tiếp dải Wi-Fi (${detectedSubnet}.x) từ trình duyệt`;
        document.querySelectorAll('.subnet-chip').forEach((chip) => {
          chip.classList.toggle('active', chip.dataset.subnet === detectedSubnet);
          chip.addEventListener('click', () => {
            haptic(8);
            if (subnetInput) subnetInput.value = chip.dataset.subnet;
            $('wifiNetworkLabel').textContent = `Quét trực tiếp dải Wi-Fi (${chip.dataset.subnet}.x) từ trình duyệt`;
            document.querySelectorAll('.subnet-chip').forEach((c) => c.classList.toggle('active', c === chip));
          });
        });
      }
      return false;
    }
  }

  function openQrModal() {
    haptic(10);
    if (!networkInfo && !isStandalone) loadNetworkInfo();
    $('qrModal').classList.remove('hidden');
  }

  $('btnOpenQr').addEventListener('click', openQrModal);
  $('btnShowQrFromTab').addEventListener('click', openQrModal);
  $('btnCloseQr').addEventListener('click', () => $('qrModal').classList.add('hidden'));
  $('qrModal').addEventListener('click', (e) => {
    if (e.target === $('qrModal')) $('qrModal').classList.add('hidden');
  });

  // PWA Service Worker
  if (!isNative && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Init (detect server vs standalone web mode first)
  (async function init() {
    await loadNetworkInfo();
    connectWS();
    loadRecentTVs(!isStandalone);
  })();
})();
