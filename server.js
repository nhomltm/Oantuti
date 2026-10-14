/**
 * server.js
 * 
 * BACKEND NODE.JS EXPRESS CHO ĐẤU TRƯỜNG BOT OẰN TÙ TÌ 9X9
 * 
 * KIẾN TRÚC NÂNG CẤP:
 * 1. ĐIỀU PHỐI HÀNG ĐỢI XOAY VÒNG (ROUND-ROBIN QUEUE CHUNKING):
 *    - Không dùng vòng lặp vô hạn hay setInterval chạy ngầm gây tốn CPU.
 *    - Khi 1 bot được nộp/cập nhật, tạo job `{ botId, roomId, remainingOpponents: [...] }` đưa vào `submissionQueue`.
 *    - Mỗi lượt (Batch Quota): Worker lấy bot đầu hàng (`submissionQueue.shift()`), cắt tối đa `BATCH_SIZE = 10` đối thủ
 *      từ `remainingOpponents` để chạy tối đa 10 trận.
 *    - Cập nhật ngay kết quả vào Bảng xếp hạng sau mỗi batch.
 *    - Nếu bot vẫn còn đối thủ (`remainingOpponents.length > 0`), đẩy về CUỐI HÀNG (`submissionQueue.push()`)
 *      để nhường sân cho bot tiếp theo.
 *    - Sau mỗi batch 10 trận, nghỉ ngắn (`setTimeout` 80ms) để giải phóng Event Loop.
 *    - Khi `submissionQueue` rỗng: Server về trạng thái nghỉ hoàn toàn (Idle 0% CPU).
 * 
 * 2. LƯU TRỮ BỀN VỮNG (PERSISTENCE) & CHUẨN HÓA DỮ LIỆU:
 *    - Tự động đọc/ghi `data/players.json` và `data/matches.json`.
 *    - Chuẩn hóa đồng nhất các trường `id`, `botId`, `playerId` và `name`, `botName`, `playerName`
 *      để giao diện Bảng xếp hạng không bao giờ gặp lỗi `undefined`.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { 
  GUARDIAN_AND_STRIKER_BOT_CODE, 
  HUNTER_BOT_CODE, 
  RUSHER_BOT_CODE,
  RANDOM_BOT_CODE 
} from './botRunner.js';
import { playMatch, SCORING } from './tournamentEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const BATCH_SIZE = 10; // Lát cắt tối đa 10 trận mỗi lượt xoay vòng
const WORKER_REST_MS = 80; // Nghỉ 80ms giữa mỗi batch để không nghẽn Event Loop

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ============================================================================
// 1. LƯU TRỮ DỮ LIỆU BỀN VỮNG (PERSISTENCE) & CHUẨN HÓA BOT RECORD
// ============================================================================
const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TOURNAMENT_FILE = path.join(DATA_DIR, 'tournament.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 5 Bot mẫu hệ thống sẵn có
const DEFAULT_SYSTEM_BOTS = [
  { id: 'bot_guardian_god', name: 'Titan Guardian AI', author: 'Grandmaster AI', code: GUARDIAN_AND_STRIKER_BOT_CODE, score: 60, wins: 20, draws: 0, losses: 0, errors: 0 },
  { id: 'bot_rusher_prime', name: 'Blitz Rusher AI', author: 'Master AI', code: RUSHER_BOT_CODE, score: 45, wins: 15, draws: 0, losses: 5, errors: 0 },
  { id: 'bot_hunter_alpha', name: 'Shadow Hunter AI', author: 'Elite AI', code: HUNTER_BOT_CODE, score: 30, wins: 10, draws: 0, losses: 10, errors: 0 },
  { id: 'bot_hunter_beta', name: 'Forest Hunter AI', author: 'Warrior AI', code: HUNTER_BOT_CODE, score: 18, wins: 6, draws: 0, losses: 14, errors: 0 },
  { id: 'bot_random_rookie', name: 'Lucky Rookie AI', author: 'Academy AI', code: RANDOM_BOT_CODE, score: 6, wins: 2, draws: 0, losses: 18, errors: 0 }
];

// In-memory Database
const dbPlayers = new Map(); // botId -> Normalized Player/Bot Record
const dbMatches = new Map(); // matchId -> Match Log
const dbUsers = new Map(); // userId -> { id, username, passwordHash, salt, role: 'user' | 'admin', createdAt }
const activeSessions = new Map(); // token -> { userId, username, role, expiresAt }

// ============================================================================
// HỆ THỐNG XÁC THỰC MÃ HÓA & QUẢN LÝ NGƯỜI DÙNG (AUTH & ROLES)
// ============================================================================

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  try {
    const calc = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
  } catch (err) {
    return false;
  }
}

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const u of list) {
          if (u && u.id) {
            dbUsers.set(u.id, u);
          }
        }
        console.log(`[Auth] Đã tải ${dbUsers.size} người dùng từ ${USERS_FILE}`);
      }
    }
  } catch (err) {
    console.error('[Auth] Lỗi khi đọc users.json:', err.message);
  }

  // Khởi tạo tài khoản Admin mặc định nếu chưa có
  let hasAdmin = false;
  for (const u of dbUsers.values()) {
    if (u.username && u.username.toLowerCase() === 'admin') {
      hasAdmin = true;
      break;
    }
  }

  if (!hasAdmin) {
    const { hash, salt } = hashPassword('admin123');
    const adminUser = {
      id: 'user_admin_default',
      username: 'admin',
      passwordHash: hash,
      salt: salt,
      role: 'admin',
      createdAt: Date.now()
    };
    dbUsers.set(adminUser.id, adminUser);
    saveUsers();
    console.log('[Auth] 👑 Đã khởi tạo tài khoản Admin mặc định: admin / admin123');
  }
}

function saveUsers() {
  try {
    const list = Array.from(dbUsers.values());
    fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Auth] Lỗi khi lưu users.json:', err.message);
  }
}

// ============================================================================
// HỆ THỐNG CẤU HÌNH & TRẠNG THÁI GIẢI ĐẤU (TOURNAMENT MANAGEMENT)
// ============================================================================

let tournamentState = {
  isOpenForRegistration: true,
  registrationStart: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
  registrationEnd: new Date(Date.now() + 3600 * 1000 * 24 * 7).toISOString(),
  tournamentStart: new Date(Date.now() + 3600 * 1000 * 24 * 8).toISOString(),
  status: 'REGISTRATION', // 'UPCOMING' | 'REGISTRATION' | 'RUNNING' | 'COMPLETED'
  prizes: [
    { id: 'prize_1', rank: 1, title: 'Hạng 1 (Quán Quân)', reward: 'Cúp Vàng + 500.000 VNĐ', badge: '🥇' },
    { id: 'prize_2', rank: 2, title: 'Hạng 2 (Á Quân)', reward: 'Cúp Bạc + 300.000 VNĐ', badge: '🥈' },
    { id: 'prize_3', rank: 3, title: 'Hạng 3 (Quý Quân)', reward: 'Huy Chương Đồng + 100.000 VNĐ', badge: '🥉' },
    { id: 'prize_4', rank: 4, title: 'Giải Sáng Tạo', reward: 'Kỷ Niệm Chương + 50.000 VNĐ', badge: '✨' }
  ],
  isPrizeAnnounced: true,
  tournamentProgress: {
    isRunning: false,
    totalMatches: 0,
    completedMatches: 0,
    currentBatch: 0,
    totalBatches: 0,
    percentage: 0,
    statusText: 'Sẵn sàng'
  }
};

function loadTournamentConfig() {
  try {
    if (fs.existsSync(TOURNAMENT_FILE)) {
      const raw = fs.readFileSync(TOURNAMENT_FILE, 'utf-8');
      const loaded = JSON.parse(raw);
      if (loaded && typeof loaded === 'object') {
        tournamentState = {
          ...tournamentState,
          ...loaded,
          tournamentProgress: {
            ...tournamentState.tournamentProgress,
            isRunning: false,
            statusText: 'Sẵn sàng'
          }
        };
        console.log(`[Tournament] Đã tải cấu hình giải đấu từ ${TOURNAMENT_FILE}`);
        return;
      }
    }
  } catch (err) {
    console.error('[Tournament] Lỗi khi đọc tournament.json:', err.message);
  }
  saveTournamentConfig();
}

function saveTournamentConfig() {
  try {
    const toSave = {
      isOpenForRegistration: tournamentState.isOpenForRegistration,
      registrationStart: tournamentState.registrationStart,
      registrationEnd: tournamentState.registrationEnd,
      tournamentStart: tournamentState.tournamentStart,
      status: tournamentState.status,
      prizes: tournamentState.prizes,
      isPrizeAnnounced: tournamentState.isPrizeAnnounced
    };
    fs.writeFileSync(TOURNAMENT_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Tournament] Lỗi khi lưu tournament.json:', err.message);
  }
}

function isRegistrationOpenNow() {
  if (!tournamentState.isOpenForRegistration) return false;
  const now = Date.now();
  const start = new Date(tournamentState.registrationStart).getTime();
  const end = new Date(tournamentState.registrationEnd).getTime();

  if (!isNaN(start) && now < start) return false;
  if (!isNaN(end) && now > end) return false;
  return true;
}

// Middleware xác thực Token & phân quyền
function extractUserFromReq(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7).trim();
  const session = activeSessions.get(token);
  if (!session) return null;
  if (session.expiresAt && Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

function authenticateToken(req, res, next) {
  const user = extractUserFromReq(req);
  if (!user) {
    return res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = extractUserFromReq(req);
  if (!user) {
    return res.status(401).json({ error: 'Vui lòng đăng nhập tài khoản Quản trị viên (Admin).' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Từ chối truy cập: Bạn không có quyền Quản trị viên (Admin).' });
  }
  req.user = user;
  next();
}

/**
 * Chuẩn hóa thông tin Bot/Player để đảm bảo luôn có đầy đủ cả
 * `id`, `botId`, `playerId`, `name`, `botName`, `playerName` và `lastMatchId`
 */
