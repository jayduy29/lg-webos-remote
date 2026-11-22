const dgram = require('dgram');
const net = require('net');
const os = require('os');
const http = require('http');
const { exec } = require('child_process');

/**
 * Get local IPv4 network interfaces (preferring Wi-Fi / active LAN)
 */
function getLocalInterfaces() {
  const interfaces = os.networkInterfaces();
  const results = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const lower = name.toLowerCase();
        const isVirtual =
          lower.includes('vethernet') ||
          lower.includes('vmware') ||
          lower.includes('virtualbox') ||
          lower.includes('docker') ||
          lower.includes('wsl') ||
          lower.includes('tailscale') ||
          lower.includes('zerotier') ||
          lower.includes('loopback');

        const isWifi = lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan');
        results.push({
          name,
          address: addr.address,
          netmask: addr.netmask,
          cidr: addr.cidr,
          isWifi,
          isVirtual,
          priority: isWifi ? 1 : isVirtual ? 3 : 2
        });
      }
    }
  }

  return results.sort((a, b) => a.priority - b.priority);
}

/**
 * Parse ARP table to map IP -> MAC address (works on Windows, macOS, Linux)
 */
function getArpTable() {
  return new Promise((resolve) => {
    exec('arp -a', { timeout: 2500 }, (err, stdout) => {
      const map = new Map();
      if (err || !stdout) return resolve(map);

      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const ipMatch = line.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
        const macMatch = line.match(/([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/);
        if (ipMatch && macMatch) {
          const ip = ipMatch[1];
          const mac = macMatch[0].replace(/-/g, ':').toUpperCase();
          if (mac !== 'FF:FF:FF:FF:FF:FF' && !mac.startsWith('01:00:5E')) {
            map.set(ip, mac);
          }
        }
      }
      resolve(map);
    });
  });
}

/**
 * Fetch UPnP XML descriptor from SSDP LOCATION header
 */
function fetchUpnpInfo(locationUrl) {
  return new Promise((resolve) => {
    try {
      const req = http.get(locationUrl, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 50000) res.destroy();
        });
        res.on('end', () => {
          const extract = (tag) => {
            const m = data.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
            return m ? m[1].trim() : '';
          };
          resolve({
            friendlyName: extract('friendlyName'),
            modelName: extract('modelName'),
            manufacturer: extract('manufacturer'),
            udn: extract('UDN')
          });
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * SSDP M-SEARCH discovery for LG webOS TVs on Wi-Fi/LAN
 */
function discoverSSDP(timeoutMs = 2800) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const searchTargets = [
      'urn:lge-com:service:webos-second-screen:1',
      'urn:schemas-upnp-org:device:MediaRenderer:1',
      'ssdp:all'
    ];

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const headers = {};
      for (const line of text.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      }

      const server = (headers.server || '').toLowerCase();
      const st = (headers.st || '').toLowerCase();
      const usn = (headers.usn || '').toLowerCase();
      const location = headers.location || '';

      const looksLikeLG =
        st.includes('lge-com') ||
        st.includes('webos') ||
        server.includes('webos') ||
        server.includes('lge') ||
        usn.includes('lge');

      if (looksLikeLG && rinfo.address) {
        const prev = found.get(rinfo.address) || {};
        found.set(rinfo.address, {
          ip: rinfo.address,
          location: location || prev.location || '',
          server: headers.server || prev.server || '',
          via: 'ssdp'
        });
      }
    });

    socket.on('error', () => {
      try { socket.close(); } catch {}
      resolve([]);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(4);
      } catch {}

      const sendAll = () => {
        for (const st of searchTargets) {
          const packet = Buffer.from(
            [
              'M-SEARCH * HTTP/1.1',
              'HOST: 239.255.255.250:1900',
              'MAN: "ssdp:discover"',
              'MX: 2',
              `ST: ${st}`,
              '',
              ''
            ].join('\r\n')
          );
          socket.send(packet, 0, packet.length, 1900, '239.255.255.250', () => {});
        }
      };

      sendAll();
      setTimeout(sendAll, 700);
    });

    setTimeout(async () => {
      try { socket.close(); } catch {}
      const list = [];
      for (const item of found.values()) {
        let info = null;
        if (item.location) {
          info = await fetchUpnpInfo(item.location);
        }
        list.push({
          ip: item.ip,
          name: (info && info.friendlyName) || `LG webOS TV (${item.ip})`,
          model: (info && info.modelName) || 'LG webOS Smart TV',
          manufacturer: (info && info.manufacturer) || 'LG Electronics',
          id: (info && info.udn) || `lg-${item.ip}`,
          via: 'ssdp'
        });
      }
      resolve(list);
    }, timeoutMs);
  });
}

/**
 * Check if a TCP port is open (used for LG webOS 3001 / 3000)
 */
function probePort(ip, port, timeoutMs = 320) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, ip);
  });
}

/**
 * Check if a single IP has LG webOS port 3001 or 3000 open
 */
async function probeWebOSTV(ip, timeoutMs = 350) {
  const [p3001, p3000] = await Promise.all([
    probePort(ip, 3001, timeoutMs),
    probePort(ip, 3000, timeoutMs)
  ]);
  if (p3001 || p3000) {
    return {
      ip,
      port: p3001 ? 3001 : 3000,
      online: true
    };
  }
  return null;
}

