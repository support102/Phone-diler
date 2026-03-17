const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const webPush = require('web-push');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = !!process.env.PORT; // If PORT is defined, assume we are on Render/Vercel/etc.

// --- Generate or load self-signed SSL cert using Node crypto ---
const CERT_DIR = path.join(__dirname, '.certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

function generateSelfSignedCert() {
  // Use Node's built-in crypto to generate a self-signed cert
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Create a self-signed certificate using openssl if available, or forge one
  // We'll create the cert using Node's X509Certificate (Node 15+)
  try {
    // Try using openssl command
    if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, privateKey);

    execSync(
      `openssl req -new -x509 -key "${KEY_FILE}" -out "${CERT_FILE}" -days 365 -subj "/CN=Dial Relay Local" -addext "subjectAltName=IP:${getLocalIP()}" 2>&1`,
      { timeout: 10000 }
    );

    return {
      cert: fs.readFileSync(CERT_FILE, 'utf8'),
      key: privateKey,
    };
  } catch (e) {
    // Fallback: generate using openssl with simpler syntax
    try {
      execSync(
        `openssl req -new -x509 -key "${KEY_FILE}" -out "${CERT_FILE}" -days 365 -subj "/CN=Dial Relay Local" 2>&1`,
        { timeout: 10000 }
      );
      return {
        cert: fs.readFileSync(CERT_FILE, 'utf8'),
        key: privateKey,
      };
    } catch (e2) {
      // Last fallback: use openssl to generate both key and cert
      try {
        execSync(
          `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 365 -nodes -subj "/CN=Dial Relay Local" 2>&1`,
          { timeout: 15000 }
        );
        return {
          cert: fs.readFileSync(CERT_FILE, 'utf8'),
          key: fs.readFileSync(KEY_FILE, 'utf8'),
        };
      } catch (e3) {
        console.error('Could not generate SSL certificate. Make sure openssl is available.');
        console.error('On Windows, install OpenSSL or use Git Bash which includes it.');
        process.exit(1);
      }
    }
  }
}

// Get the local LAN IP address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ name, address: iface.address });
      }
    }
  }
  const wifi = candidates.find(c => /wi-?fi|wireless|wlan/i.test(c.name));
  if (wifi) return wifi.address;
  const lan = candidates.find(c => c.address.startsWith('192.168.'));
  if (lan) return lan.address;
  const ten = candidates.find(c => c.address.startsWith('10.'));
  if (ten) return ten.address;
  const nonLinkLocal = candidates.find(c => !c.address.startsWith('169.254.'));
  if (nonLinkLocal) return nonLinkLocal.address;
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

const LOCAL_IP = getLocalIP();

let server;
if (!IS_PROD) {
  let sslCert, sslKey;
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    sslCert = fs.readFileSync(CERT_FILE, 'utf8');
    sslKey = fs.readFileSync(KEY_FILE, 'utf8');
    console.log('Loaded existing SSL certificate.');
  } else {
    console.log('Generating self-signed SSL certificate for local HTTPS...');
    const certs = generateSelfSignedCert();
    sslCert = certs.cert;
    sslKey = certs.key;
    console.log('SSL certificate generated and saved.');
  }
  server = https.createServer({ cert: sslCert, key: sslKey }, app);
} else {
  console.log('Production detected. Serving via HTTP (SSL handled by proxy).');
  server = http.createServer(app);
}

const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

// --- VAPID keys for Web Push (Hardcoded for single-file deployment) ---
const vapidKeys = {
  publicKey: 'BBvTWgcAU-Z9Gw36GvFECtdCFQU6NeL5QCPsvLF8S3STwTvn65ElVDfylHr5b4pUdi9YZPwd8y6MLyZlaTMHhRU',
  privateKey: 'MyYFYI_zqGrCgm7AQDPj3tXpOpstExFlaUmAUUVHjWo'
};

webPush.setVapidDetails(
  'mailto:local@localhost', 
  vapidKeys.publicKey, 
  vapidKeys.privateKey
);

// Store active sessions (Persist to disk to survive restarts)
const SESSIONS_FILE = path.join(__dirname, '.sessions.json');
let sessions = new Map();

function saveSessions() {
  try {
    const data = JSON.stringify(Array.from(sessions.entries()).map(([id, s]) => [
      id,
      { pushSubscription: s.pushSubscription, createdAt: s.createdAt }
    ]));
    fs.writeFileSync(SESSIONS_FILE, data);
  } catch (e) {
    console.error('Failed to save sessions:', e);
  }
}

function loadSessions() {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      sessions = new Map(data.map(([id, s]) => [
        id,
        { 
          desktopSocket: null, 
          mobileSocket: null, 
          pushSubscription: s.pushSubscription, 
          createdAt: s.createdAt || Date.now() 
        }
      ]));
      console.log(`Loaded ${sessions.size} sessions from disk.`);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    }
  }
}

loadSessions();

// Background cleanup: Remove sessions older than 24 hours
setInterval(() => {
  const now = Date.now();
  const expiry = 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > expiry) {
      sessions.delete(id);
      deleted++;
    }
  }
  if (deleted > 0) {
    console.log(`Cleanup: Removed ${deleted} expired sessions.`);
    saveSessions();
  }
}, 60 * 60 * 1000); // Run every hour

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// VAPID public key endpoint
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Push subscription registration
app.post('/api/push-subscribe', (req, res) => {
  const { sessionId, subscription } = req.body;
  if (!sessionId || !subscription) {
    return res.status(400).json({ error: 'Missing sessionId or subscription' });
  }
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { 
      desktopSocket: null, 
      mobileSocket: null, 
      pushSubscription: null, 
      createdAt: Date.now() 
    });
  }
  const session = sessions.get(sessionId);
  session.pushSubscription = subscription;
  saveSessions();
  console.log(`Push subscription saved for session: ${sessionId}`);
  // Notify desktop that push is now active
  if (session.desktopSocket) {
    sendPhoneStatus(session);
  }
  res.json({ success: true });
});

