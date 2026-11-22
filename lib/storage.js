const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TVS_FILE = path.join(DATA_DIR, 'tvs.json');

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(TVS_FILE)) {
    fs.writeFileSync(TVS_FILE, JSON.stringify({ tvs: [] }, null, 2), 'utf8');
  }
}

function loadTVs() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(TVS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed.tvs) ? parsed.tvs : [];
    return list.sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));
  } catch {
    return [];
  }
}

function saveTVs(tvs) {
  ensureStorage();
  fs.writeFileSync(TVS_FILE, JSON.stringify({ tvs }, null, 2), 'utf8');
}

function upsertTV(tvData) {
  const tvs = loadTVs();
  const key = tvData.id || tvData.mac || tvData.ip;
  const idx = tvs.findIndex(
    (t) =>
      (tvData.id && t.id === tvData.id) ||
      (tvData.mac && t.mac && t.mac.toLowerCase() === tvData.mac.toLowerCase()) ||
      t.ip === tvData.ip
  );

  const now = Date.now();
  if (idx >= 0) {
    tvs[idx] = {
      ...tvs[idx],
      ...tvData,
      id: tvs[idx].id || key,
      name: tvData.name || tvs[idx].name || `LG webOS TV (${tvData.ip})`,
      clientKey: tvData.clientKey !== undefined ? tvData.clientKey : tvs[idx].clientKey,
      mac: tvData.mac || tvs[idx].mac || '',
      model: tvData.model || tvs[idx].model || '',
      lastConnected: tvData.lastConnected || tvs[idx].lastConnected || now,
      updatedAt: now
    };
  } else {
    tvs.unshift({
      id: key,
      ip: tvData.ip,
      name: tvData.name || `LG webOS TV (${tvData.ip})`,
      model: tvData.model || 'webOS Smart TV',
      mac: tvData.mac || '',
      clientKey: tvData.clientKey || '',
      port: tvData.port || 3001,
      lastConnected: tvData.lastConnected || now,
      updatedAt: now
    });
  }

  saveTVs(tvs);
  return loadTVs().find((t) => t.ip === tvData.ip || (tvData.id && t.id === tvData.id));
}

function getTVByIp(ip) {
  return loadTVs().find((t) => t.ip === ip) || null;
}

function deleteTV(idOrIp) {
  const tvs = loadTVs().filter((t) => t.id !== idOrIp && t.ip !== idOrIp);
  saveTVs(tvs);
  return tvs;
}

module.exports = {
  loadTVs,
  upsertTV,
  getTVByIp,
  deleteTV
};