function normalizePlayerRecord(raw) {
  const id = raw.botId || raw.playerId || raw.id || `bot_${Date.now()}`;
  const displayName = (raw.botName || raw.name || raw.playerName || 'Unnamed Bot').trim();
  const authorName = (raw.author || raw.playerName || 'Anonymous').trim();
  const language = (raw.language || 'javascript').toLowerCase();
  const roomId = (raw.roomId || 'PUBLIC').trim().toUpperCase();

  const wins = Number(raw.wins) || 0;
  const draws = Number(raw.draws) || 0;
  const losses = Number(raw.losses) || 0;
  const errors = Number(raw.errors) || 0;
  const score = Number(raw.score) || 0;
  const matchesPlayed = Number(raw.matchesPlayed) || (wins + draws + losses);

  return {
    id,
    botId: id,
    playerId: id,
    name: displayName,
    botName: displayName,
    playerName: displayName,
    author: authorName,
    language,
    botCode: raw.botCode || raw.code || RANDOM_BOT_CODE,
    score,
    wins,
    draws,
    losses,
    errors,
    matchesPlayed,
    roomId,
    lastMatchId: raw.lastMatchId || null,
    updatedAt: raw.updatedAt || Date.now()
  };
}

/**
 * Đảm bảo mọi bot trong hệ thống đều có `lastMatchId` hợp lệ trỏ tới một trận đấu có thực trong `dbMatches`:
 * 1. Quét toàn bộ `dbMatches` để cập nhật `lastMatchId` mới nhất cho cả `botRed` và `botBlue`.
 * 2. Nếu hệ thống chưa có trận đấu mẫu nào, tự động khởi tạo 1 trận mẫu.
 * 3. Với các bot mẫu / bot khởi tạo sẵn chưa có `lastMatchId` (hoặc `lastMatchId` không còn trong `dbMatches`),
 *    gán sẵn `lastMatchId` hợp lệ từ trận đấu trong hệ thống.
 */