// Push subscription removal
app.post('/api/push-unsubscribe', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.pushSubscription = null;
    saveSessions();
    if (session.desktopSocket) sendPhoneStatus(session);
    console.log(`Push subscription removed for session: ${sessionId}`);
  }
  res.json({ success: true });
});

// QR code generation — HTTPS URLs
app.get('/api/qrcode', async (req, res) => {
  const sessionId = req.query.session;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing session ID' });
  }

  // Detect protocol and host to support tunnels (like trycloudflare.com)
  const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers['host'];
  const url = `${protocol}://${host}/mobile.html?session=${sessionId}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.json({ qr: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Send push notification
async function sendPushNotification(sessionId, phoneNumber) {
  const session = sessions.get(sessionId);
  if (!session || !session.pushSubscription) return false;

  const payload = JSON.stringify({
    title: 'Dial Request',
    body: `Call ${phoneNumber}`,
    phoneNumber: phoneNumber,
  });

  try {
    await webPush.sendNotification(session.pushSubscription, payload);
    console.log(`Push notification sent: ${phoneNumber} (session: ${sessionId})`);
    return true;
  } catch (err) {
    console.log(`Push notification failed: ${err.message}`);
    if (err.statusCode === 410 || err.statusCode === 404) {
      session.pushSubscription = null;
    }
    return false;
  }
}

// Socket.IO
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Helper: send detailed phone status to desktop
  function sendPhoneStatus(session) {
    const hasSocket = !!session.mobileSocket;
    const hasPush = !!session.pushSubscription;
    // status: 'connected' (socket live), 'push-only' (socket dead but push works), 'disconnected'
    let status = 'disconnected';
    if (hasSocket) status = 'connected';
    else if (hasPush) status = 'push-only';
    
    console.log(`Status update for ${session.desktopSocket.sessionId}: ${status} (Socket: ${hasSocket}, Push: ${hasPush})`);
    session.desktopSocket.emit('phone-status', { 
      connected: hasSocket || hasPush, 
      status, 
      hasPush, 
      hasSocket 
    });
  }

  socket.on('register-desktop', (sessionId) => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        desktopSocket: null, 
        mobileSocket: null, 
        pushSubscription: null, 
        createdAt: Date.now() 
      });
    }
    const session = sessions.get(sessionId);
    session.desktopSocket = socket;
    socket.sessionId = sessionId;
    socket.role = 'desktop';
    console.log(`Desktop registered for session: ${sessionId}`);
    sendPhoneStatus(session);
  });

  socket.on('register-mobile', (sessionId) => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { 
        desktopSocket: null, 
        mobileSocket: null, 
        pushSubscription: null, 
        createdAt: Date.now() 
      });
    }
    const session = sessions.get(sessionId);
    session.mobileSocket = socket;
    socket.sessionId = sessionId;
    socket.role = 'mobile';
    console.log(`Mobile registered for session: ${sessionId}`);
    sendPhoneStatus(session);
    socket.emit('mobile-connected', { success: true });
  });

  socket.on('dial-request', async (data) => {
    const { sessionId, phoneNumber } = data;
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('dial-sent', { success: false, error: 'Session not found' });
      return;
    }

    let sent = false;

    if (session.mobileSocket) {
      session.mobileSocket.emit('dial-request', { phoneNumber });
      sent = true;
    }

    if (session.pushSubscription) {
      await sendPushNotification(sessionId, phoneNumber);
      sent = true;
    }

    if (sent) {
      socket.emit('dial-sent', { success: true, phoneNumber });
      console.log(`Dial request sent: ${phoneNumber} (session: ${sessionId})`);
    } else {
      socket.emit('dial-sent', { success: false, error: 'Phone not connected' });
    }
  });

  socket.on('disconnect', () => {
    const sessionId = socket.sessionId;
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (socket.role === 'mobile') {
        session.mobileSocket = null;
        sendPhoneStatus(session);
        console.log(`Mobile disconnected (session: ${sessionId}, push active: ${!!session.pushSubscription})`);
      } else if (socket.role === 'desktop') {
        session.desktopSocket = null;
        console.log(`Desktop disconnected: ${sessionId} (Keeping session alive for 24h)`);
      }
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// Start helper server ONLY in development
if (!IS_PROD) {
  const httpServerHelp = http.createServer(app);
  const HTTP_PORT_HELP = 3001;
  httpServerHelp.listen(HTTP_PORT_HELP, '0.0.0.0', () => {
    console.log(`HTTP helper server on port ${HTTP_PORT_HELP} (Use this for local tunnels)`);
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log(`║      Dial Relay — Running (${IS_PROD ? 'Production' : 'HTTPS'})      ║`);
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Port:   ${PORT}                                 ║`);
  if (!IS_PROD) {
    console.log(`║  Local:  https://localhost:${PORT}               ║`);
    console.log(`║  LAN:    https://${LOCAL_IP}:${PORT}           ║`);
    console.log('╠═══════════════════════════════════════════════╣');
    console.log('║  IMPORTANT: Accept the browser warning on     ║');
    console.log('║  BOTH desktop & phone for local testing.      ║');
  } else {
    console.log('║  SSL is handled by the deployment platform.   ║');
    console.log('║  Persistence used: .sessions.json             ║');
  }
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
});
