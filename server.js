import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import http from 'http';
import https from 'https';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import os from 'os';
import * as mediasoup from 'mediasoup';
import { initDb, verifyStudent, verifyTeacher, registerStudent, registerTeacher, listStudents, listTeachers, updateStudent, updateTeacher, deleteStudent, deleteTeacher } from './db/users.js';
import { initUserSessionsDb, insertSession, getLatestSessionByUsername, getSessionsPaginated } from './db/user-sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 本番: dist/index.html が存在し NODE_ENV=production のときは dist を配信 */
const isProductionBuild = process.env.NODE_ENV === 'production' &&
    fs.existsSync(path.join(__dirname, 'dist', 'index.html'));
const STATIC_DIR = path.join(__dirname, isProductionBuild ? 'dist' : 'public');

// Worlds config file (setting.html)
const DATA_DIR = path.join(__dirname, 'data');
const WORLDS_PATH = path.join(DATA_DIR, 'worlds.json');
const DEFAULT_WORLDS = {
    'lobby': {
        id: 'lobby',
        name: 'Lobby',
        models: [
            { path: 'models/lobby.glb', position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } },
            { path: 'models/monument.glb', position: { x: 0, y: 3.5, z: -10 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 }, animate: { rotation: { x: 0, y: 0.1, z: 0 } } },
            { path: 'models/teleporter_s2.glb', position: { x: 6, y: 1.35, z: -10 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.05, y: 0.05, z: 0.05 }, animate: { rotation: { x: 0, y: 0.1, z: 0 } }, teleporter: { id: 's1', destinationWorld: 'school', radius: 3, label: '新校舎' } },
            { path: 'models/teleporter_l2.glb', position: { x: 6, y: 3.9, z: -10 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.3, y: 0.3, z: 0.3 } }
        ],
        spawnPoint: { x: 0, y: 10, z: 0 },
        lights: [
            { type: 'ambient', intensity: 0.5, color: 0xffffff },
            { type: 'directional', position: { x: 50, y: 100, z: 50 }, intensity: 0.8, color: 0xffffff, castShadow: true },
            { type: 'point', position: { x: 6, y: 2, z: -10 }, intensity: 5, color: 0xffeedd, distance: 50 },
            { type: 'point', position: { x: 6, y: 4.5, z: -10 }, intensity: 5, color: 0xffeedd, distance: 50 }
        ]
    },
    'school': {
        id: 'school',
        name: '新校舎',
        models: [
            { path: 'models/school_base.glb', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
        ],
        spawnPoint: { x: 0, y: 10, z: 0 },
        lights: [
            { type: 'ambient', intensity: 0.4, color: 0xffffff },
            { type: 'directional', position: { x: 30, y: 80, z: 20 }, intensity: 0.9, color: 0xffffcc, castShadow: true },
            { type: 'point', position: { x: 5, y: 5, z: 5 }, intensity: 0.6, color: 0xffffff, distance: 30 }
        ]
    }
};

function ensureWorldsFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        console.log('Created data directory');
    }
    if (!fs.existsSync(WORLDS_PATH)) {
        fs.writeFileSync(WORLDS_PATH, JSON.stringify(DEFAULT_WORLDS, null, 2), 'utf8');
        console.log('Created worlds.json from default');
    }
}

function readWorlds() {
    try {
        const data = fs.readFileSync(WORLDS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.warn('Failed to read worlds.json, using default:', err.message);
        return DEFAULT_WORLDS;
    }
}

function writeWorlds(worlds) {
    const tmpPath = WORLDS_PATH + '.tmp.' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(worlds, null, 2), 'utf8');
    fs.renameSync(tmpPath, WORLDS_PATH);
}

const MODELS_DIR = path.join(__dirname, 'public', 'models');
const PDFS_DIR = path.join(__dirname, 'public', 'pdfs');
const uploadStorage = multer.memoryStorage();
const upload = multer({
    storage: uploadStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const ok = ext === '.glb' && (
            file.mimetype === 'model/gltf-binary' ||
            file.mimetype === 'application/octet-stream' ||
            file.mimetype === 'model/gltf+json'
        );
        cb(null, !!ok);
    }
});
const uploadPdf = multer({
    storage: uploadStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const ok = ext === '.pdf' || file.mimetype === 'application/pdf';
        cb(null, !!ok);
    }
});

const app = express();

/** HTTPS: SSL_CERT_PATH と SSL_KEY_PATH が両方設定されていれば HTTPS で待ち受ける */
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const PORT_HTTP_REDIRECT = process.env.PORT_HTTP_REDIRECT ? parseInt(process.env.PORT_HTTP_REDIRECT, 10) : 0;

const hasSsl =
    SSL_CERT_PATH && SSL_KEY_PATH &&
    fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);

const httpServer = hasSsl
    ? https.createServer(
        {
            key: fs.readFileSync(SSL_KEY_PATH),
            cert: fs.readFileSync(SSL_CERT_PATH),
        },
        app
    )
    : http.createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
/** Bind to 0.0.0.0 for LAN access; use 127.0.0.1 for localhost only */
const HOST = process.env.HOST || '0.0.0.0';

/** Returns IPv4 LAN addresses (non-internal) for display */
function getLanIps() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push(net.address);
            }
        }
    }
    return ips;
}
const VC_DEBUG_STATS = process.env.VC_DEBUG_STATS === '1';

// ============================
// mediasoup Configuration
// ============================
const MEDIASOUP_ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP;
const MEDIASOUP_ENABLE_LOCALHOST =
    process.env.MEDIASOUP_ENABLE_LOCALHOST === '1' || process.env.NODE_ENV !== 'production';

if (process.env.NODE_ENV === 'production' && !MEDIASOUP_ANNOUNCED_IP) {
    console.warn(
        '[VC] NODE_ENV=production but MEDIASOUP_ANNOUNCED_IP is not set. ' +
        'External WebRTC clients may fail to connect. ' +
        'Set MEDIASOUP_ANNOUNCED_IP to your public IP or domain (e.g. mmh-virtual.jp).'
    );
}

// VC (mediasoup) UDP port range - configurable via .env
const VC_RTC_MIN_PORT = parseInt(process.env.VC_RTC_MIN_PORT || '10000', 10);
const VC_RTC_MAX_PORT = parseInt(process.env.VC_RTC_MAX_PORT || '10100', 10);

// PDF Viewer VC UDP port range - configurable via .env
const PDF_VC_RTC_MIN_PORT = parseInt(process.env.PDF_VC_RTC_MIN_PORT || '20000', 10);
const PDF_VC_RTC_MAX_PORT = parseInt(process.env.PDF_VC_RTC_MAX_PORT || '20100', 10);

// Video VC UDP port range - configurable via .env
const VIDEO_VC_RTC_MIN_PORT = parseInt(process.env.VIDEO_VC_RTC_MIN_PORT || '30000', 10);
const VIDEO_VC_RTC_MAX_PORT = parseInt(process.env.VIDEO_VC_RTC_MAX_PORT || '31000', 10);
const VIDEO_VC_MAX_PRODUCERS_PER_ROOM = parseInt(process.env.VIDEO_VC_MAX_PRODUCERS_PER_ROOM || '10', 10);

const mediasoupConfig = {
    worker: {
        rtcMinPort: VC_RTC_MIN_PORT,
        rtcMaxPort: VC_RTC_MAX_PORT,
        logLevel: 'warn',
        logTags: [
            'info',
            'ice',
            'dtls',
            'rtp',
            'srtp',
            'rtcp',
        ],
    },
    router: {
        mediaCodecs: [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
            },
        ],
    },
    webRtcTransport: {
        listenIps: [
            {
                ip: '0.0.0.0',
                // NOTE:
                // - For localhost testing you can leave announcedIp undefined.
                // - For production/public access you should set MEDIASOUP_ANNOUNCED_IP
                //   (public IP or domain) so clients receive reachable ICE candidates.
                announcedIp: MEDIASOUP_ANNOUNCED_IP || undefined,
            },
            ...(MEDIASOUP_ENABLE_LOCALHOST
                ? [
                    {
                        ip: '127.0.0.1', // Localhost for local testing
                        announcedIp: '127.0.0.1',
                    },
                ]
                : []),
        ],
        maxIncomingBitrate: 150000, // 150kbps for audio
        initialAvailableOutgoingBitrate: 600000,
    },
};

// PDF Viewer VC: separate worker config (different port range)
const pdfVcMediasoupConfig = {
    worker: {
        rtcMinPort: PDF_VC_RTC_MIN_PORT,
        rtcMaxPort: PDF_VC_RTC_MAX_PORT,
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },
    router: { mediaCodecs: mediasoupConfig.router.mediaCodecs },
    webRtcTransport: mediasoupConfig.webRtcTransport,
};

// Video VC: separate worker config with video codecs
const videoVcMediasoupConfig = {
    worker: {
        rtcMinPort: VIDEO_VC_RTC_MIN_PORT,
        rtcMaxPort: VIDEO_VC_RTC_MAX_PORT,
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },
    router: {
        mediaCodecs: [
            { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
            { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }] },
            { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'level-asymmetry-allowed': 1 }, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }] },
        ],
    },
    webRtcTransport: {
        ...mediasoupConfig.webRtcTransport,
        maxIncomingBitrate: 5000000, // 5Mbps for video (incl. 1080p)
    },
};

// mediasoup Worker Pool
const workers = [];
let nextWorkerIndex = 0;

// PDF VC Worker Pool
const pdfWorkers = [];
let nextPdfWorkerIndex = 0;

// VC Room Routers: Map<roomId, Router>
const vcRouters = new Map();

// VC Peers: Map<socketId, { transports, producers, consumers }>
const vcPeers = new Map();

// PDF VC: Map<pdfRoomId, Router> and Map<socketId, peer state>
const pdfVcRouters = new Map();
const pdfVcPeers = new Map();

// Video VC: Map<roomId, Router> and Map<socketId, peer state>
const videoVcWorkers = [];
let nextVideoVcWorkerIndex = 0;
const videoVcRouters = new Map();
const videoVcPeers = new Map();

// Max simultaneous active producers (mic ON) per room
const MAX_ACTIVE_PRODUCERS_PER_ROOM = 10;

// ICE servers configuration (STUN/TURN)
let cachedIceServers = null;
let iceServersExpiry = 0;