function syncAndEnsureLastMatchIds() {
  // Nếu chưa có bất kỳ trận đấu nào trong dbMatches, tạo ngay 1 trận đấu mẫu giữa 2 bot hệ thống
  if (dbMatches.size === 0) {
    const botA = DEFAULT_SYSTEM_BOTS[0];
    const botB = DEFAULT_SYSTEM_BOTS[1];
    const sampleMatch = playMatch(
      { id: botA.id, name: botA.name, author: botA.author, language: 'javascript', code: botA.code },
      { id: botB.id, name: botB.name, author: botB.author, language: 'javascript', code: botB.code },
      { timeoutMs: 200 }
    );
    dbMatches.set(sampleMatch.id, {
      ...sampleMatch,
      roomId: 'PUBLIC',
      timestamp: Date.now()
    });
  }

  // Bước 1: Quét qua toàn bộ lịch sử trận đấu (từ cũ đến mới) để gán lastMatchId cho cả 2 bên Red & Blue
  let fallbackSampleMatchId = null;
  for (const m of dbMatches.values()) {
    if (!m || !m.id) continue;
    fallbackSampleMatchId = m.id;

    const redId = m.botRed?.id || m.botRed?.botId;
    const blueId = m.botBlue?.id || m.botBlue?.botId;

    if (redId && dbPlayers.has(redId)) {
      dbPlayers.get(redId).lastMatchId = m.id;
    }
    if (blueId && dbPlayers.has(blueId)) {
      dbPlayers.get(blueId).lastMatchId = m.id;
    }
  }

  // Bước 2: Đảm bảo không có bot nào bị thiếu hoặc trỏ tới lastMatchId không tồn tại
  for (const bot of dbPlayers.values()) {
    if (!bot.lastMatchId || !dbMatches.has(bot.lastMatchId)) {
      bot.lastMatchId = fallbackSampleMatchId;
    }
  }
}

/**
 * Tải dữ liệu từ ổ đĩa khi khởi động server
 */
function loadPersistedData() {
  // Tải danh sách người dùng và cấu hình giải đấu
  loadUsers();
  loadTournamentConfig();

  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      const raw = fs.readFileSync(PLAYERS_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          const normalized = normalizePlayerRecord(item);
          dbPlayers.set(normalized.botId, normalized);
        }
        console.log(`[Persistence] Đã tải và chuẩn hóa ${dbPlayers.size} bots từ ${PLAYERS_FILE}`);
      }
    }
  } catch (err) {
    console.error('[Persistence] Lỗi khi đọc players.json:', err.message);
  }

  // Đảm bảo các bot mẫu hệ thống luôn có mặt
  for (const b of DEFAULT_SYSTEM_BOTS) {
    if (!dbPlayers.has(b.id)) {
      const sysRecord = normalizePlayerRecord({
        id: b.id,
        botId: b.id,
        playerId: b.id,
        name: b.name,
        botName: b.name,
        playerName: b.name,
        author: b.author,
        language: 'javascript',
        botCode: b.code,
        score: b.score,
        wins: b.wins,
        draws: b.draws,
        losses: b.losses,
        errors: b.errors,
        matchesPlayed: b.wins + b.draws + b.losses,
        roomId: 'PUBLIC',
        updatedAt: Date.now()
      });
      dbPlayers.set(b.id, sysRecord);
    }
  }

  try {
    if (fs.existsSync(MATCHES_FILE)) {
      const raw = fs.readFileSync(MATCHES_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const m of list) {
          dbMatches.set(m.id, m);
        }
        console.log(`[Persistence] Đã tải ${dbMatches.size} trận đấu từ ${MATCHES_FILE}`);
      }
    }
  } catch (err) {
    console.error('[Persistence] Lỗi khi đọc matches.json:', err.message);
  }

  // Đồng bộ và đảm bảo mọi bot đều có lastMatchId hợp lệ
  syncAndEnsureLastMatchIds();

  // Ghi lại bản đã chuẩn hóa xuống đĩa
  savePersistedData();
}

/**
 * Dọn dẹp bớt trận đấu cũ khi vượt quá giới hạn, nhưng BẢO VỆ các trận đấu đang là `lastMatchId` của bất kỳ bot nào
 */
function pruneOldMatches(maxMatches = 300) {
  if (dbMatches.size <= maxMatches) return;

  const protectedMatchIds = new Set();
  for (const p of dbPlayers.values()) {
    if (p.lastMatchId) protectedMatchIds.add(p.lastMatchId);
  }

  for (const key of dbMatches.keys()) {
    if (dbMatches.size <= maxMatches) break;
    if (!protectedMatchIds.has(key)) {
      dbMatches.delete(key);
    }
  }
}

/**
 * Lưu dữ liệu bền vững ra file
 */
function savePersistedData() {
  try {
    pruneOldMatches(300);
    const playersList = Array.from(dbPlayers.values()).map(normalizePlayerRecord);
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playersList, null, 2), 'utf-8');

    const matchesList = Array.from(dbMatches.values());
    fs.writeFileSync(MATCHES_FILE, JSON.stringify(matchesList, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Persistence] Lỗi khi lưu dữ liệu:', err.message);
  }
}

// Khởi chạy nạp dữ liệu khi server start
loadPersistedData();

// ============================================================================
// SERVER-SENT EVENTS (SSE) BROADCASTING
// ============================================================================
const sseClients = new Set();

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

/**
 * Lấy Bảng xếp hạng đã chuẩn hóa và sắp xếp theo điểm số
 */
function getSortedLeaderboard(roomId = 'PUBLIC') {
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();
  const list = Array.from(dbPlayers.values())
    .filter(p => {
      if (normRoom === 'PUBLIC') return true;
      return p.roomId === normRoom;
    })
    .map(normalizePlayerRecord);

  return list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.errors !== b.errors) return a.errors - b.errors;
    return a.losses - b.losses;
  });
}

// ============================================================================
// 2. THUẬT TOÁN ĐIỀU PHỐI HÀNG ĐỢI XOAY VÒNG (ROUND-ROBIN BATCH SCHEDULER)
// ============================================================================

/**
 * Hàng đợi xoay vòng:
 * Mỗi phần tử có cấu trúc:
 * {
 *   botId: string,
 *   roomId: string,
 *   remainingOpponents: [oppId1, oppId2, ...],
 *   matchCounter: number
 * }
 */
const submissionQueue = [];
let isWorkerRunning = false;

/**
 * Đưa một bot vào hàng đợi xoay vòng để đấu với toàn bộ đối thủ khác
 */