/**
 * Active /24 subnet scan on primary Wi-Fi/LAN interface for ports 3000 & 3001
 */
async function scanSubnetPorts(onProgress) {
  const ifaces = getLocalInterfaces().filter((i) => !i.isVirtual);
  if (ifaces.length === 0) return [];

  // Scan the highest-priority local interface (Wi-Fi first)
  const primary = ifaces[0];
  const parts = primary.address.split('.');
  if (parts.length !== 4) return [];

  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const ips = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${prefix}.${i}`;
    if (ip !== primary.address) ips.push(ip);
  }

  const found = [];
  const batchSize = 45;
  let scanned = 0;

  for (let i = 0; i < ips.length; i += batchSize) {
    const batch = ips.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((ip) => probeWebOSTV(ip, 320)));
    for (const r of results) {
      if (r) {
        found.push({
          ip: r.ip,
          port: r.port,
          name: `LG webOS TV (${r.ip})`,
          model: `webOS TV (Port ${r.port})`,
          id: `lg-${r.ip}`,
          via: 'wifi-scan'
        });
      }
    }
    scanned += batch.length;
    if (onProgress) {
      onProgress(Math.min(100, Math.round((scanned / ips.length) * 100)));
    }
  }

  return found;
}

/**
 * Combined Wi-Fi discovery: SSDP + Subnet Scan + ARP MAC resolution + Recent TVs check
 */
async function discoverAllTVs(savedTVs = []) {
  const [ssdpResults, subnetResults] = await Promise.all([
    discoverSSDP(2800),
    scanSubnetPorts()
  ]);

  const arpMap = await getArpTable();
  const merged = new Map();

  // Add SSDP results first (richer metadata like friendlyName & model)
  for (const tv of ssdpResults) {
    const probe = await probeWebOSTV(tv.ip, 500);
    merged.set(tv.ip, {
      ...tv,
      port: probe ? probe.port : 3001,
      mac: arpMap.get(tv.ip) || '',
      online: true
    });
  }

  // Merge subnet port-scan hits
  for (const tv of subnetResults) {
    if (merged.has(tv.ip)) {
      const existing = merged.get(tv.ip);
      merged.set(tv.ip, {
        ...existing,
        port: tv.port || existing.port,
        mac: existing.mac || arpMap.get(tv.ip) || '',
        via: `${existing.via}+wifi-scan`,
        online: true
      });
    } else {
      merged.set(tv.ip, {
        ...tv,
        mac: arpMap.get(tv.ip) || '',
        online: true
      });
    }
  }

  // Enrich with saved TV names/clientKeys & check saved TVs online status
  const savedByIp = new Map(savedTVs.map((t) => [t.ip, t]));
  for (const [ip, tv] of merged.entries()) {
    const saved = savedByIp.get(ip);
    if (saved) {
      merged.set(ip, {
        ...tv,
        name: tv.via.includes('ssdp') ? tv.name : saved.name || tv.name,
        mac: tv.mac || saved.mac || '',
        paired: Boolean(saved.clientKey),
        lastConnected: saved.lastConnected || null
      });
    }
  }

  return Array.from(merged.values());
}

/**
 * Check online status of recent/saved TVs quickly
 */
async function checkRecentTVsOnline(savedTVs = []) {
  const arpMap = await getArpTable();
  const results = await Promise.all(
    savedTVs.map(async (tv) => {
      const probe = await probeWebOSTV(tv.ip, 450);
      return {
        ...tv,
        mac: tv.mac || arpMap.get(tv.ip) || '',
        paired: Boolean(tv.clientKey),
        online: Boolean(probe),
        port: probe ? probe.port : tv.port || 3001
      };
    })
  );
  return results;
}

/**
 * Send Wake-on-LAN magic packet to turn ON an LG TV
 */
function sendWakeOnLan(macAddress, ipAddress) {
  return new Promise((resolve, reject) => {
    const cleanMac = (macAddress || '').replace(/[^0-9a-fA-F]/g, '');
    if (cleanMac.length !== 12) {
      return reject(new Error('Địa chỉ MAC không hợp lệ để bật TV (Wake-on-LAN).'));
    }

    const macBytes = Buffer.from(cleanMac, 'hex');
    const packet = Buffer.alloc(6 + 16 * 6);
    packet.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(packet, 6 + i * 6);
    }

    const targets = ['255.255.255.255'];
    if (ipAddress && /^\d+\.\d+\.\d+\.\d+$/.test(ipAddress)) {
      const parts = ipAddress.split('.');
      targets.push(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    }

    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => {
      try { socket.close(); } catch {}
      reject(err);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      let sent = 0;
      const total = targets.length * 2;
      const finish = () => {
        sent++;
        if (sent >= total) {
          setTimeout(() => {
            try { socket.close(); } catch {}
            resolve({ ok: true, mac: macAddress });
          }, 150);
        }
      };

      for (const target of targets) {
        socket.send(packet, 0, packet.length, 9, target, finish);
        socket.send(packet, 0, packet.length, 7, target, finish);
      }
    });
  });
}

module.exports = {
  getLocalInterfaces,
  getArpTable,
  discoverSSDP,
  scanSubnetPorts,
  discoverAllTVs,
  checkRecentTVsOnline,
  probeWebOSTV,
  sendWakeOnLan
};