async function fetchCloudflareIceServers() {
    const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
    const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
    
    if (!apiToken || !keyId) {
        console.log('[VC] Cloudflare TURN not configured (missing API_TOKEN or KEY_ID)');
        return null;
    }
    
    try {
        const response = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ ttl: 86400 }), // 24 hours
            }
        );
        
        if (!response.ok) {
            throw new Error(`Cloudflare API error: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[VC] Cloudflare ICE servers fetched successfully');
        return data.iceServers;
    } catch (error) {
        console.error('[VC] Failed to fetch Cloudflare ICE servers:', error);
        return null;
    }
}

async function getIceServers() {
    const now = Date.now();
    
    // Return cached servers if still valid
    if (cachedIceServers && now < iceServersExpiry) {
        return cachedIceServers;
    }
    
    // Try to fetch from Cloudflare
    const cloudflareServers = await fetchCloudflareIceServers();
    
    if (cloudflareServers) {
        cachedIceServers = cloudflareServers;
        // Refresh 1 hour before expiry (23 hours)
        iceServersExpiry = now + (23 * 60 * 60 * 1000);
        console.log('[VC] Using Cloudflare ICE servers');
        return cachedIceServers;
    }
    
    // Fallback to Google STUN
    const fallbackServers = [
        {
            urls: ['stun:stun.l.google.com:19302'],
        },
    ];
    
    console.log('[VC] Using fallback STUN only');
    return fallbackServers;
}

// ============================
// Admin: Basic Authentication
// ============================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
// 通信帯域上限 (Mbps)。1 Mbps ≈ 125,000 bytes/s
const BANDWIDTH_LIMIT_MBPS = parseFloat(process.env.BANDWIDTH_LIMIT_MBPS || '100');
const BANDWIDTH_LIMIT_BPS = Math.floor(BANDWIDTH_LIMIT_MBPS * 125000);

function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
        return res.status(401).send('認証が必要です');
    }
    
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');
    
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        return next();
    }
    
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
    return res.status(401).send('認証に失敗しました');
}

app.use(express.json());

// ============================
// Auth API (student / teacher)
// ============================
app.post('/api/auth/student/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    const user = verifyStudent(username, password);
    if (!user) {
        return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }
    res.json({ success: true, username: user.displayName, displayName: user.displayName, role: 'student' });
});

app.post('/api/auth/teacher/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    const user = verifyTeacher(username, password);
    if (!user) {
        return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }
    res.json({ success: true, username: user.displayName, displayName: user.displayName, role: 'teacher' });
});

app.post('/api/auth/register/student', (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    try {
        const user = registerStudent(username, password, displayName);
        res.json({ success: true, username: user.username, displayName: user.displayName, role: 'student' });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ success: false, error: 'username_exists' });
        }
        throw e;
    }
});

app.post('/api/auth/register/teacher', (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    try {
        const user = registerTeacher(username, password, displayName);
        res.json({ success: true, username: user.username, displayName: user.displayName, role: 'teacher' });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ success: false, error: 'username_exists' });
        }
        throw e;
    }
});

// Redirect legacy login.html to /login/
app.get('/login.html', (req, res) => {
    res.redirect(301, '/login/');
});

// ログイン画面（常に public から配信；dist に含まれないため。リダイレクトは行わず両パスで同じファイルを返す）
const loginIndexPath = path.join(__dirname, 'public', 'login', 'index.html');
app.get('/login', (req, res) => {
    res.sendFile(loginIndexPath);
});
app.get('/login/', (req, res) => {
    res.sendFile(loginIndexPath);
});

// Serve admin.html with basic auth (before static files; admin.html is always in public)
app.get('/admin.html', basicAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ワールド編集は admin に統合済み。setting.html は admin のワールド編集タブへリダイレクト
app.get('/setting.html', basicAuth, (req, res) => {
    res.redirect(302, '/admin.html?panel=world-edit');
});

// Admin metaverse: /admin でBasic認証必須。別セッションとして管理
app.get('/admin', basicAuth, (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// Apply basic auth to admin API routes
app.use('/admin', basicAuth);

// Serve bootstrap-icons from node_modules (for admin.html etc.)
app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font')));

// /models, /pdfs は常に public から（アップロード先）
app.use('/models', express.static(path.join(__dirname, 'public', 'models')));
app.use('/pdfs', express.static(path.join(__dirname, 'public', 'pdfs')));

// admin.html 用の /js, /css は常に public から（dist に含まれないため）
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

// 静的ファイル（本番時は dist、開発時は public）
app.use(express.static(STATIC_DIR));

// Apply basic auth to admin routes
app.use('/admin.html', basicAuth);
app.use('/admin', basicAuth);

// ============================
// Admin: Metaverse entry token (Basic auth verified admins)
// ============================
const adminTokens = new Map(); // token -> expiry timestamp (ms)
const ADMIN_TOKEN_TTL_MS = 60 * 1000; // 60 seconds

function generateAdminToken() {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
    return token;
}

function consumeAdminToken(token) {
    if (!token || typeof token !== 'string') return false;
    const expiry = adminTokens.get(token);
    if (!expiry || Date.now() >= expiry) {
        if (expiry) adminTokens.delete(token);
        return false;
    }
    adminTokens.delete(token);
    return true;
}

// ============================
// Admin: Log Collection
// ============================
const serverLogs = [];
const MAX_LOGS = 1000;

function logWithStorage(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.join(' ');
    serverLogs.push({ timestamp, level, message });
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }
    console[level](...args);
}

// Wrap console methods
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
    logWithStorage('info', ...args);
    originalLog(...args);
};

console.warn = (...args) => {
    logWithStorage('warn', ...args);
    originalWarn(...args);
};

console.error = (...args) => {
    logWithStorage('error', ...args);
    originalError(...args);
};

// ============================
// Admin: Traffic Statistics
// ============================
const trafficStats = new Map(); // Map<socketId, { bytesReceived, bytesSent, packetsReceived, packetsSent, connectedAt }>
const clientInfo = new Map(); // Map<socketId, { ip, userAgent, browser, os }>

function parseUserAgent(ua) {
    if (!ua || typeof ua !== 'string') return { browser: '-', os: '-' };
    let browser = '-';
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('OPR/') || ua.includes('Opera/')) browser = 'Opera';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    let os = '-';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS') || ua.includes('Macintosh')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone')) os = 'iPhone';
    else if (ua.includes('iPad')) os = 'iPad';
    return { browser, os };
}

function updateTrafficStats(socketId, stats) {
    if (!trafficStats.has(socketId)) {
        trafficStats.set(socketId, {
            bytesReceived: 0,
            bytesSent: 0,
            packetsReceived: 0,
            packetsSent: 0,
            connectedAt: Date.now()
        });
    }
    const current = trafficStats.get(socketId);
    if (stats.bytesReceived !== undefined) current.bytesReceived += stats.bytesReceived;
    if (stats.bytesSent !== undefined) current.bytesSent += stats.bytesSent;
    if (stats.packetsReceived !== undefined) current.packetsReceived += stats.packetsReceived;
    if (stats.packetsSent !== undefined) current.packetsSent += stats.packetsSent;
}

function getTotalTrafficStats() {
    let totalBytesReceived = 0;
    let totalBytesSent = 0;
    let totalPacketsReceived = 0;
    let totalPacketsSent = 0;
    
    trafficStats.forEach(stats => {
        totalBytesReceived += stats.bytesReceived;
        totalBytesSent += stats.bytesSent;
        totalPacketsReceived += stats.packetsReceived;
        totalPacketsSent += stats.packetsSent;
    });
    
    return {
        bytesReceived: totalBytesReceived,
        bytesSent: totalBytesSent,
        packetsReceived: totalPacketsReceived,
        packetsSent: totalPacketsSent
    };
}

/** 前回サンプル（通信レート・CPU用）。admin/stats で更新 */
let lastTrafficSample = null;
let lastCpuUsage = null;
let lastCpuTime = null;

/**
 * サーバー負荷メトリクスを取得（CPU・RAM・1秒あたり通信回数・性能劣化指数）
 */
function getServerLoadMetrics() {
    const now = Date.now();
    const traffic = getTotalTrafficStats();
    const totalPackets = traffic.packetsReceived + traffic.packetsSent;

    let commPerSecond = 0;
    if (lastTrafficSample && lastTrafficSample.ts < now) {
        const elapsedSec = (now - lastTrafficSample.ts) / 1000;
        if (elapsedSec > 0) {
            commPerSecond = (totalPackets - lastTrafficSample.totalPackets) / elapsedSec;
        }
    }
    lastTrafficSample = { totalPackets, packetsReceived: traffic.packetsReceived, packetsSent: traffic.packetsSent, ts: now };

    /** Node プロセスが使った CPU 時間を「全コア合計に対する%」に換算（タスクマネージャーと一致） */
    let cpuUsagePercent = null;
    const numCpus = os.cpus().length;
    if (lastCpuTime !== null && lastCpuUsage !== null && numCpus > 0) {
        const elapsedSec = (now - lastCpuTime) / 1000;
        if (elapsedSec > 0) {
            const delta = process.cpuUsage(lastCpuUsage);
            const oneCorePercent = ((delta.user + delta.system) / 1e6 / elapsedSec) * 100;
            cpuUsagePercent = oneCorePercent / numCpus;
        }
    }
    lastCpuUsage = process.cpuUsage();
    lastCpuTime = now;

    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    const ramUsagePercent = totalMem > 0 ? (usedMem / totalMem) * 100 : null;

    const FPS_BASELINE = 30;
    const degradationIndex = commPerSecond / FPS_BASELINE;

    return { cpuUsagePercent, ramUsagePercent, commPerSecond, degradationIndex };
}

// ============================
// Admin: Chat Log Collection
// ============================
const chatLogs = new Map(); // Map<roomId, Array<{timestamp, senderName, message}>>
const MAX_CHAT_LOGS_PER_ROOM = 500;

function addChatLog(roomId, senderName, message) {
    if (!chatLogs.has(roomId)) {
        chatLogs.set(roomId, []);
    }
    const logs = chatLogs.get(roomId);
    logs.push({
        timestamp: Date.now(),
        senderName: senderName,
        message: message
    });
    // Keep only last MAX_CHAT_LOGS_PER_ROOM entries
    if (logs.length > MAX_CHAT_LOGS_PER_ROOM) {
        logs.shift();
    }
}

function getChatLogs(roomId, limit = 100) {
    if (!chatLogs.has(roomId)) {
        return [];
    }
    const logs = chatLogs.get(roomId);
    return logs.slice(-limit);
}

function getAllChatLogs(limit = 100) {
    const allLogs = [];
    chatLogs.forEach((logs, roomId) => {
        const roomLogs = logs.slice(-limit);
        roomLogs.forEach(log => {
            allLogs.push({
                ...log,
                roomId: roomId
            });
        });
    });
    // Sort by timestamp
    allLogs.sort((a, b) => a.timestamp - b.timestamp);
    return allLogs.slice(-limit);
}

// ============================
// Admin: VC Port Tracking
// ============================
function getVCPortInfo() {
    const ports = new Set();
    const portDetails = [];
    
    vcPeers.forEach((peer, socketId) => {
        if (peer.sendTransport) {
            peer.sendTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'send',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
        if (peer.recvTransport) {
            peer.recvTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'recv',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
    });
    
    return {
        uniquePorts: Array.from(ports).sort((a, b) => a - b),
        portDetails
    };
}

function getPdfVCPortInfo() {
    const ports = new Set();
    const portDetails = [];

    pdfVcPeers.forEach((peer, socketId) => {
        if (peer.sendTransport) {
            peer.sendTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.pdfRoomId,
                        direction: 'send',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
        if (peer.recvTransport) {
            peer.recvTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.pdfRoomId,
                        direction: 'recv',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
    });

    return {
        uniquePorts: Array.from(ports).sort((a, b) => a - b),
        portDetails
    };
}

function getVideoVCPortInfo() {
    const ports = new Set();
    const portDetails = [];

    videoVcPeers.forEach((peer, socketId) => {
        if (peer.sendTransport) {
            peer.sendTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'send',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
        if (peer.recvTransport) {
            peer.recvTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'recv',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
    });

    return {
        uniquePorts: Array.from(ports).sort((a, b) => a - b),
        portDetails
    };
}

// ============================
// mediasoup Worker Initialization
// ============================
async function createWorkers() {
    const numWorkers = Math.min(os.cpus().length, 4); // Max 4 workers
    console.log(`Creating ${numWorkers} mediasoup workers...`);
    
    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            ...mediasoupConfig.worker,
        });
        
        worker.on('died', () => {
            console.error(`mediasoup worker ${worker.pid} died, exiting in 2s...`);
            setTimeout(() => process.exit(1), 2000);
        });
        
        workers.push(worker);
        console.log(`mediasoup worker ${i + 1} created [pid: ${worker.pid}]`);
    }
}

async function createPdfWorkers() {
    const numWorkers = Math.min(os.cpus().length, 4);
    console.log(`Creating ${numWorkers} PDF VC mediasoup workers (ports ${PDF_VC_RTC_MIN_PORT}-${PDF_VC_RTC_MAX_PORT})...`);
    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            ...pdfVcMediasoupConfig.worker,
        });
        worker.on('died', () => {
            console.error(`[PDF VC] mediasoup worker ${worker.pid} died, exiting in 2s...`);
            setTimeout(() => process.exit(1), 2000);
        });
        pdfWorkers.push(worker);
        console.log(`[PDF VC] worker ${i + 1} created [pid: ${worker.pid}]`);
    }
}

function getNextPdfWorker() {
    const w = pdfWorkers[nextPdfWorkerIndex];
    nextPdfWorkerIndex = (nextPdfWorkerIndex + 1) % pdfWorkers.length;
    return w;
}

async function createVideoVcWorkers() {
    const numWorkers = Math.min(os.cpus().length, 4);
    console.log(`Creating ${numWorkers} Video VC mediasoup workers (ports ${VIDEO_VC_RTC_MIN_PORT}-${VIDEO_VC_RTC_MAX_PORT})...`);
    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            ...videoVcMediasoupConfig.worker,
        });
        worker.on('died', () => {
            console.error(`[Video VC] mediasoup worker ${worker.pid} died, exiting in 2s...`);
            setTimeout(() => process.exit(1), 2000);
        });
        videoVcWorkers.push(worker);
        console.log(`[Video VC] worker ${i + 1} created [pid: ${worker.pid}]`);
    }
}

function getNextVideoVcWorker() {
    const w = videoVcWorkers[nextVideoVcWorkerIndex];
    nextVideoVcWorkerIndex = (nextVideoVcWorkerIndex + 1) % videoVcWorkers.length;
    return w;
}

function getNextWorker() {
    const worker = workers[nextWorkerIndex];
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
    return worker;
}

// Get or create mediasoup Router for a room
async function getOrCreateVCRouter(roomId) {
    if (!vcRouters.has(roomId)) {
        const worker = getNextWorker();
        const router = await worker.createRouter({
            mediaCodecs: mediasoupConfig.router.mediaCodecs,
        });
        vcRouters.set(roomId, router);
        console.log(`[VC] Created Router for room: ${roomId}`);
    }
    return vcRouters.get(roomId);
}

async function getOrCreatePdfVCRouter(pdfRoomId) {
    if (!pdfVcRouters.has(pdfRoomId)) {
        const worker = getNextPdfWorker();
        const router = await worker.createRouter({
            mediaCodecs: pdfVcMediasoupConfig.router.mediaCodecs,
        });
        pdfVcRouters.set(pdfRoomId, router);
        console.log(`[PDF VC] Created Router for pdf room: ${pdfRoomId}`);
    }
    return pdfVcRouters.get(pdfRoomId);
}

async function getOrCreateVideoVCRouter(roomId) {
    if (!videoVcRouters.has(roomId)) {
        const worker = getNextVideoVcWorker();
        const router = await worker.createRouter({
            mediaCodecs: videoVcMediasoupConfig.router.mediaCodecs,
        });
        videoVcRouters.set(roomId, router);
        console.log(`[Video VC] Created Router for room: ${roomId}`);
    }
    return videoVcRouters.get(roomId);
}

// Room-based player state storage
// roomStates: Map<roomId, { players: Map<socketId, playerState> }>
const roomStates = new Map();

// Per-player ping (socketId -> { pingMs, reportedAt })
const playerPings = new Map();
const PING_STALE_MS = 15000;

// Helper function to get or create room state
function getRoomState(roomId) {
    if (!roomStates.has(roomId)) {
        roomStates.set(roomId, {
            players: new Map()
        });
        console.log(`Created new room: ${roomId}`);
    }
    return roomStates.get(roomId);
}

// VC: Cleanup peer resources
async function cleanupVCPeer(socketId) {
    const peer = vcPeers.get(socketId);
    if (!peer) return;
    
    console.log(`[VC] Cleaning up peer: ${socketId}`);
    
    // Notify others about producer closure BEFORE closing
    const producerIds = Array.from(peer.producers.keys());
    if (peer.roomId && producerIds.length > 0) {
        for (const producerId of producerIds) {
            io.to(peer.roomId).emit('vc-producer-closed', { producerId });
        }
    }
    
    // Close all producers
    for (const [producerId, producer] of peer.producers) {
        try {
            producer.close();
        } catch (error) {
            console.error(`[VC] Error closing producer ${producerId}:`, error);
        }
    }
    
    // Close all consumers
    for (const [consumerId, consumer] of peer.consumers) {
        try {
            consumer.close();
        } catch (error) {
            console.error(`[VC] Error closing consumer ${consumerId}:`, error);
        }
    }
    
    // Close transports
    if (peer.sendTransport) {
        try {
            peer.sendTransport.close();
        } catch (error) {
            console.error(`[VC] Error closing send transport:`, error);
        }
    }
    if (peer.recvTransport) {
        try {
            peer.recvTransport.close();
        } catch (error) {
            console.error(`[VC] Error closing recv transport:`, error);
        }
    }
    
    vcPeers.delete(socketId);
}

// PDF VC: Cleanup peer resources
async function cleanupPdfVCPeer(socketId) {
    const peer = pdfVcPeers.get(socketId);
    if (!peer) return;

    console.log(`[PDF VC] Cleaning up peer: ${socketId}`);

    const producerIds = Array.from(peer.producers.keys());
    if (peer.pdfRoomId && producerIds.length > 0) {
        for (const producerId of producerIds) {
            io.to(peer.pdfRoomId).emit('pdf-vc-producer-closed', { producerId });
        }
    }

    for (const [producerId, producer] of peer.producers) {
        try { producer.close(); } catch (e) { console.error(`[PDF VC] Error closing producer ${producerId}:`, e); }
    }
    for (const [consumerId, consumer] of peer.consumers) {
        try { consumer.close(); } catch (e) { console.error(`[PDF VC] Error closing consumer ${consumerId}:`, e); }
    }
    if (peer.sendTransport) {
        try { peer.sendTransport.close(); } catch (e) { console.error(`[PDF VC] Error closing send transport:`, e); }
    }
    if (peer.recvTransport) {
        try { peer.recvTransport.close(); } catch (e) { console.error(`[PDF VC] Error closing recv transport:`, e); }
    }

    pdfVcPeers.delete(socketId);
}

// Video VC: Cleanup peer resources
async function cleanupVideoVCPeer(socketId) {
    const peer = videoVcPeers.get(socketId);
    if (!peer) return;

    console.log(`[Video VC] Cleaning up peer: ${socketId}`);

    const producerIds = Array.from(peer.producers.keys());
    if (peer.roomId && producerIds.length > 0) {
        for (const producerId of producerIds) {
            io.to(peer.roomId).emit('video-vc-producer-closed', { producerId });
        }
    }

    for (const [producerId, producer] of peer.producers) {
        try { producer.close(); } catch (e) { console.error(`[Video VC] Error closing producer ${producerId}:`, e); }
    }
    for (const [consumerId, consumer] of peer.consumers) {
        try { consumer.close(); } catch (e) { console.error(`[Video VC] Error closing consumer ${consumerId}:`, e); }
    }
    if (peer.sendTransport) {
        try { peer.sendTransport.close(); } catch (e) { console.error(`[Video VC] Error closing send transport:`, e); }
    }
    if (peer.recvTransport) {
        try { peer.recvTransport.close(); } catch (e) { console.error(`[Video VC] Error closing recv transport:`, e); }
    }

    videoVcPeers.delete(socketId);
}

// Default room for initial connections
const DEFAULT_ROOM = 'lobby';

/** テレポーター利用権限: access とユーザーの実効ロールで利用可否を判定する */
function canUseTeleporter(access, effectiveRole) {
    const role = effectiveRole || 'guest';
    if (access === 'public') return true;
    if (access === 'student+') return role === 'student' || role === 'teacher' || role === 'admin';
    if (access === 'teacher+') return role === 'teacher' || role === 'admin';
    if (access === 'admin') return role === 'admin';
    return true; // 未知の値は許可
}

function getPlayerDisplayName(player) {
    // isAdmin is set at connection and stored in player to avoid socket lookup issues
    return (player.isAdmin === true) ? 'admin' : (player.username || 'Guest');
}

// Socket.io connection handling
io.on('connection', (socket) => {
    // Verify admin token and user role if provided
    const adminToken = socket.handshake.auth?.adminToken;
    if (consumeAdminToken(adminToken)) {
        socket.data.isAdmin = true;
        socket.data.role = 'admin';
        console.log(`Player connected as admin: ${socket.id}`);
    } else {
        socket.data.isAdmin = false;
        const authRole = socket.handshake.auth?.role;
        socket.data.role = (authRole === 'student' || authRole === 'teacher') ? authRole : undefined; // guest は undefined
        console.log(`Player connected: ${socket.id}`);
    }

    // Initialize traffic stats
    trafficStats.set(socket.id, {
        bytesReceived: 0,
        bytesSent: 0,
        packetsReceived: 0,
        packetsSent: 0,
        connectedAt: Date.now()
    });

    // Store client info (IP, User-Agent) for admin player info
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) || socket.handshake.address || '-';
    const ua = socket.handshake.headers['user-agent'] || '';
    const { browser, os } = parseUserAgent(ua);
    clientInfo.set(socket.id, { ip, userAgent: ua, browser, os });
    socket.connectedAt = Date.now();

    // Track traffic (approximate via socket events)
    socket.on('player-update', () => {
        updateTrafficStats(socket.id, { bytesSent: 100, packetsSent: 1 });
    });
    
    socket.on('chat-message', () => {
        updateTrafficStats(socket.id, { bytesSent: 50, packetsSent: 1 });
    });

    // Join default room
    const currentRoom = DEFAULT_ROOM;
    socket.join(currentRoom);
    socket.data.currentRoom = currentRoom;

    // Initialize player data in room state
    const roomState = getRoomState(currentRoom);
    const initialPlayerState = {
        id: socket.id,
        username: 'Guest', // Will be updated when client sends username
        isAdmin: !!socket.data.isAdmin,
        position: { x: 0, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0 }, // Euler angles
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        world: currentRoom,
        timestamp: 0 // Will be updated on first player-update
    };
    roomState.players.set(socket.id, initialPlayerState);

    // Send current players in this room to the new player (with displayName for admin)
    const currentPlayers = Array.from(roomState.players.values()).map(p => ({
        ...p,
        displayName: getPlayerDisplayName(p)
    }));
    socket.emit('current-players', currentPlayers);

    // Notify other players in room about new player
    socket.to(currentRoom).emit('player-joined', initialPlayerState);
    
    console.log(`Player ${socket.id} joined room: ${currentRoom} (${roomState.players.size} players)`);

    // Ping/Pong for latency measurement
    socket.on('ping', (data, callback) => {
        if (typeof callback === 'function') {
            callback({ ts: data?.ts });
        }
    });

    // Client reports its measured RTT (used for per-player ping display)
    socket.on('report-ping', ({ pingMs }) => {
        if (typeof pingMs === 'number' && pingMs >= 0 && pingMs < 10000) {
            playerPings.set(socket.id, { pingMs, reportedAt: Date.now() });
        }
    });

    // Handle username setting
    socket.on('set-username', (username) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) return;

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);

        if (!player || !username || username.trim().length === 0) return;

        const trimmed = username.trim();
        // "admin" は管理者トークン検証済みのみ許可。拒否時はエラーで切断
        if (trimmed.toLowerCase() === 'admin' && !socket.data.isAdmin) {
            socket.emit('username-rejected', {
                error: 'admin_reserved',
                message: '「admin」は管理者専用です。管理者は /admin からBasic認証で入室してください。'
            });
            socket.disconnect(true);
            console.log(`Player ${socket.id} attempted admin name, disconnected`);
            return;
        }

        player.username = trimmed;
        console.log(`Player ${socket.id} set username to: ${player.username}`);

        const info = clientInfo.get(socket.id);
        if (info) {
            insertSession({
                username: trimmed,
                loginTime: socket.connectedAt || Date.now(),
                ip: info.ip || '-',
                browser: info.browser || '-',
                os: info.os || '-'
            });
        }

        const displayName = player.isAdmin ? 'admin' : player.username;

        // Notify other players about the username update
        socket.to(currentRoom).emit('player-username-updated', {
            id: socket.id,
            username: player.username,
            displayName
        });
    });

    // Handle player position updates (Ingress layer with timestamp verification)
    socket.on('player-update', (data) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) {
            console.warn(`Player ${socket.id} sent update but has no room`);
            return;
        }

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);
        
        if (!player) {
            console.warn(`Player ${socket.id} not found in room ${currentRoom}`);
            return;
        }

        // Timestamp verification - discard old data
        const incomingTimestamp = data.timestamp || 0;
        if (incomingTimestamp <= player.timestamp) {
            // Discard outdated data
            return;
        }

        // Update player state with latest data
        if (data.position) {
            player.position = data.position;
        }
        if (data.rotation) {
            player.rotation = data.rotation;
        }
        if (data.quaternion) {
            player.quaternion = data.quaternion;
        }
        player.timestamp = incomingTimestamp;
        player.world = currentRoom;
    });

    // Handle world/room change (callback は Socket.io ack: テレポーター権限拒否時や完了時に使用)
    socket.on('change-world', async (data, callback) => {
        const oldRoom = socket.data.currentRoom;
        const newRoom = data.world || DEFAULT_ROOM;

        if (oldRoom === newRoom) return;

        const teleporterId = data.teleporterId;
        if (teleporterId != null && teleporterId !== '') {
            const effectiveRole = socket.data.isAdmin ? 'admin' : (socket.data.role || 'guest');
            const worlds = readWorlds();
            const worldConfig = worlds[oldRoom];
            let teleporterAccess = 'public';
            if (worldConfig && Array.isArray(worldConfig.models)) {
                for (const m of worldConfig.models) {
                    if (m.teleporter && m.teleporter.id === teleporterId) {
                        teleporterAccess = m.teleporter.access || 'public';
                        break;
                    }
                }
            }
            if (!canUseTeleporter(teleporterAccess, effectiveRole)) {
                if (typeof callback === 'function') callback({ error: 'permission_denied', message: 'このテレポーターは利用権限がありません。' });
                else socket.emit('change-world-rejected', { reason: 'permission_denied', message: 'このテレポーターは利用権限がありません。' });
                return;
            }
        }

        const oldRoomState = oldRoom ? getRoomState(oldRoom) : null;
        const oldPlayerState = oldRoomState ? oldRoomState.players.get(socket.id) : null;
        const username = oldPlayerState ? oldPlayerState.username : 'Guest';

        // Remove from old room
        if (oldRoom) {
            oldRoomState.players.delete(socket.id);
            socket.leave(oldRoom);
            socket.to(oldRoom).emit('player-left', socket.id);
            console.log(`Player ${socket.id} left room: ${oldRoom}`);
        }

        // Add to new room
        socket.join(newRoom);
        socket.data.currentRoom = newRoom;

        const newRoomState = getRoomState(newRoom);
        const playerState = {
            id: socket.id,
            username: username,
            isAdmin: !!socket.data.isAdmin,
            position: { x: 0, y: 2, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            quaternion: { x: 0, y: 0, z: 0, w: 1 },
            world: newRoom,
            timestamp: 0
        };
        newRoomState.players.set(socket.id, playerState);

        // Notify new room
        socket.to(newRoom).emit('player-joined', playerState);
        console.log(`Player ${socket.id} joined room: ${newRoom}`);

        // VC: Cleanup old VC room and update to new room
        await cleanupVCPeer(socket.id);
        socket.emit('vc-room-changed', { roomId: newRoom });

        // Video VC: Cleanup old room and notify client
        await cleanupVideoVCPeer(socket.id);
        socket.emit('video-vc-room-changed', { roomId: newRoom });

        if (typeof callback === 'function') callback();
    });

    // Handle disconnection
    // Handle chat message
    socket.on('chat-message', (message) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) return;

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);
        
        if (!player || !message || message.trim().length === 0) return;

        const chatData = {
            senderId: socket.id,
            senderName: player.username,
            message: message.trim(),
            timestamp: Date.now()
        };

        console.log(`[CHAT] ${player.username}: ${message.trim()}`);

        // Save chat log
        addChatLog(currentRoom, player.username, message.trim());

        // Broadcast to others in room
        socket.to(currentRoom).emit('chat-receive', chatData);
        
        // Echo back to sender
        socket.emit('chat-my-message', chatData);
    });

    // Handle emoji/stamp
    socket.on('send-emoji', (data) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) return;

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);
        
        if (!player || !data || !data.emoji) return;

        console.log(`[EMOJI] ${player.username}: ${data.emoji}`);

        // Broadcast to all in room (including sender)
        io.to(currentRoom).emit('emoji-broadcast', {
            playerId: socket.id,
            playerName: player.username,
            emoji: data.emoji
        });
    });

    // PDF viewer: join/leave room per PDF, broadcast draw
    socket.on('pdf-viewer-open', (pdfPath) => {
        if (pdfPath && typeof pdfPath === 'string') {
            const room = 'pdf:' + pdfPath;
            socket.join(room);
        }
    });
    socket.on('pdf-viewer-close', (pdfPath) => {
        if (pdfPath && typeof pdfPath === 'string') {
            const room = 'pdf:' + pdfPath;
            socket.leave(room);
        }
    });
    socket.on('pdf-draw', ({ pdfPath, points, id, lineWidth }) => {
        if (!pdfPath || !Array.isArray(points) || points.length < 2) return;
        const room = 'pdf:' + pdfPath;
        io.to(room).emit('pdf-draw', { points, id, drawnAt: Date.now(), lineWidth: lineWidth ?? 3 });
    });

    // ============================
    // VC Event Handlers
    // ============================
    
    // VC: Join room
    socket.on('vc-join', async ({ roomId }, callback) => {
        try {
            const router = await getOrCreateVCRouter(roomId);
            
            // Initialize peer state
            if (!vcPeers.has(socket.id)) {
                vcPeers.set(socket.id, {
                    roomId,
                    sendTransport: null,
                    recvTransport: null,
                    producers: new Map(),
                    consumers: new Map(),
                });
            }
            
            console.log(`[VC] ${socket.id} joined VC room: ${roomId}`);
            
            callback({
                rtpCapabilities: router.rtpCapabilities,
                iceServers: await getIceServers(),
            });
        } catch (error) {
            console.error(`[VC] Error joining room:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Create transport
    socket.on('vc-create-transport', async ({ direction }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            const router = await getOrCreateVCRouter(peer.roomId);
            const transport = await router.createWebRtcTransport({
                ...mediasoupConfig.webRtcTransport,
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });
            
            if (direction === 'send') {
                peer.sendTransport = transport;
            } else {
                peer.recvTransport = transport;
            }
            
            // Monitor transport connection state
            transport.on('icestatechange', (iceState) => {
                console.log(`[VC] ${direction} transport ${transport.id} ICE state: ${iceState} (peer: ${socket.id})`);
            });
            
            transport.on('iceselectedtuplechange', (tuple) => {
                console.log(`[VC] ${direction} transport ${transport.id} ICE selected tuple: ${tuple.protocol} ${tuple.ip}:${tuple.port} (peer: ${socket.id})`);
            });
            
            transport.on('dtlsstatechange', (dtlsState) => {
                console.log(`[VC] ${direction} transport ${transport.id} DTLS state: ${dtlsState} (peer: ${socket.id})`);
                if (dtlsState === 'failed' || dtlsState === 'closed') {
                    console.error(`[VC] ❌ ${direction} transport DTLS FAILED for ${socket.id}`);
                }
            });
            
            transport.on('sctpstatechange', (sctpState) => {
                console.log(`[VC] ${direction} transport ${transport.id} SCTP state: ${sctpState} (peer: ${socket.id})`);
            });
            
            console.log(`[VC] Created ${direction} transport for ${socket.id}`, {
                transportId: transport.id,
                iceCandidates: transport.iceCandidates.map(c => `${c.protocol} ${c.ip}:${c.port} (${c.type})`),
            });
            
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            console.error(`[VC] Error creating transport:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Connect transport
    socket.on('vc-connect-transport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            const transport = peer.sendTransport?.id === transportId ? peer.sendTransport : peer.recvTransport;
            if (!transport) {
                throw new Error('Transport not found');
            }
            
            await transport.connect({ dtlsParameters });
            console.log(`[VC] Transport ${transportId} connected for ${socket.id}`);
            
            callback({ success: true });
        } catch (error) {
            console.error(`[VC] Error connecting transport:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Set mic (ON/OFF with max 10 enforcement)
    socket.on('vc-set-mic', async ({ enabled }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            if (enabled) {
                // Check max active producers in room
                const router = await getOrCreateVCRouter(peer.roomId);
                const activeProducers = Array.from(vcPeers.values()).filter(
                    p => p.roomId === peer.roomId && p.producers.size > 0
                ).length;
                
                if (activeProducers >= MAX_ACTIVE_PRODUCERS_PER_ROOM) {
                    console.log(`[VC] Mic denied for ${socket.id}: max ${MAX_ACTIVE_PRODUCERS_PER_ROOM} active`);
                    callback({ 
                        denied: true, 
                        reason: `同時マイクONは最大${MAX_ACTIVE_PRODUCERS_PER_ROOM}人までです` 
                    });
                    return;
                }
                
                callback({ allowed: true });
            } else {
                // Mic OFF: close producer and sendTransport
                if (peer.sendTransport) {
                    // Close all producers
                    for (const [producerId, producer] of peer.producers) {
                        producer.close();
                        peer.producers.delete(producerId);
                        
                        // Notify other peers to remove this producer
                        socket.to(peer.roomId).emit('vc-producer-closed', { producerId });
                    }
                    
                    // Close sendTransport
                    peer.sendTransport.close();
                    peer.sendTransport = null;
                }
                
                console.log(`[VC] Mic OFF for ${socket.id}, sendTransport closed`);
                callback({ success: true });
            }
        } catch (error) {
            console.error(`[VC] Error setting mic:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Produce audio
    socket.on('vc-produce-audio', async ({ transportId, rtpParameters, loopback }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            if (!peer.sendTransport) {
                throw new Error('Send transport not found');
            }
            
            const producer = await peer.sendTransport.produce({
                kind: 'audio',
                rtpParameters,
            });
            
            peer.producers.set(producer.id, producer);
            
            producer.on('transportclose', () => {
                peer.producers.delete(producer.id);
            });
            
            console.log(`[VC] Audio producer created for ${socket.id}: ${producer.id}${loopback ? ' (loopback)' : ''}`);

            if (loopback) {
                // マイクテスト: 自分自身にだけループバック通知（他者には送らない）
                io.to(socket.id).emit('vc-new-producer', {
                    producerId: producer.id,
                    peerId: socket.id,
                });
                console.log(`[VC] → Sent vc-new-producer (loopback) to self`);
            } else {
                // 通常: 他ピアにのみ通知
                const notifiedPeers = [];
                for (const [peerId, peerData] of vcPeers) {
                    if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.recvTransport) {
                        io.to(peerId).emit('vc-new-producer', {
                            producerId: producer.id,
                            peerId: socket.id,
                        });
                        notifiedPeers.push(peerId);
                        console.log(`[VC] → Sent vc-new-producer to ${peerId}`);
                    }
                }
                console.log(`[VC] Notified ${notifiedPeers.length} peers about new producer`);
            }
            
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[VC] Error producing audio:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Set speaker (ON/OFF)
    socket.on('vc-set-speaker', async ({ enabled }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            if (!enabled) {
                // Speaker OFF: close all consumers and recvTransport
                if (peer.recvTransport) {
                    for (const [consumerId, consumer] of peer.consumers) {
                        consumer.close();
                        peer.consumers.delete(consumerId);
                    }
                    
                    peer.recvTransport.close();
                    peer.recvTransport = null;
                }
                
                console.log(`[VC] Speaker OFF for ${socket.id}, recvTransport closed`);
                callback({ success: true });
            } else {
                // Speaker ON: Notify about existing producers in the room
                console.log(`[VC] Speaker ON for ${socket.id}, notifying about existing producers...`);
                
                // Find all existing producers in the same room
                const existingProducers = [];
                for (const [peerId, peerData] of vcPeers) {
                    if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.producers.size > 0) {
                        for (const [producerId, producer] of peerData.producers) {
                            existingProducers.push({ producerId, peerId });
                        }
                    }
                }
                
                console.log(`[VC] Found ${existingProducers.length} existing producers for ${socket.id}`);
                
                // Notify client about existing producers (client will consume after creating recvTransport)
                callback({ 
                    success: true, 
                    existingProducers: existingProducers 
                });
            }
        } catch (error) {
            console.error(`[VC] Error setting speaker:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Consume (create consumer for a producer)
    socket.on('vc-consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            console.log(`[VC] ${socket.id} requested to consume producer: ${producerId}`);
            
            const peer = vcPeers.get(socket.id);
            if (!peer || !peer.recvTransport) {
                console.error(`[VC] Peer or recv transport not found for ${socket.id}`);
                throw new Error('Peer or recv transport not found');
            }
            
            const router = await getOrCreateVCRouter(peer.roomId);
            
            if (!router.canConsume({ producerId, rtpCapabilities })) {
                console.error(`[VC] Cannot consume producer ${producerId} for ${socket.id}`);
                throw new Error('Cannot consume');
            }
            
            console.log(`[VC] Creating consumer for ${socket.id}...`);
            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
            });
            
            peer.consumers.set(consumer.id, consumer);
            
            consumer.on('transportclose', () => {
                console.log(`[VC] Consumer ${consumer.id} transport closed`);
                peer.consumers.delete(consumer.id);
            });
            
            consumer.on('producerclose', () => {
                console.log(`[VC] Consumer ${consumer.id} producer closed`);
                peer.consumers.delete(consumer.id);
                socket.emit('vc-consumer-closed', { consumerId: consumer.id });
            });
            
            console.log(`[VC] ✅ Consumer created for ${socket.id}: ${consumer.id} (kind: ${consumer.kind})`);

            callback({
                consumerId: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            console.error(`[VC] ❌ Error consuming:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Resume consumer
    socket.on('vc-consumer-resume', async ({ consumerId }, callback) => {
        try {
            console.log(`[VC] ${socket.id} requested to resume consumer: ${consumerId}`);
            
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                console.error(`[VC] Peer not found for ${socket.id}`);
                throw new Error('Peer not found');
            }
            
            const consumer = peer.consumers.get(consumerId);
            if (!consumer) {
                console.error(`[VC] Consumer ${consumerId} not found for ${socket.id}`);
                throw new Error('Consumer not found');
            }
            
            await consumer.resume();
            console.log(`[VC] ✅ Consumer resumed: ${consumerId} for ${socket.id}`);
            
            callback({ success: true });
        } catch (error) {
            console.error(`[VC] ❌ Error resuming consumer:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Leave (cleanup)
    socket.on('vc-leave', async (data, callback) => {
        try {
            await cleanupVCPeer(socket.id);
            if (callback) callback({ success: true });
        } catch (error) {
            console.error(`[VC] Error leaving:`, error);
            if (callback) callback({ error: error.message });
        }
    });

    // ============================
    // PDF VC Event Handlers
    // ============================
    socket.on('pdf-vc-join', async ({ pdfPath }, callback) => {
        try {
            if (!pdfPath || typeof pdfPath !== 'string') {
                callback({ error: 'pdfPath required' });
                return;
            }
            const pdfRoomId = 'pdf:' + pdfPath;
            const router = await getOrCreatePdfVCRouter(pdfRoomId);

            if (pdfVcPeers.has(socket.id)) {
                await cleanupPdfVCPeer(socket.id);
            }
            pdfVcPeers.set(socket.id, {
                pdfRoomId,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map(),
            });

            console.log(`[PDF VC] ${socket.id} joined pdf VC room: ${pdfRoomId}`);
            callback({
                rtpCapabilities: router.rtpCapabilities,
                iceServers: await getIceServers(),
            });
        } catch (error) {
            console.error(`[PDF VC] Error joining:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-create-transport', async ({ direction }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            const router = await getOrCreatePdfVCRouter(peer.pdfRoomId);
            const transport = await router.createWebRtcTransport({
                ...pdfVcMediasoupConfig.webRtcTransport,
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });

            if (direction === 'send') peer.sendTransport = transport;
            else peer.recvTransport = transport;

            transport.on('icestatechange', (iceState) => {
                console.log(`[PDF VC] ${direction} transport ${transport.id} ICE state: ${iceState} (peer: ${socket.id})`);
            });
            transport.on('dtlsstatechange', (dtlsState) => {
                if (dtlsState === 'failed' || dtlsState === 'closed') {
                    console.error(`[PDF VC] ${direction} transport DTLS failed for ${socket.id}`);
                }
            });

            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            console.error(`[PDF VC] Error creating transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-connect-transport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const transport = peer.sendTransport?.id === transportId ? peer.sendTransport : peer.recvTransport;
            if (!transport) throw new Error('Transport not found');
            await transport.connect({ dtlsParameters });
            console.log(`[PDF VC] Transport ${transportId} connected for ${socket.id}`);
            callback({ success: true });
        } catch (error) {
            console.error(`[PDF VC] Error connecting transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-set-mic', async ({ enabled }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (enabled) {
                const activeProducers = Array.from(pdfVcPeers.values()).filter(
                    p => p.pdfRoomId === peer.pdfRoomId && p.producers.size > 0
                ).length;
                if (activeProducers >= MAX_ACTIVE_PRODUCERS_PER_ROOM) {
                    callback({ denied: true, reason: `同時マイクONは最大${MAX_ACTIVE_PRODUCERS_PER_ROOM}人までです` });
                    return;
                }
                callback({ allowed: true });
            } else {
                if (peer.sendTransport) {
                    for (const [producerId, producer] of peer.producers) {
                        producer.close();
                        peer.producers.delete(producerId);
                        io.to(peer.pdfRoomId).emit('pdf-vc-producer-closed', { producerId });
                    }
                    peer.sendTransport.close();
                    peer.sendTransport = null;
                }
                callback({ success: true });
            }
        } catch (error) {
            console.error(`[PDF VC] Error setting mic:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-produce-audio', async ({ transportId, rtpParameters }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            if (!peer.sendTransport) throw new Error('Send transport not found');

            const producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters });
            peer.producers.set(producer.id, producer);
            producer.on('transportclose', () => peer.producers.delete(producer.id));

            for (const [peerId, peerData] of pdfVcPeers) {
                if (peerId !== socket.id && peerData.pdfRoomId === peer.pdfRoomId && peerData.recvTransport) {
                    io.to(peerId).emit('pdf-vc-new-producer', { producerId: producer.id, peerId: socket.id });
                }
            }
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[PDF VC] Error producing audio:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-set-speaker', async ({ enabled }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (!enabled) {
                if (peer.recvTransport) {
                    for (const [consumerId, consumer] of peer.consumers) {
                        consumer.close();
                        peer.consumers.delete(consumerId);
                    }
                    peer.recvTransport.close();
                    peer.recvTransport = null;
                }
                callback({ success: true });
            } else {
                const existingProducers = [];
                for (const [peerId, peerData] of pdfVcPeers) {
                    if (peerId !== socket.id && peerData.pdfRoomId === peer.pdfRoomId && peerData.producers.size > 0) {
                        for (const [producerId] of peerData.producers) {
                            existingProducers.push({ producerId, peerId });
                        }
                    }
                }
                callback({ success: true, existingProducers });
            }
        } catch (error) {
            console.error(`[PDF VC] Error setting speaker:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer || !peer.recvTransport) throw new Error('Peer or recv transport not found');

            const router = await getOrCreatePdfVCRouter(peer.pdfRoomId);
            if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume');

            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
            });
            peer.consumers.set(consumer.id, consumer);
            consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
            consumer.on('producerclose', () => {
                peer.consumers.delete(consumer.id);
                socket.emit('pdf-vc-consumer-closed', { consumerId: consumer.id });
            });

            callback({
                consumerId: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            console.error(`[PDF VC] Error consuming:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-consumer-resume', async ({ consumerId }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const consumer = peer.consumers.get(consumerId);
            if (!consumer) throw new Error('Consumer not found');
            await consumer.resume();
            callback({ success: true });
        } catch (error) {
            console.error(`[PDF VC] Error resuming consumer:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-leave', async (data, callback) => {
        try {
            await cleanupPdfVCPeer(socket.id);
            if (callback) callback({ success: true });
        } catch (error) {
            console.error(`[PDF VC] Error leaving:`, error);
            if (callback) callback({ error: error.message });
        }
    });

    // ============================
    // Video VC Event Handlers
    // ============================
    socket.on('video-vc-join', async ({ roomId }, callback) => {
        try {
            const room = roomId || socket.data.currentRoom || DEFAULT_ROOM;
            const router = await getOrCreateVideoVCRouter(room);

            if (videoVcPeers.has(socket.id)) {
                await cleanupVideoVCPeer(socket.id);
            }
            videoVcPeers.set(socket.id, {
                roomId: room,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map(),
            });

            console.log(`[Video VC] ${socket.id} joined room: ${room}`);
            callback({
                rtpCapabilities: router.rtpCapabilities,
                iceServers: await getIceServers(),
            });
        } catch (error) {
            console.error(`[Video VC] Error joining:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-create-transport', async ({ direction }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            const router = await getOrCreateVideoVCRouter(peer.roomId);
            const transport = await router.createWebRtcTransport({
                ...videoVcMediasoupConfig.webRtcTransport,
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });

            if (direction === 'send') peer.sendTransport = transport;
            else peer.recvTransport = transport;

            transport.on('icestatechange', (iceState) => {
                console.log(`[Video VC] ${direction} transport ${transport.id} ICE state: ${iceState} (peer: ${socket.id})`);
            });
            transport.on('dtlsstatechange', (dtlsState) => {
                if (dtlsState === 'failed' || dtlsState === 'closed') {
                    console.error(`[Video VC] ${direction} transport DTLS failed for ${socket.id}`);
                }
            });

            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            console.error(`[Video VC] Error creating transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-connect-transport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const transport = peer.sendTransport?.id === transportId ? peer.sendTransport : peer.recvTransport;
            if (!transport) throw new Error('Transport not found');
            await transport.connect({ dtlsParameters });
            console.log(`[Video VC] Transport ${transportId} connected for ${socket.id}`);
            callback({ success: true });
        } catch (error) {
            console.error(`[Video VC] Error connecting transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-set-video', async ({ enabled }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (enabled) {
                const activeProducers = Array.from(videoVcPeers.values()).filter(
                    p => p.roomId === peer.roomId && p.producers.size > 0
                ).length;
                if (activeProducers >= VIDEO_VC_MAX_PRODUCERS_PER_ROOM) {
                    callback({ denied: true, reason: `同時ビデオONは最大${VIDEO_VC_MAX_PRODUCERS_PER_ROOM}人までです` });
                    return;
                }
                callback({ allowed: true });
            } else {
                if (peer.sendTransport) {
                    for (const [producerId, producer] of peer.producers) {
                        producer.close();
                        peer.producers.delete(producerId);
                        io.to(peer.roomId).emit('video-vc-producer-closed', { producerId });
                    }
                    peer.sendTransport.close();
                    peer.sendTransport = null;
                }
                callback({ success: true });
            }
        } catch (error) {
            console.error(`[Video VC] Error setting video:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-produce-video', async ({ transportId, rtpParameters }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            if (!peer.sendTransport) throw new Error('Send transport not found');

            const producer = await peer.sendTransport.produce({ kind: 'video', rtpParameters });
            peer.producers.set(producer.id, producer);
            producer.on('transportclose', () => peer.producers.delete(producer.id));

            for (const [peerId, peerData] of videoVcPeers) {
                if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.recvTransport) {
                    io.to(peerId).emit('video-vc-new-producer', { producerId: producer.id, peerId: socket.id, kind: 'video' });
                }
            }
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[Video VC] Error producing video:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-produce-audio', async ({ transportId, rtpParameters }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            if (!peer.sendTransport) throw new Error('Send transport not found');

            const producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters });
            peer.producers.set(producer.id, producer);
            producer.on('transportclose', () => peer.producers.delete(producer.id));

            for (const [peerId, peerData] of videoVcPeers) {
                if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.recvTransport) {
                    io.to(peerId).emit('video-vc-new-producer', { producerId: producer.id, peerId: socket.id, kind: 'audio' });
                }
            }
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[Video VC] Error producing audio:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-set-recv', async ({ enabled }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (!enabled) {
                if (peer.recvTransport) {
                    for (const [consumerId, consumer] of peer.consumers) {
                        consumer.close();
                        peer.consumers.delete(consumerId);
                    }
                    peer.recvTransport.close();
                    peer.recvTransport = null;
                }
                callback({ success: true });
            } else {
                const existingProducers = [];
                for (const [peerId, peerData] of videoVcPeers) {
                    if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.producers.size > 0) {
                        for (const [producerId, producer] of peerData.producers) {
                            existingProducers.push({ producerId, peerId, kind: producer.kind });
                        }
                    }
                }
                callback({ success: true, existingProducers });
            }
        } catch (error) {
            console.error(`[Video VC] Error setting recv:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer || !peer.recvTransport) throw new Error('Peer or recv transport not found');

            const router = await getOrCreateVideoVCRouter(peer.roomId);
            if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume');

            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
            });
            peer.consumers.set(consumer.id, consumer);
            consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
            consumer.on('producerclose', () => {
                peer.consumers.delete(consumer.id);
                socket.emit('video-vc-consumer-closed', { consumerId: consumer.id });
            });

            callback({
                consumerId: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            console.error(`[Video VC] Error consuming:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-consumer-resume', async ({ consumerId }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const consumer = peer.consumers.get(consumerId);
            if (!consumer) throw new Error('Consumer not found');
            await consumer.resume();
            callback({ success: true });
        } catch (error) {
            console.error(`[Video VC] Error resuming consumer:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-leave', async (data, callback) => {
        try {
            await cleanupVideoVCPeer(socket.id);
            if (callback) callback({ success: true });
        } catch (error) {
            console.error(`[Video VC] Error leaving:`, error);
            if (callback) callback({ error: error.message });
        }
    });

    socket.on('disconnect', async () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        const currentRoom = socket.data.currentRoom;
        if (currentRoom) {
            const roomState = getRoomState(currentRoom);
            roomState.players.delete(socket.id);
            
            // Notify room members
            socket.to(currentRoom).emit('player-left', socket.id);
            
            console.log(`Player ${socket.id} removed from room: ${currentRoom}`);
        }
        
        // Cleanup VC peer, PDF VC peer, and Video VC peer
        await cleanupVCPeer(socket.id);
        await cleanupPdfVCPeer(socket.id);
        await cleanupVideoVCPeer(socket.id);

        // Cleanup traffic stats, ping, client info
        trafficStats.delete(socket.id);
        playerPings.delete(socket.id);
        clientInfo.delete(socket.id);
    });
    
    // ============================
    // Admin: Socket.io Events
    // ============================

    // Admin get player info (for click on avatar in metaverse)
    socket.on('admin-get-player-info', (data, callback) => {
        if (!socket.data.isAdmin || !callback || typeof callback !== 'function') return;
        const { targetSocketId } = data || {};
        if (!targetSocketId) return callback({ error: 'targetSocketId required' });

        const currentRoom = socket.data.currentRoom;
        const roomState = currentRoom ? getRoomState(currentRoom) : null;
        const player = roomState?.players?.get(targetSocketId);
        if (!player || player.world !== currentRoom) return callback({ error: 'Player not found' });

        const stats = trafficStats.get(targetSocketId);
        const pingData = playerPings.get(targetSocketId);
        const info = clientInfo.get(targetSocketId);
        const now = Date.now();
        const pingMs = (pingData && (now - pingData.reportedAt) < PING_STALE_MS) ? pingData.pingMs : null;

        callback({
            username: player.username,
            displayName: player.isAdmin ? 'admin' : player.username,
            connectedAt: stats?.connectedAt || null,
            pingMs,
            ip: info?.ip || '-',
            browser: info?.browser || '-',
            os: info?.os || '-'
        });
    });
    
    // Admin kick player
    socket.on('admin-kick-player', ({ targetSocketId }) => {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            // Send kick notification before disconnecting
            targetSocket.emit('admin-kicked', { message: '管理者によってキックされました。' });
            // Small delay to ensure message is sent before disconnect
            setTimeout(() => {
                targetSocket.disconnect(true);
            }, 100);
            console.log(`[ADMIN] Player ${targetSocketId} kicked by admin`);
        }
    });
    
    // Admin mute mic
    socket.on('admin-mute-mic', async ({ targetSocketId }) => {
        const peer = vcPeers.get(targetSocketId);
        if (peer && peer.sendTransport) {
            // Close all producers
            for (const [producerId, producer] of peer.producers) {
                producer.close();
                peer.producers.delete(producerId);
                io.to(peer.roomId).emit('vc-producer-closed', { producerId });
            }
            // Close sendTransport
            peer.sendTransport.close();
            peer.sendTransport = null;
            console.log(`[ADMIN] Mic muted for player ${targetSocketId}`);
        }
    });
    
    // Admin send alert
    socket.on('admin-send-alert', ({ targetSocketId, message }) => {
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket && message) {
            targetSocket.emit('admin-alert', { message });
            console.log(`[ADMIN] Alert sent to player ${targetSocketId}: ${message}`);
        }
    });
});

// Server tick - broadcast player snapshots at 30fps (33ms interval) per room
setInterval(() => {
    const tickTimestamp = Date.now();
    
    // Iterate through all rooms
    roomStates.forEach((roomState, roomId) => {
        // Skip empty rooms
        if (roomState.players.size === 0) return;
        
        // Create snapshot for this room (include vcMicOn, vcSpeakerOn, pingMs for player list)
        const now = Date.now();
        const playersArray = Array.from(roomState.players.values()).map(player => {
            const vcPeer = vcPeers.get(player.id);
            const videoVcPeer = videoVcPeers.get(player.id);
            const vcMicOn = !!(vcPeer && vcPeer.sendTransport);
            const vcSpeakerOn = !!(vcPeer && vcPeer.recvTransport);
            const vcVideoOn = !!(videoVcPeer && videoVcPeer.sendTransport);
            const pingData = playerPings.get(player.id);
            const pingMs = (pingData && (now - pingData.reportedAt) < PING_STALE_MS) ? pingData.pingMs : null;
            const socket = io.sockets.sockets.get(player.id);
            const role = socket?.data?.role || null;
            return {
                id: player.id,
                username: player.username,
                displayName: getPlayerDisplayName(player),
                position: player.position,
                rotation: player.rotation,
                quaternion: player.quaternion,
                world: player.world,
                vcMicOn,
                vcSpeakerOn,
                vcVideoOn,
                pingMs,
                role
            };
        });
        
        const snapshot = {
            timestamp: tickTimestamp,
            players: playersArray
        };
        
        // Broadcast to all players in this room
        io.to(roomId).emit('players-update', snapshot);
    });
}, 33);

// ============================
// Admin: API Endpoints
// ============================
app.get('/admin/enter-metaverse', (req, res) => {
    const token = generateAdminToken();
    res.json({ token, username: 'admin' });
});

app.get('/admin/worlds', (req, res) => {
    try {
        const worlds = readWorlds();
        res.json(worlds);
    } catch (err) {
        console.error('GET /admin/worlds error:', err);
        res.status(500).json({ error: 'Failed to read worlds' });
    }
});

app.post('/admin/worlds', (req, res) => {
    const worlds = req.body;
    if (!worlds || typeof worlds !== 'object') {
        return res.status(400).json({ error: 'Invalid body: expected worlds object' });
    }
    try {
        writeWorlds(worlds);
        res.json({ success: true });
    } catch (err) {
        console.error('POST /admin/worlds error:', err);
        res.status(500).json({ error: 'Failed to save worlds' });
    }
});

app.get('/admin/models', (req, res) => {
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            return res.json([]);
        }
        const names = fs.readdirSync(MODELS_DIR)
            .filter((n) => n.toLowerCase().endsWith('.glb'));
        res.json(names);
    } catch (err) {
        console.error('GET /admin/models error:', err);
        res.status(500).json({ error: 'Failed to list models' });
    }
});

app.post('/admin/upload', upload.single('model'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file or invalid file' });
    }
    const filename = path.basename(req.file.originalname);
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.glb') {
        return res.status(400).json({ error: 'Only .glb files are allowed' });
    }
    const destPath = path.join(MODELS_DIR, filename);
    if (fs.existsSync(destPath) && req.query.confirm !== '1') {
        return res.status(409).json({ error: 'file_exists', filename });
    }
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            fs.mkdirSync(MODELS_DIR, { recursive: true });
        }
        fs.writeFileSync(destPath, req.file.buffer);
        res.json({ success: true, filename });
    } catch (err) {
        console.error('POST /admin/upload error:', err);
        res.status(500).json({ error: 'Failed to save file' });
    }
});

app.get('/admin/pdfs', (req, res) => {
    try {
        if (!fs.existsSync(PDFS_DIR)) {
            return res.json([]);
        }
        const names = fs.readdirSync(PDFS_DIR)
            .filter((n) => n.toLowerCase().endsWith('.pdf'));
        res.json(names);
    } catch (err) {
        console.error('GET /admin/pdfs error:', err);
        res.status(500).json({ error: 'Failed to list PDFs' });
    }
});

app.post('/admin/upload-pdf', uploadPdf.single('pdf'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file or invalid file' });
    }
    // クライアントから UTF-8 で送ったファイル名を使う（originalname はマルチパートで文字化けすることがある）
    let filename;
    if (req.body && typeof req.body.filename_b64 === 'string') {
        try {
            filename = Buffer.from(req.body.filename_b64, 'base64').toString('utf8');
        } catch (_) {
            filename = req.file.originalname;
        }
    } else {
        filename = req.file.originalname;
    }
    filename = path.basename(filename).replace(/[/\\]/g, '');
    if (!filename.toLowerCase().endsWith('.pdf')) {
        filename = filename + '.pdf';
    }
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.pdf') {
        return res.status(400).json({ error: 'Only .pdf files are allowed' });
    }
    const destPath = path.join(PDFS_DIR, filename);
    if (fs.existsSync(destPath) && req.query.confirm !== '1') {
        return res.status(409).json({ error: 'file_exists', filename });
    }
    try {
        if (!fs.existsSync(PDFS_DIR)) {
            fs.mkdirSync(PDFS_DIR, { recursive: true });
        }
        fs.writeFileSync(destPath, req.file.buffer);
        res.json({ success: true, filename });
    } catch (err) {
        console.error('POST /admin/upload-pdf error:', err);
        res.status(500).json({ error: 'Failed to save file' });
    }
});