function enqueueBotForRoundRobin(botId, roomId = 'PUBLIC') {
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

  // Lấy danh sách toàn bộ đối thủ trong cùng phòng (trừ chính nó)
  let opponents = Array.from(dbPlayers.values())
    .filter(p => p.botId !== botId && (normRoom === 'PUBLIC' || p.roomId === normRoom))
    .map(p => p.botId);

  // Nếu phòng riêng chưa có đối thủ nào khác, lấy các bot mẫu hệ thống làm đối thủ
  if (opponents.length === 0) {
    opponents = DEFAULT_SYSTEM_BOTS
      .filter(b => b.id !== botId)
      .map(b => b.id);
  }

  // Nếu bot này đang có một job cũ chưa chạy xong trong hàng đợi, cập nhật lại danh sách đối thủ cho nó
  const existingJobIndex = submissionQueue.findIndex(j => j.botId === botId);
  if (existingJobIndex !== -1) {
    submissionQueue[existingJobIndex].remainingOpponents = opponents;
    submissionQueue[existingJobIndex].roomId = normRoom;
    console.log(`🔄 [Scheduler] Cập nhật lại danh sách ${opponents.length} đối thủ cho bot "${botId}" trong hàng đợi.`);
  } else {
    submissionQueue.push({
      botId,
      roomId: normRoom,
      remainingOpponents: opponents,
      matchCounter: 0
    });
    console.log(`📥 [Scheduler] Bot "${botId}" đã vào hàng đợi với ${opponents.length} đối thủ. Hàng đợi hiện có: ${submissionQueue.length} bot.`);
  }

  // Kích hoạt Worker nếu đang nghỉ (idle)
  if (!isWorkerRunning) {
    processQueue();
  }
}

/**
 * Worker xử lý hàng đợi xoay vòng theo lát cắt (Chunking tối đa BATCH_SIZE = 10 trận/lượt)
 * Khi hàng đợi rỗng -> tự động về trạng thái nghỉ (0% CPU).
 */
async function processQueue() {
  if (isWorkerRunning) return;

  if (submissionQueue.length === 0) {
    isWorkerRunning = false;
    console.log(`💤 [Scheduler] Hàng đợi đã rỗng. Worker chuyển về trạng thái nghỉ (Idle 0% CPU).`);
    return;
  }

  isWorkerRunning = true;

  // 1. Lấy bot ở đầu hàng đợi
  const currentJob = submissionQueue.shift();
  const challenger = dbPlayers.get(currentJob.botId);

  // Nếu bot không tồn tại hoặc không còn đối thủ nào
  if (!challenger || !currentJob.remainingOpponents || currentJob.remainingOpponents.length === 0) {
    isWorkerRunning = false;
    if (submissionQueue.length > 0) {
      setTimeout(processQueue, WORKER_REST_MS);
    }
    return;
  }

  // 2. Cắt ra tối đa BATCH_SIZE (10) đối thủ cho lượt chạy này
  const currentOpponentsIds = currentJob.remainingOpponents.splice(0, BATCH_SIZE);
  console.log(`⚔️ [Scheduler] Đang chạy batch ${currentOpponentsIds.length} trận cho bot "${challenger.botName}" (Còn lại: ${currentJob.remainingOpponents.length} đối thủ)...`);

  let matchesRunInBatch = 0;

  for (const oppId of currentOpponentsIds) {
    const opponent = dbPlayers.get(oppId);
    if (!opponent) continue;

    // Luân phiên màu cờ RED / BLUE để đảm bảo công bằng tuyệt đối
    const isChallengerRed = (currentJob.matchCounter % 2 === 0);
    currentJob.matchCounter++;

    const botRedConfig = isChallengerRed
      ? {
          id: challenger.botId,
          name: challenger.botName,
          author: challenger.author,
          language: challenger.language,
          code: { code: challenger.botCode, language: challenger.language }
        }
      : {
          id: opponent.botId,
          name: opponent.botName,
          author: opponent.author,
          language: opponent.language,
          code: { code: opponent.botCode, language: opponent.language }
        };

    const botBlueConfig = isChallengerRed
      ? {
          id: opponent.botId,
          name: opponent.botName,
          author: opponent.author,
          language: opponent.language,
          code: { code: opponent.botCode, language: opponent.language }
        }
      : {
          id: challenger.botId,
          name: challenger.botName,
          author: challenger.author,
          language: challenger.language,
          code: { code: challenger.botCode, language: challenger.language }
        };

    // Chạy trận đấu qua playMatch
    const matchResult = await new Promise(resolve => {
      setImmediate(() => {
        const res = playMatch(botRedConfig, botBlueConfig, { timeoutMs: 200 });
        resolve(res);
      });
    });

    matchesRunInBatch++;

    // Lưu lịch sử trận đấu phục vụ Replay
    dbMatches.set(matchResult.id, {
      ...matchResult,
      roomId: currentJob.roomId,
      timestamp: Date.now()
    });

    // Cập nhật ngay điểm số, chỉ số và lastMatchId cho CẢ 2 BOT (Red & Blue)
    const redRecord = dbPlayers.get(botRedConfig.id);
    const blueRecord = dbPlayers.get(botBlueConfig.id);

    if (redRecord) {
      redRecord.lastMatchId = matchResult.id;
    }
    if (blueRecord) {
      blueRecord.lastMatchId = matchResult.id;
    }

    if (redRecord && blueRecord) {
      redRecord.matchesPlayed += 1;
      blueRecord.matchesPlayed += 1;

      redRecord.errors += matchResult.botRed.errors || 0;
      blueRecord.errors += matchResult.botBlue.errors || 0;

      if (matchResult.winner === 'RED') {
        redRecord.wins += 1;
        redRecord.score += SCORING.WIN;
        blueRecord.losses += 1;
        blueRecord.score += SCORING.LOSS;
      } else if (matchResult.winner === 'BLUE') {
        blueRecord.wins += 1;
        blueRecord.score += SCORING.WIN;
        redRecord.losses += 1;
        redRecord.score += SCORING.LOSS;
      } else {
        redRecord.draws += 1;
        redRecord.score += SCORING.DRAW;
        blueRecord.draws += 1;
        blueRecord.score += SCORING.DRAW;
      }

      redRecord.updatedAt = Date.now();
      blueRecord.updatedAt = Date.now();
    }
  }

  // Giới hạn bộ nhớ dbMatches tối đa 300 trận (nhưng luôn giữ lại các trận là lastMatchId của mỗi bot)
  pruneOldMatches(300);

  // 3. Lưu kết quả xuống đĩa và phát sự kiện cập nhật Bảng xếp hạng
  savePersistedData();
  broadcastSSE('leaderboard_updated', {
    roomId: currentJob.roomId,
    leaderboard: getSortedLeaderboard(currentJob.roomId)
  });

  // 4. Kiểm tra xem bot hiện tại còn đối thủ chưa đấu không
  if (currentJob.remainingOpponents.length > 0) {
    // Đẩy về CUỐI HÀNG ĐỢI để nhường lượt cho bot tiếp theo
    submissionQueue.push(currentJob);
    console.log(`🔁 [Scheduler] Bot "${challenger.botName}" xong ${matchesRunInBatch} trận, còn ${currentJob.remainingOpponents.length} đối thủ -> Xếp về cuối hàng đợi.`);
  } else {
    console.log(`✅ [Scheduler] Bot "${challenger.botName}" đã hoàn tất toàn bộ vòng đấu! Giải phóng khỏi hàng đợi.`);
  }

  // 5. Giải phóng cờ khoá và nghỉ nhịp ngắn (50-100ms) trước khi xử lý lượt tiếp theo
  isWorkerRunning = false;

  if (submissionQueue.length > 0) {
    setTimeout(processQueue, WORKER_REST_MS);
  } else {
    console.log(`💤 [Scheduler] Hàng đợi đã rỗng. Server về trạng thái nghỉ (Idle 0% CPU).`);
  }
}