// Public read-only worlds (for main app index.html)
app.get('/api/worlds', (req, res) => {
    try {
        const worlds = readWorlds();
        res.json(worlds);
    } catch (err) {
        console.error('GET /api/worlds error:', err);
        res.status(500).json({ error: 'Failed to read worlds' });
    }
});

app.get('/admin/stats', (req, res) => {
    let totalPlayers = 0;
    roomStates.forEach(roomState => {
        totalPlayers += roomState.players.size;
    });
    
    const traffic = getTotalTrafficStats();
    const loadMetrics = getServerLoadMetrics();
    const vcPortInfo = getVCPortInfo();
    const pdfVcPortInfo = getPdfVCPortInfo();
    const videoVcPortInfo = getVideoVCPortInfo();

    res.json({
        totalPlayers,
        totalRooms: roomStates.size,
        activeVCRooms: vcRouters.size,
        activeVCPeers: vcPeers.size,
        cpuUsagePercent: loadMetrics.cpuUsagePercent,
        ramUsagePercent: loadMetrics.ramUsagePercent,
        commPerSecond: loadMetrics.commPerSecond,
        degradationIndex: loadMetrics.degradationIndex,
        bandwidthLimitBps: BANDWIDTH_LIMIT_BPS,
        bandwidthLimitMbps: BANDWIDTH_LIMIT_MBPS,
        traffic: {
            bytesReceived: traffic.bytesReceived,
            bytesSent: traffic.bytesSent,
            packetsReceived: traffic.packetsReceived,
            packetsSent: traffic.packetsSent,
            bytesReceivedFormatted: formatBytes(traffic.bytesReceived),
            bytesSentFormatted: formatBytes(traffic.bytesSent)
        },
        vcPorts: {
            uniquePorts: vcPortInfo.uniquePorts,
            portCount: vcPortInfo.uniquePorts.length,
            portDetails: vcPortInfo.portDetails
        },
        pdfVcPorts: {
            uniquePorts: pdfVcPortInfo.uniquePorts,
            portCount: pdfVcPortInfo.uniquePorts.length,
            portDetails: pdfVcPortInfo.portDetails
        },
        videoVcPorts: {
            uniquePorts: videoVcPortInfo.uniquePorts,
            portCount: videoVcPortInfo.uniquePorts.length,
            portDetails: videoVcPortInfo.portDetails
        },
        workers: workers.length
    });
});

app.get('/admin/players', (req, res) => {
    const players = [];
    
    const now = Date.now();
    roomStates.forEach((roomState, roomId) => {
        roomState.players.forEach((player, socketId) => {
            const stats = trafficStats.get(socketId);
            const peer = vcPeers.get(socketId);
            const connectedAt = stats ? stats.connectedAt : Date.now();
            const connectedDuration = Date.now() - connectedAt;
            const pingData = playerPings.get(socketId);
            const pingMs = (pingData && (now - pingData.reportedAt) < PING_STALE_MS) ? pingData.pingMs : null;

            const socket = io.sockets.sockets.get(player.id);
            const role = socket?.data?.role || null;

            players.push({
                socketId: player.id,
                username: player.username,
                room: roomId,
                world: player.world,
                position: player.position,
                role,
                connectedAt: new Date(connectedAt).toISOString(),
                connectedDuration: Math.floor(connectedDuration / 1000), // seconds
                hasVC: !!peer,
                vcMicOn: !!(peer && peer.sendTransport),
                vcSpeakerOn: !!(peer && peer.recvTransport),
                pingMs,
                traffic: stats ? {
                    bytesReceived: stats.bytesReceived,
                    bytesSent: stats.bytesSent,
                    packetsReceived: stats.packetsReceived,
                    packetsSent: stats.packetsSent
                } : null
            });
        });
    });
    
    res.json(players);
});