// ============================================================================
// 3. AUTHENTICATION & TOURNAMENT MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * POST /api/auth/register
 * Đăng ký tài khoản người chơi mới (mặc định role 'user')
 */
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'Tên đăng nhập phải có ít nhất 3 ký tự.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });
    }

    const cleanUsername = username.trim();
    // Kiểm tra trùng username (không phân biệt hoa thường)
    for (const u of dbUsers.values()) {
      if (u.username.toLowerCase() === cleanUsername.toLowerCase()) {
        return res.status(409).json({ error: 'Tên đăng nhập này đã tồn tại, vui lòng chọn tên khác.' });
      }
    }

    const { hash, salt } = hashPassword(password);
    const userId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newUser = {
      id: userId,
      username: cleanUsername,
      passwordHash: hash,
      salt: salt,
      role: 'user',
      createdAt: Date.now()
    };

    dbUsers.set(userId, newUser);
    saveUsers();

    // Tạo token phiên đăng nhập (hạn 7 ngày)
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, {
      userId,
      username: cleanUsername,
      role: 'user',
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000
    });

    console.log(`[Auth] 👤 Người dùng mới đăng ký: ${cleanUsername} (${userId})`);
    return res.status(201).json({
      success: true,
      message: 'Đăng ký thành công!',
      token,
      user: { id: userId, username: cleanUsername, role: 'user' }
    });
  } catch (err) {
    console.error('Error in /api/auth/register:', err);
    return res.status(500).json({ error: 'Lỗi server khi đăng ký tài khoản.' });
  }
});

/**
 * POST /api/auth/login
 * Đăng nhập tài khoản người dùng hoặc Admin
 */
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng cung cấp đầy đủ tên đăng nhập và mật khẩu.' });
    }

    const cleanUsername = username.trim().toLowerCase();
    let targetUser = null;
    for (const u of dbUsers.values()) {
      if (u.username.toLowerCase() === cleanUsername) {
        targetUser = u;
        break;
      }
    }

    if (!targetUser) {
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
    }

    const isMatch = verifyPassword(password, targetUser.passwordHash, targetUser.salt);
    if (!isMatch) {
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
    }

    // Tạo token phiên đăng nhập mới
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, {
      userId: targetUser.id,
      username: targetUser.username,
      role: targetUser.role,
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000
    });

    console.log(`[Auth] 🔑 Đăng nhập thành công: ${targetUser.username} (${targetUser.role})`);
    return res.status(200).json({
      success: true,
      message: 'Đăng nhập thành công!',
      token,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        role: targetUser.role
      }
    });
  } catch (err) {
    console.error('Error in /api/auth/login:', err);
    return res.status(500).json({ error: 'Lỗi server khi đăng nhập.' });
  }
});

/**
 * GET /api/auth/me
 * Lấy thông tin tài khoản hiện tại từ Token
 */
app.get('/api/auth/me', authenticateToken, (req, res) => {
  return res.status(200).json({
    success: true,
    user: {
      id: req.user.userId,
      username: req.user.username,
      role: req.user.role
    }
  });
});

/**
 * POST /api/auth/logout
 * Đăng xuất hủy token
 */
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    activeSessions.delete(token);
  }
  return res.status(200).json({ success: true, message: 'Đã đăng xuất.' });
});

/**
 * GET /api/tournament/status
 * Trả về thông tin giải đấu công khai: thời gian, trạng thái đăng ký, danh sách giải thưởng
 */
app.get('/api/tournament/status', (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        isOpenForRegistration: tournamentState.isOpenForRegistration,
        isRegistrationOpenNow: isRegistrationOpenNow(),
        registrationStart: tournamentState.registrationStart,
        registrationEnd: tournamentState.registrationEnd,
        tournamentStart: tournamentState.tournamentStart,
        status: tournamentState.status,
        prizes: tournamentState.prizes,
        isPrizeAnnounced: tournamentState.isPrizeAnnounced,
        tournamentProgress: tournamentState.tournamentProgress,
        totalEligibleBots: dbPlayers.size
      }
    });
  } catch (err) {
    console.error('Error in /api/tournament/status:', err);
    return res.status(500).json({ error: 'Lỗi server khi lấy trạng thái giải đấu.' });
  }
});

// ============================================================================
// ADMIN TOURNAMENT MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * POST /api/admin/tournament/schedule
 * Admin thiết lập lịch trình giải đấu
 */