app.post('/admin/kick', (req, res) => {
    const { socketId } = req.body;
    if (!socketId) {
        return res.status(400).json({ error: 'socketId is required' });
    }
    
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
        // Send kick notification before disconnecting
        targetSocket.emit('admin-kicked', { message: '管理者によってキックされました。' });
        // Small delay to ensure message is sent before disconnect
        setTimeout(() => {
            targetSocket.disconnect(true);
        }, 100);
        res.json({ success: true, message: `Player ${socketId} kicked` });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

app.post('/admin/mute-mic', async (req, res) => {
    const { socketId } = req.body;
    if (!socketId) {
        return res.status(400).json({ error: 'socketId is required' });
    }
    
    const peer = vcPeers.get(socketId);
    if (peer && peer.sendTransport) {
        // Close all producers
        for (const [producerId, producer] of peer.producers) {
            producer.close();
            peer.producers.delete(producerId);
            io.to(peer.roomId).emit('vc-producer-closed', { producerId });
        }
        // Close sendTransport
        peer.sendTransport.close();
        peer.sendTransport = null;
        res.json({ success: true, message: `Mic muted for player ${socketId}` });
    } else {
        res.status(404).json({ error: 'Player not found or mic not active' });
    }
});

app.post('/admin/send-alert', (req, res) => {
    const { socketId, message } = req.body;
    if (!socketId || !message) {
        return res.status(400).json({ error: 'socketId and message are required' });
    }
    
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
        targetSocket.emit('admin-alert', { message });
        res.json({ success: true, message: `Alert sent to player ${socketId}` });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

/** セレクター (@a / @ユーザー名 / @SocketID) から対象ソケットの配列を返す。無効な場合は null。 */
function getTargetsForSelector(selector) {
    if (!selector || !selector.startsWith('@')) return null;
    const getUsernameForSocket = (s) => {
        const room = s.data.currentRoom;
        if (!room) return 'Guest';
        const roomState = getRoomState(room);
        const player = roomState?.players.get(s.id);
        return player?.username || 'Guest';
    };
    if (selector === '@a') {
        return Array.from(io.sockets.sockets.values());
    }
    const value = selector.slice(1);
    const byId = io.sockets.sockets.get(value);
    if (byId) return [byId];
    const targets = [];
    for (const s of io.sockets.sockets.values()) {
        if (getUsernameForSocket(s) === value) targets.push(s);
    }
    return targets;
}

// Admin: Command execution (e.g. tp @a world x y z, tell @a message)
app.post('/admin/command', async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ success: false, error: 'コマンドを入力してください' });
    }
    logWithStorage('info', '> ' + command);
    const parts = command.trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    if (cmd === 'tp') {
        if (parts.length < 6) {
            logWithStorage('error', '使い方: tp [@a|@ユーザー名|@SocketID] (ワールド名) (x) (y) (z)');
            return res.json({ success: false, error: '使い方: tp [@a|@ユーザー名|@SocketID] (ワールド名) (x) (y) (z)' });
        }
        const selector = parts[1];
        const worldId = parts[2];
        const x = parseFloat(parts[3]);
        const y = parseFloat(parts[4]);
        const z = parseFloat(parts[5]);
        if (isNaN(x) || isNaN(y) || isNaN(z)) {
            logWithStorage('error', '座標は数値で指定してください');
            return res.json({ success: false, error: '座標は数値で指定してください' });
        }
        const targets = getTargetsForSelector(selector);
        if (!targets) {
            logWithStorage('error', 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください');
            return res.json({ success: false, error: 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください' });
        }
        if (targets.length === 0) {
            logWithStorage('error', '対象のプレイヤーがいません');
            return res.json({ success: false, error: '対象のプレイヤーがいません' });
        }
        const worlds = readWorlds();
        if (!worlds[worldId]) {
            const err = `ワールド "${worldId}" は存在しません`;
            logWithStorage('error', err);
            return res.json({ success: false, error: err });
        }
        const position = { x, y, z };
        const teleportedNames = [];
        for (const targetSocket of targets) {
            const targetSocketId = targetSocket.id;
            const oldRoom = targetSocket.data.currentRoom;
            const newRoom = worldId;
            if (oldRoom !== newRoom) {
                const oldRoomState = getRoomState(oldRoom);
                const oldPlayer = oldRoomState.players.get(targetSocketId);
                oldRoomState.players.delete(targetSocketId);
                targetSocket.leave(oldRoom);
                io.to(oldRoom).emit('player-left', targetSocketId);
                targetSocket.join(newRoom);
                targetSocket.data.currentRoom = newRoom;
                const newRoomState = getRoomState(newRoom);
                const playerState = {
                    id: targetSocketId,
                    username: oldPlayer ? oldPlayer.username : 'Guest',
                    position,
                    rotation: { x: 0, y: 0, z: 0 },
                    quaternion: { x: 0, y: 0, z: 0, w: 1 },
                    world: newRoom,
                    timestamp: 0
                };
                newRoomState.players.set(targetSocketId, playerState);
                io.to(newRoom).emit('player-joined', playerState);
                await cleanupVCPeer(targetSocketId);
                targetSocket.emit('vc-room-changed', { roomId: newRoom });
                await cleanupVideoVCPeer(targetSocketId);
                targetSocket.emit('video-vc-room-changed', { roomId: newRoom });
            } else {
                const roomState = getRoomState(newRoom);
                const player = roomState.players.get(targetSocketId);
                if (player) player.position = position;
            }
            targetSocket.emit('admin-tp', { world: worldId, position });
            const roomState = getRoomState(targetSocket.data.currentRoom);
            const name = roomState?.players.get(targetSocketId)?.username || targetSocketId;
            teleportedNames.push(name);
            console.log(`[ADMIN] tp: ${targetSocketId} -> ${worldId} (${x}, ${y}, ${z})`);
        }
        const tpMsg = `${teleportedNames.join(', ')} を ${worldId} (${x}, ${y}, ${z}) へテレポートしました`;
        logWithStorage('info', tpMsg);
        res.json({ success: true, message: tpMsg });
    } else if (cmd === 'tell') {
        if (parts.length < 3) {
            logWithStorage('error', '使い方: tell [@a|@ユーザー名|@SocketID] [内容文]');
            return res.json({ success: false, error: '使い方: tell [@a|@ユーザー名|@SocketID] [内容文]' });
        }
        const selector = parts[1];
        const message = parts.slice(2).join(' ');
        if (!message) {
            logWithStorage('error', '内容文を入力してください');
            return res.json({ success: false, error: '内容文を入力してください' });
        }
        const targets = getTargetsForSelector(selector);
        if (!targets) {
            logWithStorage('error', 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください');
            return res.json({ success: false, error: 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください' });
        }
        for (const s of targets) {
            s.emit('admin-alert', { message });
        }
        const tellMsg = `${targets.length} 人にメッセージを送信しました`;
        logWithStorage('info', tellMsg);
        res.json({ success: true, message: tellMsg });
    } else if (cmd === 'ban') {
        if (parts.length < 2) {
            logWithStorage('error', '使い方: ban [@a|@ユーザー名|@SocketID] [reason]');
            return res.json({ success: false, error: '使い方: ban [@a|@ユーザー名|@SocketID] [reason]' });
        }
        const selector = parts[1];
        const reason = parts.slice(2).join(' ').trim() || '管理者によってBANされました。';
        const targets = getTargetsForSelector(selector);
        if (!targets) {
            logWithStorage('error', 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください');
            return res.json({ success: false, error: 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください' });
        }
        if (targets.length === 0) {
            logWithStorage('error', '対象のプレイヤーがいません');
            return res.json({ success: false, error: '対象のプレイヤーがいません' });
        }
        const getUsernameForSocket = (s) => {
            const room = s.data.currentRoom;
            if (!room) return 'Guest';
            const roomState = getRoomState(room);
            const player = roomState?.players.get(s.id);
            return player?.username || 'Guest';
        };
        const kickedNames = [];
        for (const s of targets) {
            kickedNames.push(getUsernameForSocket(s));
            s.emit('admin-kicked', { message: reason });
            setTimeout(() => s.disconnect(true), 100);
            console.log(`[ADMIN] Ban (kick): ${s.id}, reason: ${reason}`);
        }
        const banMsg = `${kickedNames.join(', ')} をBANしました`;
        logWithStorage('info', banMsg);
        res.json({ success: true, message: banMsg });
    } else {
        const err = `不明なコマンド: ${cmd}`;
        logWithStorage('error', err);
        res.json({ success: false, error: err });
    }
});

app.get('/admin/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = serverLogs.slice(-limit);
    res.json(logs);
});

app.get('/admin/chat-logs', (req, res) => {
    const roomId = req.query.room;
    const limit = parseInt(req.query.limit) || 100;

    let logs;
    if (roomId) {
        logs = getChatLogs(roomId, limit);
    } else {
        logs = getAllChatLogs(limit);
    }

    res.json(logs);
});

app.get('/admin/user-sessions', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 50));
        const { sessions, total } = getSessionsPaginated(page, limit);
        res.json({ sessions, total });
    } catch (err) {
        console.error('GET /admin/user-sessions error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/user-sessions/by-username/:username', (req, res) => {
    try {
        const username = req.params.username;
        if (!username) return res.status(400).json({ error: 'username required' });
        const session = getLatestSessionByUsername(username);
        res.json(session || {});
    } catch (err) {
        console.error('GET /admin/user-sessions/by-username error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Admin: User management (students / teachers)
app.get('/admin/users/students', (req, res) => {
    try {
        res.json(listStudents());
    } catch (err) {
        console.error('GET /admin/users/students error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/users/teachers', (req, res) => {
    try {
        res.json(listTeachers());
    } catch (err) {
        console.error('GET /admin/users/teachers error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/users/student', (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
    }
    try {
        const user = registerStudent(username, password, displayName);
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/users/teacher', (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
    }
    try {
        const user = registerTeacher(username, password, displayName);
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.put('/admin/users/student/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { username, displayName, password } = req.body || {};
    try {
        const user = updateStudent(id, { username, displayName, password });
        if (!user) return res.status(404).json({ error: 'not_found' });
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.put('/admin/users/teacher/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { username, displayName, password } = req.body || {};
    try {
        const user = updateTeacher(id, { username, displayName, password });
        if (!user) return res.status(404).json({ error: 'not_found' });
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.delete('/admin/users/student/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const ok = deleteStudent(id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true });
});

app.delete('/admin/users/teacher/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const ok = deleteTeacher(id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true });
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Start server
(async () => {
    ensureWorldsFile();
    initDb();
    initUserSessionsDb();
    // Initialize mediasoup workers (room VC + PDF VC)
    await createWorkers();
    await createPdfWorkers();
    await createVideoVcWorkers();

const protocol = hasSsl ? 'https' : 'http';

httpServer.listen(PORT, HOST, () => {
    console.log(`Server running on ${protocol}://localhost:${PORT}`);
    const lanIps = getLanIps();
    if (lanIps.length > 0) {
        console.log(`LAN access: ${lanIps.map(ip => `${protocol}://${ip}:${PORT}`).join(', ')}`);
        if (HOST === '0.0.0.0') {
            console.log('External access: forward TCP port ' + PORT + ' on your router to this machine (see EXTERNAL_ACCESS.md).');
        }
        if (!MEDIASOUP_ANNOUNCED_IP && lanIps.length > 0) {
            console.warn(`[VC] MEDIASOUP_ANNOUNCED_IP not set. Set to your LAN IP (e.g. ${lanIps[0]}) for WebRTC/voice/video on LAN.`);
        }
    }
    if (hasSsl) {
        console.log('HTTPS is enabled (SSL_CERT_PATH / SSL_KEY_PATH).');
    }
    if (hasSsl && PORT_HTTP_REDIRECT > 0) {
        const redirectServer = http.createServer((req, res) => {
            const host = (req.headers.host || 'localhost').split(':')[0];
            res.writeHead(302, { Location: `https://${host}:${PORT}${req.url}` });
            res.end();
        });
        redirectServer.listen(PORT_HTTP_REDIRECT, HOST, () => {
            console.log(`HTTP redirect server on port ${PORT_HTTP_REDIRECT} -> ${protocol}:${PORT}`);
        });
    }
    console.log(`Players will sync at 30fps`);
    console.log(`mediasoup VC enabled with ${workers.length} workers; PDF VC with ${pdfWorkers.length} workers`);
    console.log(`VC_DEBUG_STATS: ${VC_DEBUG_STATS ? 'ENABLED' : 'DISABLED'} (env=${process.env.VC_DEBUG_STATS})`);
    console.log(`Admin panel available at ${protocol}://localhost:${PORT}/admin.html`);
});
})();