app.post('/api/admin/tournament/schedule', requireAdmin, (req, res) => {
  try {
    const { registrationStart, registrationEnd, tournamentStart, isOpenForRegistration, status } = req.body;
    if (registrationStart) tournamentState.registrationStart = registrationStart;
    if (registrationEnd) tournamentState.registrationEnd = registrationEnd;
    if (tournamentStart) tournamentState.tournamentStart = tournamentStart;
    if (typeof isOpenForRegistration === 'boolean') {
      tournamentState.isOpenForRegistration = isOpenForRegistration;
    }
    if (status) tournamentState.status = status;

    saveTournamentConfig();
    broadcastSSE('tournament_updated', { tournament: tournamentState });

    return res.status(200).json({
      success: true,
      message: 'Đã lưu cấu hình lịch trình giải đấu!',
      data: tournamentState
    });
  } catch (err) {
    console.error('Error in /api/admin/tournament/schedule:', err);
    return res.status(500).json({ error: 'Lỗi server khi lưu lịch trình.' });
  }
});

/**
 * POST /api/admin/tournament/toggle-registration
 * Admin toggle thủ công mở / khóa cổng nộp bot
 */
app.post('/api/admin/tournament/toggle-registration', requireAdmin, (req, res) => {
  try {
    tournamentState.isOpenForRegistration = !tournamentState.isOpenForRegistration;
    saveTournamentConfig();
    broadcastSSE('tournament_updated', { tournament: tournamentState });

    const statusMsg = tournamentState.isOpenForRegistration ? 'ĐÃ MỞ' : 'ĐÃ KHÓA';
    console.log(`[Admin] 📢 Admin đã thay đổi cổng nộp bot: ${statusMsg}`);
    return res.status(200).json({
      success: true,
      isOpenForRegistration: tournamentState.isOpenForRegistration,
      message: `Cổng nộp bot hiện ${statusMsg}.`
    });
  } catch (err) {
    console.error('Error in /api/admin/tournament/toggle-registration:', err);
    return res.status(500).json({ error: 'Lỗi server khi chuyển trạng thái đăng ký.' });
  }
});

/**
 * POST /api/admin/tournament/prizes
 * Admin lưu danh sách cơ cấu giải thưởng
 */
app.post('/api/admin/tournament/prizes', requireAdmin, (req, res) => {
  try {
    const { prizes } = req.body;
    if (!Array.isArray(prizes)) {
      return res.status(400).json({ error: 'Danh sách giải thưởng không hợp lệ (cần dạng mảng).' });
    }

    tournamentState.prizes = prizes.map((p, idx) => ({
      id: p.id || `prize_${Date.now()}_${idx}`,
      rank: Number(p.rank) || (idx + 1),
      title: (p.title || `Hạng ${idx + 1}`).trim(),
      reward: (p.reward || '').trim(),
      badge: p.badge || (idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '✨')
    }));

    saveTournamentConfig();
    broadcastSSE('tournament_updated', { tournament: tournamentState });

    return res.status(200).json({
      success: true,
      message: 'Đã lưu cấu hình giải thưởng thành công!',
      prizes: tournamentState.prizes
    });
  } catch (err) {
    console.error('Error in /api/admin/tournament/prizes:', err);
    return res.status(500).json({ error: 'Lỗi server khi lưu giải thưởng.' });
  }
});

/**
 * POST /api/admin/tournament/announce-prizes
 * Admin bật/tắt công bố giải thưởng lên Bảng xếp hạng và Trang chủ
 */
app.post('/api/admin/tournament/announce-prizes', requireAdmin, (req, res) => {
  try {
    const { isPrizeAnnounced } = req.body;
    tournamentState.isPrizeAnnounced = typeof isPrizeAnnounced === 'boolean' 
      ? isPrizeAnnounced 
      : !tournamentState.isPrizeAnnounced;

    saveTournamentConfig();
    broadcastSSE('tournament_updated', { tournament: tournamentState });

    const msg = tournamentState.isPrizeAnnounced ? 'Đã công bố trao giải thưởng!' : 'Đã ẩn công bố giải thưởng.';
    return res.status(200).json({
      success: true,
      isPrizeAnnounced: tournamentState.isPrizeAnnounced,
      message: msg
    });
  } catch (err) {
    console.error('Error in /api/admin/tournament/announce-prizes:', err);
    return res.status(500).json({ error: 'Lỗi server khi công bố giải thưởng.' });
  }
});

/**
 * GET /api/admin/tournament/progress
 * Admin lấy tiến độ thi đấu giải đấu
 */
app.get('/api/admin/tournament/progress', requireAdmin, (req, res) => {
  return res.status(200).json({
    success: true,
    progress: tournamentState.tournamentProgress
  });
});

/**
 * POST /api/admin/tournament/run-all
 * Admin kích hoạt chạy toàn bộ giải đấu Round-Robin Matchmaking theo từng Batch 10 trận
 */
let isTournamentRunning = false;

app.post('/api/admin/tournament/run-all', requireAdmin, async (req, res) => {
  try {
    if (isTournamentRunning || tournamentState.tournamentProgress.isRunning) {
      return res.status(400).json({ error: 'Giải đấu đang trong quá trình chạy, vui lòng chờ hoàn tất!' });
    }

    const eligibleBots = Array.from(dbPlayers.values());
    if (eligibleBots.length < 2) {
      return res.status(400).json({ error: 'Cần ít nhất 2 bot trong hệ thống để tổ chức giải đấu.' });
    }

    // Reset chỉ số trận đấu để bắt đầu giải đấu chính thức công bằng
    const resetScores = req.body.resetScores !== false;
    if (resetScores) {
      for (const b of dbPlayers.values()) {
        b.score = 0;
        b.wins = 0;
        b.draws = 0;
        b.losses = 0;
        b.errors = 0;
        b.matchesPlayed = 0;
      }
      savePersistedData();
    }

    // Tạo danh sách các cặp đấu vòng tròn Round-Robin (2 lượt Red/Blue đối xứng để hoàn toàn công bằng)
    const matchPairs = [];
    for (let i = 0; i < eligibleBots.length; i++) {
      for (let j = i + 1; j < eligibleBots.length; j++) {
        const botA = eligibleBots[i];
        const botB = eligibleBots[j];
        // Lượt 1: A là Red, B là Blue
        matchPairs.push({ red: botA, blue: botB });
        // Lượt 2: B là Red, A là Blue
        matchPairs.push({ red: botB, blue: botA });
      }
    }

    const totalMatches = matchPairs.length;
    const totalBatches = Math.ceil(totalMatches / BATCH_SIZE);

    tournamentState.status = 'RUNNING';
    tournamentState.tournamentProgress = {
      isRunning: true,
      totalMatches,
      completedMatches: 0,
      currentBatch: 0,
      totalBatches,
      percentage: 0,
      statusText: `Khởi động giải đấu với ${eligibleBots.length} bot (${totalMatches} trận chia làm ${totalBatches} batches)...`
    };

    saveTournamentConfig();
    broadcastSSE('tournament_started', tournamentState.tournamentProgress);

    // Bắt đầu chạy ngầm theo Batch 10 trận
    isTournamentRunning = true;

    // Phản hồi ngay cho Admin biết tiến trình đã khởi chạy thành công
    res.status(200).json({
      success: true,
      message: `Đã kích hoạt giải đấu: ${eligibleBots.length} bot, ${totalMatches} trận đấu (${totalBatches} batches).`,
      progress: tournamentState.tournamentProgress
    });

    // Worker chạy Batch giải đấu
    (async () => {
      let completedCount = 0;
      let batchIndex = 0;

      while (matchPairs.length > 0) {
        batchIndex++;
        const currentBatch = matchPairs.splice(0, BATCH_SIZE);

        tournamentState.tournamentProgress.currentBatch = batchIndex;
        tournamentState.tournamentProgress.statusText = `Đang chạy Batch ${batchIndex}/${totalBatches} (${currentBatch.length} trận)...`;
        broadcastSSE('tournament_progress', tournamentState.tournamentProgress);

        for (const pair of currentBatch) {
          const botRedConfig = {
            id: pair.red.botId,
            name: pair.red.botName,
            author: pair.red.author,
            language: pair.red.language,
            code: { code: pair.red.botCode, language: pair.red.language }
          };
          const botBlueConfig = {
            id: pair.blue.botId,
            name: pair.blue.botName,
            author: pair.blue.author,
            language: pair.blue.language,
            code: { code: pair.blue.botCode, language: pair.blue.language }
          };

          const matchResult = await new Promise(resolve => {
            setImmediate(() => {
              const res = playMatch(botRedConfig, botBlueConfig, { timeoutMs: 200 });
              resolve(res);
            });
          });

          completedCount++;

          dbMatches.set(matchResult.id, {
            ...matchResult,
            roomId: 'PUBLIC',
            timestamp: Date.now()
          });

          const redRecord = dbPlayers.get(pair.red.botId);
          const blueRecord = dbPlayers.get(pair.blue.botId);

          if (redRecord) redRecord.lastMatchId = matchResult.id;
          if (blueRecord) blueRecord.lastMatchId = matchResult.id;

          if (redRecord && blueRecord) {
            redRecord.matchesPlayed += 1;
            blueRecord.matchesPlayed += 1;
            redRecord.errors += matchResult.botRed.errors || 0;
            blueRecord.errors += matchResult.botBlue.errors || 0;

            if (matchResult.winner === 'RED') {
              redRecord.wins += 1;
              redRecord.score += SCORING.WIN;
              blueRecord.losses += 1;
              blueRecord.score += SCORING.LOSS;
            } else if (matchResult.winner === 'BLUE') {
              blueRecord.wins += 1;
              blueRecord.score += SCORING.WIN;
              redRecord.losses += 1;
              redRecord.score += SCORING.LOSS;
            } else {
              redRecord.draws += 1;
              redRecord.score += SCORING.DRAW;
              blueRecord.draws += 1;
              blueRecord.score += SCORING.DRAW;
            }
          }
        }

        tournamentState.tournamentProgress.completedMatches = completedCount;
        tournamentState.tournamentProgress.percentage = Math.round((completedCount / totalMatches) * 100);

        savePersistedData();
        broadcastSSE('leaderboard_updated', {
          roomId: 'PUBLIC',
          leaderboard: getSortedLeaderboard('PUBLIC')
        });
        broadcastSSE('tournament_progress', tournamentState.tournamentProgress);

        // Nghỉ ngắn giữa các batch để không block event loop
        await new Promise(r => setTimeout(r, WORKER_REST_MS));
      }

      tournamentState.status = 'COMPLETED';
      tournamentState.tournamentProgress.isRunning = false;
      tournamentState.tournamentProgress.completedMatches = totalMatches;
      tournamentState.tournamentProgress.percentage = 100;
      tournamentState.tournamentProgress.statusText = `🎉 Toàn bộ giải đấu đã hoàn thành xuất sắc (${totalMatches} trận)!`;

      saveTournamentConfig();
      savePersistedData();
      isTournamentRunning = false;

      broadcastSSE('tournament_completed', tournamentState.tournamentProgress);
      broadcastSSE('leaderboard_updated', {
        roomId: 'PUBLIC',
        leaderboard: getSortedLeaderboard('PUBLIC')
      });
      console.log(`🏆 [Tournament] Đã hoàn tất toàn bộ giải đấu (${totalMatches} trận)!`);
    })().catch(err => {
      console.error('[Tournament] Lỗi khi chạy giải đấu:', err);
      isTournamentRunning = false;
      tournamentState.tournamentProgress.isRunning = false;
      tournamentState.tournamentProgress.statusText = `Lỗi: ${err.message}`;
      saveTournamentConfig();
    });

  } catch (err) {
    console.error('Error in /api/admin/tournament/run-all:', err);
    return res.status(500).json({ error: 'Lỗi server khi khởi chạy giải đấu.' });
  }
});

// ============================================================================
// 4. API BOT & MATCH ENDPOINTS (HTTP REST)
// ============================================================================

/**
 * 1. POST /api/bot/submit
 * Lưu/cập nhật bot, lập danh sách đối thủ và đưa vào hàng đợi xoay vòng `submissionQueue`
 */
app.post('/api/bot/submit', (req, res) => {
  try {
    const { playerId, botId, botName, name, playerName, author, language, botCode, roomId } = req.body;

    if (!botCode || typeof botCode !== 'string' || botCode.trim().length === 0) {
      return res.status(400).json({ error: 'botCode is required and cannot be empty.' });
    }

    // Kiểm tra thời hạn đăng ký giải đấu
    const authUser = extractUserFromReq(req);
    const isAdmin = authUser && authUser.role === 'admin';
    if (!isRegistrationOpenNow() && !isAdmin) {
      return res.status(403).json({
        error: 'Cổng nộp bot hiện đang đóng hoặc đã hết hạn đăng ký giải đấu!',
        details: {
          isOpenForRegistration: tournamentState.isOpenForRegistration,
          registrationStart: tournamentState.registrationStart,
          registrationEnd: tournamentState.registrationEnd
        }
      });
    }

    const assignedId = (botId || playerId || (authUser ? `player_${authUser.userId}` : `player_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`)).trim();
    const assignedBotName = (botName || name || playerName || 'AlphaBot').trim();
    const assignedAuthor = (author || playerName || (authUser ? authUser.username : 'Anonymous')).trim();
    const assignedLanguage = (language || 'javascript').toLowerCase();
    const targetRoomId = (roomId || 'PUBLIC').trim().toUpperCase();

    // Lưu hoặc cập nhật thông tin bot vào dbPlayers
    const existing = dbPlayers.get(assignedId);
    const record = normalizePlayerRecord({
      id: assignedId,
      botId: assignedId,
      playerId: assignedId,
      name: assignedBotName,
      botName: assignedBotName,
      playerName: assignedBotName,
      author: assignedAuthor,
      language: assignedLanguage,
      botCode: botCode.trim(),
      score: existing ? existing.score : 0,
      wins: existing ? existing.wins : 0,
      draws: existing ? existing.draws : 0,
      losses: existing ? existing.losses : 0,
      errors: existing ? existing.errors : 0,
      matchesPlayed: existing ? existing.matchesPlayed : 0,
      lastMatchId: existing ? existing.lastMatchId : null,
      roomId: targetRoomId,
      updatedAt: Date.now()
    });

    dbPlayers.set(assignedId, record);
    savePersistedData();

    // Đưa vào hàng đợi xoay vòng và kích hoạt Worker
    enqueueBotForRoundRobin(assignedId, targetRoomId);

    const queuePos = submissionQueue.findIndex(j => j.botId === assignedId) + 1 || 1;

    return res.status(200).json({
      success: true,
      message: 'Đã vào hàng đợi',
      queuePosition: queuePos,
      data: {
        id: assignedId,
        botId: assignedId,
        playerId: assignedId,
        name: assignedBotName,
        botName: assignedBotName,
        author: assignedAuthor,
        language: assignedLanguage,
        roomId: targetRoomId,
        currentScore: record.score,
        lastMatchId: record.lastMatchId,
        queuePosition: queuePos
      }
    });
  } catch (error) {
    console.error('Error in /api/bot/submit:', error);
    return res.status(500).json({ error: 'Internal server error while submitting bot.' });
  }
});

/**
 * 2. GET /api/leaderboard?roomId=...
 * Trả về bảng xếp hạng đã chuẩn hóa đầy đủ cả `name` lẫn `botName`, `id` lẫn `botId` và `lastMatchId`
 */
app.get('/api/leaderboard', (req, res) => {
  try {
    const roomId = (req.query.roomId || 'PUBLIC').trim().toUpperCase();
    syncAndEnsureLastMatchIds();
    const leaderboard = getSortedLeaderboard(roomId);

    // 20 trận gần đây nhất của phòng
    const recentMatches = Array.from(dbMatches.values())
      .filter(m => (m.roomId || 'PUBLIC') === roomId)
      .slice(-20)
      .reverse()
      .map(m => ({
        id: m.id,
        botRed: {
          ...m.botRed,
          name: m.botRed?.name || m.botRed?.botName || 'Red Bot',
          botName: m.botRed?.botName || m.botRed?.name || 'Red Bot'
        },
        botBlue: {
          ...m.botBlue,
          name: m.botBlue?.name || m.botBlue?.botName || 'Blue Bot',
          botName: m.botBlue?.botName || m.botBlue?.name || 'Blue Bot'
        },
        winner: m.winner,
        winnerBotId: m.winnerBotId,
        totalTurns: m.totalTurns,
        timestamp: m.timestamp
      }));

    return res.status(200).json({
      success: true,
      roomId,
      isBatchRunning: isWorkerRunning,
      queueLength: submissionQueue.length,
      leaderboard,
      recentMatches
    });
  } catch (error) {
    console.error('Error in /api/leaderboard:', error);
    return res.status(500).json({ error: 'Internal server error while fetching leaderboard.' });
  }
});

/**
 * 3. GET /api/matches/:matchId
 * Lấy log chi tiết trận đấu để phát Replay
 */
app.get('/api/matches/:matchId', (req, res) => {
  try {
    const { matchId } = req.params;
    const match = dbMatches.get(matchId);

    if (!match) {
      return res.status(404).json({ error: `Match ${matchId} not found.` });
    }

    return res.status(200).json({
      success: true,
      match
    });
  } catch (error) {
    console.error('Error in /api/matches/:matchId:', error);
    return res.status(500).json({ error: 'Internal server error while fetching match details.' });
  }
});

/**
 * 4. GET /api/room/create
 * Tạo mã phòng riêng
 */
app.get('/api/room/create', (req, res) => {
  try {
    const newRoomId = `ROOM_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    return res.status(201).json({
      success: true,
      data: { roomId: newRoomId, createdAt: Date.now() }
    });
  } catch (error) {
    console.error('Error in /api/room/create:', error);
    return res.status(500).json({ error: 'Internal server error while creating room.' });
  }
});

// ============================================================================
// KHỞI ĐỘNG SERVER
// ============================================================================
const server = app.listen(PORT, () => {
  console.log(`====================================================================`);
  console.log(`🏰 RPS ARENA 9X9 - ROUND-ROBIN QUEUE CHUNKING SERVER`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`💾 Data Path: ${DATA_DIR}`);
  console.log(`👥 Loaded Bots: ${dbPlayers.size}`);
  console.log(`⚔️  Loaded Matches: ${dbMatches.size}`);
  console.log(`⚙️  Batch Quota: Max ${BATCH_SIZE} matches / turn (Rest: ${WORKER_REST_MS}ms)`);
  console.log(`====================================================================`);
});

export { 
  app, 
  server, 
  dbPlayers, 
  dbMatches, 
  submissionQueue, 
  processQueue, 
  enqueueBotForRoundRobin, 
  getSortedLeaderboard 
};
