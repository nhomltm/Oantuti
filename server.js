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

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { 
  GUARDIAN_AND_STRIKER_BOT_CODE, 
  HUNTER_BOT_CODE, 
  RUSHER_BOT_CODE, 
  RANDOM_BOT_CODE 
} from './botRunner.js';
import { playMatch, SCORING } from './tournamentEngine.js';
import db, { 
  normalizePlayerRecord, 
  normalizeTournamentRecord, 
  normalizeUserRecord, 
  hashPassword, 
  verifyPassword 
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bắt các lỗi unhandled để server hoạt động bền bỉ, không crash ngoài ý muốn
process.on('uncaughtException', (err) => {
  console.error('💥 [Uncaught Exception]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 [Unhandled Rejection]:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const BATCH_SIZE = 10; // Lát cắt tối đa 10 trận mỗi lượt xoay vòng
const WORKER_REST_MS = 80; // Nghỉ 80ms giữa mỗi batch để không nghẽn Event Loop

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ============================================================================
// 1. KHỞI TẠO LỚP LƯU TRỮ DỮ LIỆU ĐỘC LẬP (DATABASE SERVICE / REPOSITORY)
// ============================================================================
// Tự động kết nối Supabase Cloud nếu có cấu hình trong .env,
// hoặc chạy chế độ In-Memory RAM an toàn (0% ghi đĩa cục bộ).
await db.init();

// Tham chiếu Maps bộ nhớ đệm đồng bộ từ Database Service
const dbPlayers = db.players;
const dbMatches = db.matches;
const dbTournaments = db.tournaments;
const dbUsers = db.users;
const activeSessions = new Map(); // token -> { userId, username, role, expiresAt }

// ============================================================================
// HỆ THỐNG XÁC THỰC MÃ HÓA & QUẢN LÝ NGƯỜI DÙNG (AUTH & ROLES)
// ============================================================================

function loadUsers() {
  // Dữ liệu người dùng được nạp và đồng bộ tự động qua db.init()
}

function saveUsers(user) {
  if (user) {
    db.saveUser(user).catch(() => {});
  }
}

// ============================================================================
// HỆ THỐNG CẤU HÌNH & VẬN HÀNH GIẢI ĐẤU ĐA VÒNG (MULTI-STAGE TOURNAMENT ENGINE)
// ============================================================================

function loadTournaments() {
  // Giải đấu được nạp và đồng bộ tự động qua db.init()
}

function saveTournaments(tour) {
  if (tour) {
    db.saveTournament(tour).catch(err => {
      console.error('[Tournaments] Lỗi khi lưu tournament:', err.message);
    });
  } else {
    for (const t of dbTournaments.values()) {
      db.saveTournament(t).catch(() => {});
    }
  }
}

// Lấy giải đấu Toàn Cầu chính đang hoạt động
function getPrimaryGlobalTournament() {
  for (const t of dbTournaments.values()) {
    if (t.type === 'GLOBAL' && t.status !== 'DELETED') return t;
  }
  const all = Array.from(dbTournaments.values());
  return all[0] || null;
}

// Kiểm tra thời hạn đăng ký của một giải đấu
function isTournamentRegistrationOpen(tour) {
  if (!tour) return false;
  if (!tour.isOpenForRegistration || tour.status === 'PAUSED' || tour.status === 'COMPLETED') return false;
  const now = Date.now();
  const start = new Date(tour.registrationStart).getTime();
  const end = new Date(tour.registrationEnd).getTime();

  if (!isNaN(start) && now < start) return false;
  if (!isNaN(end) && now > end) return false;
  return true;
}

// Giữ lại tournamentState cho các module tương thích ngược
const tournamentState = {
  get isOpenForRegistration() {
    const t = getPrimaryGlobalTournament();
    return t ? t.isOpenForRegistration : true;
  },
  set isOpenForRegistration(val) {
    const t = getPrimaryGlobalTournament();
    if (t) { t.isOpenForRegistration = val; saveTournaments(); }
  },
  get registrationStart() {
    const t = getPrimaryGlobalTournament();
    return t ? t.registrationStart : new Date().toISOString();
  },
  set registrationStart(val) {
    const t = getPrimaryGlobalTournament();
    if (t) { t.registrationStart = val; saveTournaments(); }
  },
  get registrationEnd() {
    const t = getPrimaryGlobalTournament();
    return t ? t.registrationEnd : new Date().toISOString();
  },
  set registrationEnd(val) {
    const t = getPrimaryGlobalTournament();
    if (t) { t.registrationEnd = val; saveTournaments(); }
  },
  get tournamentStart() {
    const t = getPrimaryGlobalTournament();
    return t ? (t.registrationEnd || new Date().toISOString()) : new Date().toISOString();
  },
  get status() {
    const t = getPrimaryGlobalTournament();
    return t ? t.status : 'REGISTRATION';
  },
  set status(val) {
    const t = getPrimaryGlobalTournament();
    if (t) { t.status = val; saveTournaments(); }
  },
  get prizes() {
    const t = getPrimaryGlobalTournament();
    return t ? t.prizes : [];
  },
  set prizes(val) {
    const t = getPrimaryGlobalTournament();
    if (t) { t.prizes = val; saveTournaments(); }
  },
  get isPrizeAnnounced() {
    const t = getPrimaryGlobalTournament();
    return t ? t.isPrizeAnnounced : true;
  },
  set isPrizeAnnounced(val) {
    const t = getPrimaryGlobalTournament();
    if (t) { t.isPrizeAnnounced = val; saveTournaments(); }
  },
  get tournamentProgress() {
    const t = getPrimaryGlobalTournament();
    return t && t.progress ? t.progress : { isRunning: false, totalMatches: 0, completedMatches: 0, percentage: 0, statusText: 'Sẵn sàng' };
  },
  set tournamentProgress(val) {
    const t = getPrimaryGlobalTournament();
    if (t) { t.progress = val; }
  }
};

function saveTournamentConfig() {
  saveTournaments();
}

function loadTournamentConfig() {
  loadTournaments();
}

function isRegistrationOpenNow() {
  return isTournamentRegistrationOpen(getPrimaryGlobalTournament());
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
    return res.status(401).json({
      success: false,
      error: 'Vui lòng đăng nhập để nộp bot!',
      message: 'Vui lòng đăng nhập để nộp bot!'
    });
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


function syncAndEnsureLastMatchIds() {
  // Được xử lý và đảm bảo tự động trong db.init()
}

function loadPersistedData() {
  // Khởi tạo hoàn toàn tự động qua db.init()
}

function pruneOldMatches(maxMatches = 100) {
  if (db.adapter && typeof db.adapter.pruneOldMatches === 'function') {
    db.adapter.pruneOldMatches(maxMatches);
  }
}

function savePersistedData() {
  // Hoàn toàn không ghi file cục bộ. db.js tự động xử lý lưu trữ bền vững (Supabase Cloud / In-Memory RAM).
}

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
// 2. THUẬT TOÁN GHÉP ĐẤU VÒNG TRÒN 1 LƯỢT (C_n^2) & HÀNG CHỜ ĐẤU TỰ ĐỘNG
// ============================================================================

/**
 * Trợ thủ canonical key cho cặp bot: luôn sắp xếp thứ tự ID để Bot_A và Bot_B
 * chỉ tạo ra đúng 1 key nhận diện duy nhất `idA__idB`.
 */
function getMatchPairKey(id1, id2) {
  return [String(id1), String(id2)].sort().join('__');
}

/**
 * Cấu hình hệ thống: Hàng Chờ Đấu Tự Động (Auto-Queue on Submit)
 * Mặc định: BẬT (true). Admin có thể bật/tắt linh hoạt qua API.
 */
let isAutoQueueEnabled = true;

/**
 * Hàng đợi các trận đấu chưa đấu:
 * Mỗi phần tử là 1 trận đấu cụ thể:
 * {
 *   id: string,
 *   pairKey: string,
 *   redId: string,
 *   blueId: string,
 *   roomId: string,
 *   tournamentId: string|null,
 *   stageIndex: number
 * }
 */
const matchQueue = [];
// Alias giữ tương thích ngược với các hàm/endpoint cũ
const submissionQueue = matchQueue;
let isWorkerRunning = false;

/**
 * Kiểm tra xem cặp 2 bot đã từng thi đấu với nhau trong phòng / giải đấu chưa
 * (kiểm tra cả 2 chiều Red-Blue và Blue-Red).
 */
async function hasMatchBeenPlayed(botId1, botId2, roomId = 'PUBLIC', tournamentId = null) {
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

  // 1. Kiểm tra cache RAM dbMatches trước
  for (const m of dbMatches.values()) {
    const rId = m.botRed?.id || m.botRed?.botId;
    const bId = m.botBlue?.id || m.botBlue?.botId;
    if ((rId === botId1 && bId === botId2) || (rId === botId2 && bId === botId1)) {
      if (tournamentId && m.tournamentId === tournamentId) return true;
      if (!tournamentId && (m.roomId || 'PUBLIC').trim().toUpperCase() === normRoom) return true;
    }
  }

  // 2. Kiểm tra database Supabase nếu có
  if (db.adapter && db.adapter.client) {
    try {
      let query = db.adapter.client.from('matches').select('id, tournament_id, room_id')
        .or(`and(red_bot_id.eq.${botId1},blue_bot_id.eq.${botId2}),and(red_bot_id.eq.${botId2},blue_bot_id.eq.${botId1})`);
      if (tournamentId) {
        query = query.eq('tournament_id', tournamentId);
      } else if (normRoom !== 'PUBLIC') {
        query = query.eq('room_id', normRoom);
      }
      const { data, error } = await query.limit(1);
      if (!error && Array.isArray(data) && data.length > 0) {
        return true;
      }
    } catch (e) {
      // Bỏ qua lỗi truy vấn nhẹ
    }
  }

  return false;
}

/**
 * Kiểm tra xem trận đấu giữa 2 bot đã đang nằm trong hàng chờ thi đấu chưa
 */
function isMatchInQueue(botId1, botId2, roomId = 'PUBLIC', tournamentId = null) {
  const key = getMatchPairKey(botId1, botId2);
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();
  return matchQueue.some(item => {
    const itemKey = getMatchPairKey(item.redId, item.blueId);
    if (itemKey !== key) return false;
    if (tournamentId) {
      return item.tournamentId === tournamentId;
    }
    return (item.roomId || 'PUBLIC').trim().toUpperCase() === normRoom;
  });
}

/**
 * Tính toán và đồng bộ lại điểm số cho toàn bộ bot trong phòng / giải đấu
 * từ các trận đấu còn lại (dùng khi một bot cập nhật code mới và reset lịch sử thi đấu).
 */
async function recalculateStats(roomId = 'PUBLIC', tournamentId = null) {
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

  // 1. Lấy danh sách bots thuộc scope
  const filter = {};
  if (tournamentId) filter.tournamentId = tournamentId;
  else if (normRoom !== 'PUBLIC') filter.roomId = normRoom;

  const playersInScope = await db.getPlayers(filter);

  // Reset điểm số của các bot trong scope
  for (const p of playersInScope) {
    p.score = 0;
    p.wins = 0;
    p.draws = 0;
    p.losses = 0;
    p.errors = 0;
    p.matchesPlayed = 0;
    p.lastMatchId = null;
  }

  // 2. Lấy các trận đấu còn lại từ DB
  const remainingMatches = await db.getRecentMatches({ roomId: normRoom, tournamentId }, 5000);
  remainingMatches.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const playerMap = new Map();
  for (const p of playersInScope) {
    playerMap.set(p.id, p);
    if (p.botId) playerMap.set(p.botId, p);
  }

  for (const m of remainingMatches) {
    const redId = m.botRed?.id || m.botRed?.botId;
    const blueId = m.botBlue?.id || m.botBlue?.botId;
    const pRed = playerMap.get(redId);
    const pBlue = playerMap.get(blueId);

    if (pRed) {
      pRed.matchesPlayed = (pRed.matchesPlayed || 0) + 1;
      pRed.errors = (pRed.errors || 0) + (m.botRed?.errors || 0);
      pRed.lastMatchId = m.id;
    }
    if (pBlue) {
      pBlue.matchesPlayed = (pBlue.matchesPlayed || 0) + 1;
      pBlue.errors = (pBlue.errors || 0) + (m.botBlue?.errors || 0);
      pBlue.lastMatchId = m.id;
    }

    if (m.winner === 'RED') {
      if (pRed) { pRed.wins = (pRed.wins || 0) + 1; pRed.score = (pRed.score || 0) + SCORING.WIN; }
      if (pBlue) { pBlue.losses = (pBlue.losses || 0) + 1; pBlue.score = (pBlue.score || 0) + SCORING.LOSS; }
    } else if (m.winner === 'BLUE') {
      if (pBlue) { pBlue.wins = (pBlue.wins || 0) + 1; pBlue.score = (pBlue.score || 0) + SCORING.WIN; }
      if (pRed) { pRed.losses = (pRed.losses || 0) + 1; pRed.score = (pRed.score || 0) + SCORING.LOSS; }
    } else {
      if (pRed) { pRed.draws = (pRed.draws || 0) + 1; pRed.score = (pRed.score || 0) + SCORING.DRAW; }
      if (pBlue) { pBlue.draws = (pBlue.draws || 0) + 1; pBlue.score = (pBlue.score || 0) + SCORING.DRAW; }
    }
  }

  // Lưu lại các players và cập nhật dbPlayers
  for (const p of playersInScope) {
    dbPlayers.set(p.id, p);
    if (p.botId) dbPlayers.set(p.botId, p);
    await db.savePlayer(p);
  }

  // Đồng bộ với stage.standings trong tournament
  if (tournamentId) {
    const tour = dbTournaments.get(tournamentId);
    if (tour && Array.isArray(tour.stages)) {
      const stage = tour.stages[0];
      if (stage && Array.isArray(stage.standings)) {
        for (const st of stage.standings) {
          const p = playerMap.get(st.botId);
          if (p) {
            st.score = p.score;
            st.wins = p.wins;
            st.draws = p.draws;
            st.losses = p.losses;
            st.errors = p.errors;
            st.matchesPlayed = p.matchesPlayed;
            st.lastMatchId = p.lastMatchId;
          }
        }
        stage.standings.sort((a, b) => b.score - a.score || b.wins - a.wins || a.errors - b.errors);
        await db.saveTournament(tour);
      }
    }
  }
}

/**
 * Đưa các trận đấu chưa diễn ra của 1 bot với các đối thủ trong phòng vào hàng đợi
 * Đảm bảo mỗi cặp bot chỉ đấu ĐÚNG 1 TRẬN DUY NHẤT (Single Round-Robin C_n^2).
 * Khi bot thứ 3 (hoặc N) nộp vào, sẽ tự động sinh trận đấu với TẤT CẢ các bot hiện có!
 */
async function enqueueBotUnplayedMatches(botId, roomId = 'PUBLIC', tournamentId = null) {
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

  // 1. Lấy danh sách toàn bộ các bot từ Database
  const filter = {};
  if (tournamentId) {
    filter.tournamentId = tournamentId;
  } else if (normRoom !== 'PUBLIC') {
    filter.roomId = normRoom;
  }
  let allBots = await db.getPlayers(filter);

  // Đảm bảo cache RAM dbPlayers đồng bộ đầy đủ
  for (const b of allBots) {
    dbPlayers.set(b.id, b);
    if (b.botId) dbPlayers.set(b.botId, b);
  }

  // 2. Lọc danh sách đối thủ (tất cả các bot khác bot hiện tại)
  const opponents = allBots.filter(p => (p.botId || p.id) !== botId);

  let addedCount = 0;
  for (const opp of opponents) {
    const oppId = opp.botId || opp.id;
    if (!oppId || oppId === botId) continue;

    const alreadyPlayed = await hasMatchBeenPlayed(botId, oppId, normRoom, tournamentId);
    const alreadyQueued = isMatchInQueue(botId, oppId, normRoom, tournamentId);

    if (!alreadyPlayed && !alreadyQueued) {
      const isBotRed = ((matchQueue.length + addedCount) % 2 === 0);
      matchQueue.push({
        id: `match_job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        pairKey: getMatchPairKey(botId, oppId),
        redId: isBotRed ? botId : oppId,
        blueId: isBotRed ? oppId : botId,
        roomId: normRoom,
        tournamentId: tournamentId || null,
        stageIndex: 1
      });
      addedCount++;
    }
  }

  console.log(`📥 [MatchQueue] Bot "${botId}" đã ghép thêm ${addedCount} trận mới vào hàng chờ (Đối thủ hiện có: ${opponents.length}). Tổng hàng đợi: ${matchQueue.length} trận.`);

  // 3. Kích hoạt worker nếu đang nghỉ
  if (matchQueue.length > 0 && !isWorkerRunning) {
    processMatchQueue();
  }

  return addedCount;
}

/**
 * Ghép đấu toàn bộ các cặp bot chưa từng đấu với nhau trong phòng / giải đấu
 */
async function enqueueAllUnplayedMatches(roomId = 'PUBLIC', tournamentId = null) {
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();
  const filter = {};
  if (tournamentId) filter.tournamentId = tournamentId;
  else if (normRoom !== 'PUBLIC') filter.roomId = normRoom;

  const eligible = await db.getPlayers(filter);
  for (const b of eligible) {
    dbPlayers.set(b.id, b);
    if (b.botId) dbPlayers.set(b.botId, b);
  }

  let addedCount = 0;
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const idA = eligible[i].botId || eligible[i].id;
      const idB = eligible[j].botId || eligible[j].id;
      if (!idA || !idB || idA === idB) continue;

      const alreadyPlayed = await hasMatchBeenPlayed(idA, idB, normRoom, tournamentId);
      const alreadyQueued = isMatchInQueue(idA, idB, normRoom, tournamentId);

      if (!alreadyPlayed && !alreadyQueued) {
        const isARed = ((i + j) % 2 === 0);
        matchQueue.push({
          id: `match_job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          pairKey: getMatchPairKey(idA, idB),
          redId: isARed ? idA : idB,
          blueId: isARed ? idB : idA,
          roomId: normRoom,
          tournamentId: tournamentId || null,
          stageIndex: 1
        });
        addedCount++;
      }
    }
  }

  console.log(`⚡ [MatchQueue] Quét toàn bộ: Đã thêm ${addedCount} trận chưa đấu vào hàng đợi.`);
  if (matchQueue.length > 0 && !isWorkerRunning) {
    processMatchQueue();
  }
  return addedCount;
}

// Giữ hàm cũ để tương thích với các lệnh gọi khác nếu có
function enqueueBotForRoundRobin(botId, roomId = 'PUBLIC') {
  return enqueueBotUnplayedMatches(botId, roomId, null);
}

/**
 * Worker xử lý hàng đợi trận đấu tự động, tuần tự và liên tục (Queue Consumer Auto-Runner)
 * Đảm bảo không bao giờ bị kẹt cờ isWorkerRunning và chạy hết hàng đợi đến khi rỗng.
 */
async function processMatchQueue() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;

  try {
    while (matchQueue.length > 0) {
      const job = matchQueue.shift();
      if (!job) continue;

      // Lấy thông tin bot Red & Blue (từ cache RAM hoặc truy vấn DB)
      let challenger = dbPlayers.get(job.redId) || await db.getPlayerById(job.redId);
      let opponent = dbPlayers.get(job.blueId) || await db.getPlayerById(job.blueId);

      if (!challenger || !opponent) {
        console.warn(`⚠️ [MatchQueue] Bỏ qua trận ${job.id}: Không tìm thấy dữ liệu bot Red=${job.redId} hoặc Blue=${job.blueId}`);
        continue;
      }

      // Đồng bộ lại vào RAM
      dbPlayers.set(challenger.botId || challenger.id, challenger);
      dbPlayers.set(opponent.botId || opponent.id, opponent);

      const botRedConfig = {
        id: challenger.botId || challenger.id,
        name: challenger.botName || challenger.name,
        author: challenger.author,
        language: challenger.language,
        code: { code: challenger.botCode, language: challenger.language }
      };

      const botBlueConfig = {
        id: opponent.botId || opponent.id,
        name: opponent.botName || opponent.name,
        author: opponent.author,
        language: opponent.language,
        code: { code: opponent.botCode, language: opponent.language }
      };

      console.log(`⚔️ [MatchQueue] Đang đấu: "${botRedConfig.name}" (Red) vs "${botBlueConfig.name}" (Blue) [Còn lại: ${matchQueue.length} trận]`);

      // Thực thi trận đấu qua tournamentEngine
      let matchResult;
      try {
        matchResult = playMatch(botRedConfig, botBlueConfig, { timeoutMs: 200 });
      } catch (err) {
        console.error(`❌ [MatchQueue] Lỗi khi thi đấu giữa ${botRedConfig.name} và ${botBlueConfig.name}:`, err);
        continue;
      }

      // 1. Lưu lịch sử trận đấu vào Database
      const matchRecord = {
        ...matchResult,
        roomId: job.roomId,
        tournamentId: job.tournamentId,
        stageIndex: job.stageIndex || 1,
        timestamp: Date.now()
      };
      await db.saveMatch(matchRecord);
      dbMatches.set(matchRecord.id, matchRecord);

      // 2. Cập nhật điểm số và kết quả cho cả 2 bot (Red & Blue) vào Database
      challenger.lastMatchId = matchResult.id;
      opponent.lastMatchId = matchResult.id;
      challenger.matchesPlayed = (challenger.matchesPlayed || 0) + 1;
      opponent.matchesPlayed = (opponent.matchesPlayed || 0) + 1;
      challenger.errors = (challenger.errors || 0) + (matchResult.botRed.errors || 0);
      opponent.errors = (opponent.errors || 0) + (matchResult.botBlue.errors || 0);

      if (matchResult.winner === 'RED') {
        challenger.wins = (challenger.wins || 0) + 1;
        challenger.score = (challenger.score || 0) + SCORING.WIN; // 3 điểm
        opponent.losses = (opponent.losses || 0) + 1;
        opponent.score = (opponent.score || 0) + SCORING.LOSS; // 0 điểm
      } else if (matchResult.winner === 'BLUE') {
        opponent.wins = (opponent.wins || 0) + 1;
        opponent.score = (opponent.score || 0) + SCORING.WIN; // 3 điểm
        challenger.losses = (challenger.losses || 0) + 1;
        challenger.score = (challenger.score || 0) + SCORING.LOSS; // 0 điểm
      } else {
        // HÒA (DRAW: winner === 'DRAW' hoặc null)
        challenger.draws = (challenger.draws || 0) + 1;
        challenger.score = (challenger.score || 0) + SCORING.DRAW; // 1 điểm
        opponent.draws = (opponent.draws || 0) + 1;
        opponent.score = (opponent.score || 0) + SCORING.DRAW; // 1 điểm
      }

      challenger.updatedAt = Date.now();
      opponent.updatedAt = Date.now();

      await db.savePlayer(challenger);
      await db.savePlayer(opponent);

      // 3. Nếu trận thuộc giải đấu, cập nhật stage.standings
      if (job.tournamentId) {
        const tour = await db.getTournamentById(job.tournamentId);
        if (tour && Array.isArray(tour.stages)) {
          const stage = tour.stages.find(s => s.stageIndex === (job.stageIndex || tour.currentStageIndex));
          if (stage && Array.isArray(stage.standings)) {
            const redSt = stage.standings.find(s => s.botId === botRedConfig.id);
            const blueSt = stage.standings.find(s => s.botId === botBlueConfig.id);

            if (redSt) {
              redSt.matchesPlayed = (redSt.matchesPlayed || 0) + 1;
              redSt.errors = (redSt.errors || 0) + (matchResult.botRed.errors || 0);
              redSt.lastMatchId = matchResult.id;
            }
            if (blueSt) {
              blueSt.matchesPlayed = (blueSt.matchesPlayed || 0) + 1;
              blueSt.errors = (blueSt.errors || 0) + (matchResult.botBlue.errors || 0);
              blueSt.lastMatchId = matchResult.id;
            }

            if (matchResult.winner === 'RED') {
              if (redSt) { redSt.wins = (redSt.wins || 0) + 1; redSt.score = (redSt.score || 0) + SCORING.WIN; }
              if (blueSt) { blueSt.losses = (blueSt.losses || 0) + 1; blueSt.score = (blueSt.score || 0) + SCORING.LOSS; }
            } else if (matchResult.winner === 'BLUE') {
              if (blueSt) { blueSt.wins = (blueSt.wins || 0) + 1; blueSt.score = (blueSt.score || 0) + SCORING.WIN; }
              if (redSt) { redSt.losses = (redSt.losses || 0) + 1; redSt.score = (redSt.score || 0) + SCORING.LOSS; }
            } else {
              if (redSt) { redSt.draws = (redSt.draws || 0) + 1; redSt.score = (redSt.score || 0) + SCORING.DRAW; }
              if (blueSt) { blueSt.draws = (blueSt.draws || 0) + 1; blueSt.score = (blueSt.score || 0) + SCORING.DRAW; }
            }

            stage.standings.sort((a, b) => b.score - a.score || b.wins - a.wins || a.errors - b.errors);
            await db.saveTournament(tour);
          }
        }
      }

      // Giới hạn bộ nhớ dbMatches tối đa 100 trận trong RAM
      pruneOldMatches(100);

      // 4. Phát sự kiện cập nhật Bảng xếp hạng thời gian thực
      const targetRoom = job.roomId || 'PUBLIC';
      const liveLeaderboard = await db.getLeaderboard(targetRoom, job.tournamentId);
      broadcastSSE('leaderboard_updated', {
        roomId: targetRoom,
        tournamentId: job.tournamentId || null,
        leaderboard: liveLeaderboard,
        queueLength: matchQueue.length,
        isBatchRunning: matchQueue.length > 0,
        lastMatch: {
          id: matchResult.id,
          botRed: botRedConfig.name,
          botBlue: botBlueConfig.name,
          winner: matchResult.winner
        }
      });

      // Nhịp nghỉ ngắn 50ms giữa các trận
      if (matchQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, WORKER_REST_MS || 50));
      }
    }
  } catch (criticalErr) {
    console.error('❌ [MatchQueue Worker Critical Error]:', criticalErr);
  } finally {
    isWorkerRunning = false;
    if (matchQueue.length > 0) {
      setImmediate(processMatchQueue);
    } else {
      console.log(`💤 [MatchQueue] Hàng đợi đã rỗng. Worker chuyển về trạng thái nghỉ (Idle 0% CPU).`);
    }
  }
}

// Alias tương thích
const processQueue = processMatchQueue;

// ============================================================================
// 3. AUTHENTICATION & TOURNAMENT MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * POST /api/auth/register
 * Đăng ký tài khoản người chơi mới (mặc định role 'user')
 */
app.post('/api/auth/register', async (req, res) => {
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

    await db.saveUser(newUser);

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
// HỆ THỐNG ĐIỀU PHỐI GIẢI ĐẤU ĐA VÒNG (MULTI-STAGE EXECUTION ENGINE)
// ============================================================================

let isTournamentRunning = false;

/**
 * Worker chạy Round-Robin cho 1 vòng đấu cụ thể của giải đấu
 */
async function runTournamentStage(tourId, targetStageIndex = null) {
  const tour = dbTournaments.get(tourId);
  if (!tour) throw new Error('Không tìm thấy giải đấu.');

  const stageIdx = targetStageIndex || tour.currentStageIndex;
  const stage = tour.stages.find(s => s.stageIndex === stageIdx);
  if (!stage) throw new Error(`Không tìm thấy vòng đấu số ${stageIdx}.`);

  // Nếu là Vòng 1 và danh sách bot tham gia đang trống, gom toàn bộ bot hợp lệ
  if (stage.stageIndex === 1 && (!stage.participatingBots || stage.participatingBots.length === 0)) {
    const eligible = Array.from(dbPlayers.values()).filter(p => {
      if (tour.type === 'PRIVATE') return p.roomId === tour.id;
      return !p.tournamentId || p.tournamentId === tour.id;
    });
    stage.participatingBots = eligible.map(b => b.botId);
    stage.standings = eligible.map(b => ({
      botId: b.botId,
      name: b.botName || b.name,
      author: b.author,
      score: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      errors: 0,
      matchesPlayed: 0,
      lastMatchId: null
    }));
  }

  if (!stage.participatingBots || stage.participatingBots.length < 2) {
    throw new Error(`Cần tối thiểu 2 bot trong ${stage.name} để tiến hành thi đấu.`);
  }

  // Khởi tạo bảng điểm cho vòng nếu chưa có
  if (!stage.standings || stage.standings.length === 0) {
    stage.standings = stage.participatingBots.map(bId => {
      const p = dbPlayers.get(bId);
      return {
        botId: bId,
        name: p ? (p.botName || p.name) : bId,
        author: p ? p.author : 'Anonymous',
        score: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        errors: 0,
        matchesPlayed: 0,
        lastMatchId: null
      };
    });
  } else {
    // Reset điểm vòng này về 0 khi bắt đầu chạy
    for (const st of stage.standings) {
      st.score = 0;
      st.wins = 0;
      st.draws = 0;
      st.losses = 0;
      st.errors = 0;
      st.matchesPlayed = 0;
    }
  }

  // Tạo danh sách cặp đấu Round-Robin 1 lượt duy nhất (C_n^2 = n * (n - 1) / 2)
  const botIds = stage.participatingBots;
  const matchPairs = [];
  for (let i = 0; i < botIds.length; i++) {
    for (let j = i + 1; j < botIds.length; j++) {
      const bA = dbPlayers.get(botIds[i]);
      const bB = dbPlayers.get(botIds[j]);
      if (bA && bB) {
        if ((i + j) % 2 === 0) {
          matchPairs.push({ red: bA, blue: bB });
        } else {
          matchPairs.push({ red: bB, blue: bA });
        }
      }
    }
  }

  const totalMatches = matchPairs.length;
  const totalBatches = Math.ceil(totalMatches / BATCH_SIZE);

  tour.status = 'RUNNING';
  stage.status = 'RUNNING';
  tour.progress = {
    isRunning: true,
    totalMatches,
    completedMatches: 0,
    currentBatch: 0,
    totalBatches,
    percentage: 0,
    statusText: `Khởi động ${stage.name}: ${botIds.length} bot (${totalMatches} trận chia làm ${totalBatches} batches)...`,
    tournamentId: tour.id,
    stageIndex: stage.stageIndex
  };

  saveTournaments();
  broadcastSSE('tournament_started', { tournamentId: tour.id, progress: tour.progress });

  // Chạy background worker
  (async () => {
    isTournamentRunning = true;
    let completedCount = 0;
    let batchIndex = 0;

    while (matchPairs.length > 0) {
      batchIndex++;
      const currentBatch = matchPairs.splice(0, BATCH_SIZE);

      tour.progress.currentBatch = batchIndex;
      tour.progress.statusText = `Đang chạy ${stage.name} - Batch ${batchIndex}/${totalBatches} (${currentBatch.length} trận)...`;
      broadcastSSE('tournament_progress', { tournamentId: tour.id, progress: tour.progress });

      for (const pair of currentBatch) {
        const botRedConfig = {
          id: pair.red.botId,
          name: pair.red.botName || pair.red.name,
          author: pair.red.author,
          language: pair.red.language,
          code: { code: pair.red.botCode, language: pair.red.language }
        };
        const botBlueConfig = {
          id: pair.blue.botId,
          name: pair.blue.botName || pair.blue.name,
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

        // Lưu log trận đấu kèm tournamentId và stageIndex qua db
        const savedMatch = {
          ...matchResult,
          tournamentId: tour.id,
          stageIndex: stage.stageIndex,
          roomId: tour.id,
          timestamp: Date.now()
        };
        await db.saveMatch(savedMatch);

        // Cập nhật bảng điểm vòng đấu (stage.standings)
        const redStanding = stage.standings.find(s => s.botId === pair.red.botId);
        const blueStanding = stage.standings.find(s => s.botId === pair.blue.botId);

        if (redStanding) {
          redStanding.matchesPlayed = (redStanding.matchesPlayed || 0) + 1;
          redStanding.errors = (redStanding.errors || 0) + (matchResult.botRed.errors || 0);
          redStanding.lastMatchId = matchResult.id;
        }
        if (blueStanding) {
          blueStanding.matchesPlayed = (blueStanding.matchesPlayed || 0) + 1;
          blueStanding.errors = (blueStanding.errors || 0) + (matchResult.botBlue.errors || 0);
          blueStanding.lastMatchId = matchResult.id;
        }

        if (matchResult.winner === 'RED') {
          if (redStanding) { redStanding.wins += 1; redStanding.score += SCORING.WIN; }
          if (blueStanding) { blueStanding.losses += 1; blueStanding.score += SCORING.LOSS; }
        } else if (matchResult.winner === 'BLUE') {
          if (blueStanding) { blueStanding.wins += 1; blueStanding.score += SCORING.WIN; }
          if (redStanding) { redStanding.losses += 1; redStanding.score += SCORING.LOSS; }
        } else {
          // DRAW (Hòa)
          if (redStanding) { redStanding.draws += 1; redStanding.score += SCORING.DRAW; }
          if (blueStanding) { blueStanding.draws += 1; blueStanding.score += SCORING.DRAW; }
        }

        // Cập nhật điểm số và lastMatchId cho player record chính (dbPlayers)
        const pRed = dbPlayers.get(pair.red.botId);
        const pBlue = dbPlayers.get(pair.blue.botId);
        if (pRed && pBlue) {
          pRed.lastMatchId = matchResult.id;
          pBlue.lastMatchId = matchResult.id;
          pRed.matchesPlayed = (pRed.matchesPlayed || 0) + 1;
          pBlue.matchesPlayed = (pBlue.matchesPlayed || 0) + 1;
          pRed.errors = (pRed.errors || 0) + (matchResult.botRed.errors || 0);
          pBlue.errors = (pBlue.errors || 0) + (matchResult.botBlue.errors || 0);

          if (matchResult.winner === 'RED') {
            pRed.wins = (pRed.wins || 0) + 1;
            pRed.score = (pRed.score || 0) + SCORING.WIN;
            pBlue.losses = (pBlue.losses || 0) + 1;
            pBlue.score = (pBlue.score || 0) + SCORING.LOSS;
          } else if (matchResult.winner === 'BLUE') {
            pBlue.wins = (pBlue.wins || 0) + 1;
            pBlue.score = (pBlue.score || 0) + SCORING.WIN;
            pRed.losses = (pRed.losses || 0) + 1;
            pRed.score = (pRed.score || 0) + SCORING.LOSS;
          } else {
            // DRAW (Hòa)
            pRed.draws = (pRed.draws || 0) + 1;
            pRed.score = (pRed.score || 0) + SCORING.DRAW;
            pBlue.draws = (pBlue.draws || 0) + 1;
            pBlue.score = (pBlue.score || 0) + SCORING.DRAW;
          }
          await db.savePlayer(pRed);
          await db.savePlayer(pBlue);
        }
      }

      tour.progress.completedMatches = completedCount;
      tour.progress.percentage = Math.round((completedCount / totalMatches) * 100);

      // Sắp xếp thứ hạng trong vòng sau mỗi batch
      stage.standings.sort((a, b) => b.score - a.score || b.wins - a.wins || a.errors - b.errors);

      await db.saveTournament(tour);

      broadcastSSE('tournament_progress', { tournamentId: tour.id, progress: tour.progress });
      broadcastSSE('leaderboard_updated', {
        tournamentId: tour.id,
        stageIndex: stage.stageIndex,
        leaderboard: stage.standings
      });

      await new Promise(r => setTimeout(r, WORKER_REST_MS));
    }

    stage.status = 'COMPLETED';
    tour.progress.isRunning = false;
    tour.progress.completedMatches = totalMatches;
    tour.progress.percentage = 100;
    tour.progress.statusText = `🎉 Hoàn tất ${stage.name} (${totalMatches} trận)!`;

    // Sắp xếp chung cuộc vòng
    stage.standings.sort((a, b) => b.score - a.score || b.wins - a.wins || a.errors - b.errors);

    // Nếu đã là vòng cuối cùng của giải
    if (stage.stageIndex === tour.stagesCount) {
      tour.status = 'COMPLETED';
      tour.progress.statusText = `🏆 Toàn bộ giải đấu "${tour.name}" đã hoàn thành xuất sắc!`;
    }

    isTournamentRunning = false;
    await db.saveTournament(tour);

    broadcastSSE('tournament_completed', { tournamentId: tour.id, progress: tour.progress, stageIndex: stage.stageIndex });
    broadcastSSE('tournament_updated', { tournament: tour });
    broadcastSSE('leaderboard_updated', {
      tournamentId: tour.id,
      stageIndex: stage.stageIndex,
      leaderboard: stage.standings
    });

    console.log(`🏆 [Tournament] Hoàn tất ${stage.name} của giải "${tour.name}"!`);
  })().catch(err => {
    console.error('[Tournament] Lỗi khi chạy giải đấu:', err);
    isTournamentRunning = false;
    tour.progress.isRunning = false;
    tour.progress.statusText = `Lỗi: ${err.message}`;
    saveTournaments();
  });

  return tour.progress;
}

// ============================================================================
// ADMIN MULTI-STAGE TOURNAMENT ROUTES
// ============================================================================

/**
 * 1. POST /api/admin/tournaments
 * Admin tạo giải đấu mới (hỗ trợ thiết lập 1 đến 5 vòng và Top N thăng hạng)
 */
app.post('/api/admin/tournaments', requireAdmin, (req, res) => {
  try {
    const { name, description, registrationStart, registrationEnd, stagesCount, stages, prizes } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Tên giải đấu là bắt buộc và không được để trống.' });
    }

    const sCount = Math.max(1, Math.min(5, Number(stagesCount) || 1));
    const parsedStages = [];

    for (let i = 1; i <= sCount; i++) {
      const inputStage = Array.isArray(stages) ? stages.find(s => Number(s.stageIndex) === i) : null;
      let defaultStageName = `Vòng ${i}`;
      if (sCount === 1) defaultStageName = 'Vòng Đấu Chính';
      else if (i === 1) defaultStageName = 'Vòng 1: Vòng Bảng (Qualifier)';
      else if (i === sCount) defaultStageName = `Vòng ${i}: Chung Kết (Finals)`;
      else defaultStageName = `Vòng ${i}: Bán Kết / Phân Hạng`;

      const defaultTopN = i === sCount ? 1 : Math.max(2, Math.floor(16 / Math.pow(2, i - 1)));

      parsedStages.push({
        stageIndex: i,
        name: inputStage && inputStage.name ? inputStage.name.trim() : defaultStageName,
        topNToAdvance: inputStage && inputStage.topNToAdvance ? Number(inputStage.topNToAdvance) : defaultTopN,
        status: i === 1 ? 'REGISTRATION' : 'PENDING',
        participatingBots: [],
        standings: [],
        matches: []
      });
    }

    const newTour = {
      id: `tour_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      name: name.trim(),
      description: (description || '').trim(),
      type: 'GLOBAL',
      createdBy: req.user ? req.user.username : 'admin',
      createdAt: Date.now(),
      isOpenForRegistration: true,
      registrationStart: registrationStart || new Date().toISOString(),
      registrationEnd: registrationEnd || new Date(Date.now() + 3600 * 1000 * 24 * 7).toISOString(),
      status: 'REGISTRATION',
      stagesCount: sCount,
      currentStageIndex: 1,
      stages: parsedStages,
      prizes: Array.isArray(prizes) && prizes.length > 0 ? prizes : [
        { id: 'prize_1', rank: 1, title: 'Hạng 1 (Quán Quân)', reward: 'Cúp Vàng + 500.000 VNĐ', badge: '🥇' },
        { id: 'prize_2', rank: 2, title: 'Hạng 2 (Á Quân)', reward: 'Cúp Bạc + 300.000 VNĐ', badge: '🥈' },
        { id: 'prize_3', rank: 3, title: 'Hạng 3 (Quý Quân)', reward: 'Huy Chương Đồng + 100.000 VNĐ', badge: '🥉' }
      ],
      isPrizeAnnounced: false,
      progress: {
        isRunning: false,
        totalMatches: 0,
        completedMatches: 0,
        currentBatch: 0,
        totalBatches: 0,
        percentage: 0,
        statusText: 'Sẵn sàng'
      }
    };

    dbTournaments.set(newTour.id, newTour);
    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: newTour });

    console.log(`[Admin] 🏆 Đã tạo giải đấu mới: "${newTour.name}" (${sCount} vòng)`);
    return res.status(201).json({
      success: true,
      message: `Đã tạo giải đấu "${newTour.name}" thành công với ${sCount} vòng đấu!`,
      tournament: newTour
    });
  } catch (err) {
    console.error('Error in POST /api/admin/tournaments:', err);
    return res.status(500).json({ error: 'Lỗi server khi tạo giải đấu mới.' });
  }
});

/**
 * 2. GET /api/admin/tournaments/all
 * Admin lấy danh sách toàn bộ giải đấu (cả Global Arenas lẫn Private Rooms)
 */
app.get('/api/admin/tournaments/all', requireAdmin, (req, res) => {
  try {
    const list = Array.from(dbTournaments.values())
      .map(t => {
        const curStage = t.stages.find(s => s.stageIndex === t.currentStageIndex) || t.stages[0] || {};
        const botsCount = (t.stages[0]?.participatingBots?.length) ||
          Array.from(dbPlayers.values()).filter(p => p.tournamentId === t.id || (t.type === 'PRIVATE' && p.roomId === t.id)).length;
        const matchesCount = Array.from(dbMatches.values()).filter(m => m.tournamentId === t.id || (t.type === 'PRIVATE' && m.roomId === t.id)).length;

        return {
          id: t.id,
          name: t.name,
          description: t.description,
          type: t.type || 'GLOBAL',
          createdBy: t.createdBy,
          createdAt: t.createdAt,
          status: t.status,
          stagesCount: t.stagesCount,
          currentStageIndex: t.currentStageIndex,
          currentStageName: curStage.name || `Vòng ${t.currentStageIndex}`,
          isOpenForRegistration: t.isOpenForRegistration,
          registrationStart: t.registrationStart,
          registrationEnd: t.registrationEnd,
          prizes: t.prizes,
          isPrizeAnnounced: t.isPrizeAnnounced,
          botsCount,
          matchesCount,
          stages: t.stages,
          progress: t.progress
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    return res.status(200).json({
      success: true,
      totalTournaments: list.length,
      tournaments: list
    });
  } catch (err) {
    console.error('Error in GET /api/admin/tournaments/all:', err);
    return res.status(500).json({ error: 'Lỗi server khi tải danh sách giải đấu.' });
  }
});

/**
 * 3. POST /api/admin/tournaments/:id/start-stage
 * Admin bắt đầu chạy các trận đấu của vòng hiện tại
 */
app.post('/api/admin/tournaments/:id/start-stage', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const tour = dbTournaments.get(id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    if (isTournamentRunning || (tour.progress && tour.progress.isRunning)) {
      return res.status(400).json({ error: 'Một vòng đấu đang trong quá trình chạy, vui lòng chờ hoàn tất!' });
    }

    const stageIdx = req.body.stageIndex || tour.currentStageIndex;
    const progress = await runTournamentStage(tour.id, stageIdx);

    return res.status(200).json({
      success: true,
      message: `Đã kích hoạt thi đấu Vòng ${stageIdx} của giải "${tour.name}"!`,
      progress
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/start-stage:', err);
    return res.status(400).json({ error: err.message || 'Lỗi khi khởi chạy vòng đấu.' });
  }
});

/**
 * 4. POST /api/admin/tournaments/:id/advance-stage
 * Chốt điểm vòng hiện tại, tự động lọc ra Top N bot đủ điều kiện để nạp vào danh sách thi đấu của vòng tiếp theo
 */
app.post('/api/admin/tournaments/:id/advance-stage', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const tour = dbTournaments.get(id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    if (tour.currentStageIndex >= tour.stagesCount) {
      return res.status(400).json({
        error: `Giải đấu đã ở vòng cuối cùng (Vòng ${tour.stagesCount}). Hãy bấm "Kết Thúc & Trao Giải" để hoàn tất!`
      });
    }

    const currentStage = tour.stages.find(s => s.stageIndex === tour.currentStageIndex);
    if (!currentStage) return res.status(400).json({ error: 'Không tìm thấy dữ liệu vòng hiện tại.' });

    // Đảm bảo standings đã được sắp xếp
    if (!currentStage.standings || currentStage.standings.length === 0) {
      return res.status(400).json({
        error: `Vòng ${currentStage.stageIndex} (${currentStage.name}) chưa có kết quả thi đấu để chốt điểm!`
      });
    }

    currentStage.standings.sort((a, b) => b.score - a.score || b.wins - a.wins || a.errors - b.errors);

    const topN = Math.max(1, currentStage.topNToAdvance || Math.floor(currentStage.standings.length / 2));
    const qualifiedBots = currentStage.standings.slice(0, topN);

    if (qualifiedBots.length < 2 && currentStage.stageIndex + 1 < tour.stagesCount) {
      return res.status(400).json({
        error: `Cần tối thiểu 2 bot thăng hạng vào vòng tiếp theo (hiện chỉ có ${qualifiedBots.length} bot).`
      });
    }

    // Đánh dấu vòng cũ hoàn tất
    currentStage.status = 'COMPLETED';

    // Thăng hạng sang vòng tiếp theo
    tour.currentStageIndex += 1;
    const nextStage = tour.stages.find(s => s.stageIndex === tour.currentStageIndex);
    nextStage.participatingBots = qualifiedBots.map(b => b.botId);
    nextStage.standings = qualifiedBots.map(b => ({
      botId: b.botId,
      name: b.name,
      author: b.author,
      score: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      errors: 0,
      matchesPlayed: 0,
      lastMatchId: null
    }));
    nextStage.status = 'PENDING';

    tour.status = 'RUNNING';

    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: tour });
    broadcastSSE('leaderboard_updated', {
      tournamentId: tour.id,
      stageIndex: nextStage.stageIndex,
      leaderboard: nextStage.standings
    });

    console.log(`[Tournament] ⚖️ Đã chốt Vòng ${currentStage.stageIndex} và nạp ${qualifiedBots.length} bot vào ${nextStage.name}!`);
    return res.status(200).json({
      success: true,
      message: `Đã chốt Vòng ${currentStage.stageIndex} và thăng hạng Top ${qualifiedBots.length} bot vào ${nextStage.name}!`,
      currentStageIndex: tour.currentStageIndex,
      advancedBots: qualifiedBots,
      nextStage
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/advance-stage:', err);
    return res.status(500).json({ error: 'Lỗi server khi chuyển vòng giải đấu.' });
  }
});

/**
 * 5. POST /api/admin/tournaments/:id/finish
 * Kết thúc giải đấu và công bố trao thưởng
 */
app.post('/api/admin/tournaments/:id/finish', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const tour = dbTournaments.get(id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    tour.status = 'COMPLETED';
    tour.isPrizeAnnounced = true;
    if (tour.progress) {
      tour.progress.isRunning = false;
      tour.progress.statusText = `🏆 Giải đấu "${tour.name}" đã chính thức kết thúc & hoàn tất trao thưởng!`;
    }

    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: tour });
    broadcastSSE('leaderboard_updated', { tournamentId: tour.id });

    return res.status(200).json({
      success: true,
      message: `Đã hoàn tất và công bố giải thưởng cho giải đấu "${tour.name}"!`,
      tournament: tour
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/finish:', err);
    return res.status(500).json({ error: 'Lỗi server khi kết thúc giải đấu.' });
  }
});

/**
 * 6. POST /api/admin/tournaments/:id/toggle-pause
 * Tạm dừng hoặc Tiếp tục giải đấu / phòng riêng
 */
app.post('/api/admin/tournaments/:id/toggle-pause', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const tour = dbTournaments.get(id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    if (tour.status === 'PAUSED') {
      tour.status = tour.isOpenForRegistration ? 'REGISTRATION' : 'RUNNING';
    } else {
      tour.status = 'PAUSED';
    }

    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: tour });

    return res.status(200).json({
      success: true,
      status: tour.status,
      message: `Trạng thái giải đấu hiện là: ${tour.status}`
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/toggle-pause:', err);
    return res.status(500).json({ error: 'Lỗi server khi chuyển trạng thái tạm dừng.' });
  }
});

/**
 * 7. POST /api/admin/tournaments/:id/toggle-registration
 * Đóng hoặc mở cổng đăng ký của một giải đấu
 */
app.post('/api/admin/tournaments/:id/toggle-registration', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const tour = dbTournaments.get(id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    tour.isOpenForRegistration = !tour.isOpenForRegistration;
    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: tour });

    const statusMsg = tour.isOpenForRegistration ? 'ĐÃ MỞ' : 'ĐÃ KHÓA';
    return res.status(200).json({
      success: true,
      isOpenForRegistration: tour.isOpenForRegistration,
      message: `Cổng nộp bot giải "${tour.name}" hiện ${statusMsg}.`
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/toggle-registration:', err);
    return res.status(500).json({ error: 'Lỗi server khi đổi trạng thái nộp bot.' });
  }
});

/**
 * 8. POST /api/admin/tournaments/:id/delete
 * Xóa một giải đấu hoặc phòng riêng tư (đối với phòng lỗi/spam)
 */
app.post('/api/admin/tournaments/:id/delete', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!dbTournaments.has(id)) {
      return res.status(404).json({ error: 'Không tìm thấy giải đấu cần xóa.' });
    }

    const tour = dbTournaments.get(id);
    dbTournaments.delete(id);
    await db.deleteTournament(id);
    broadcastSSE('tournament_updated', { tournamentId: id, deleted: true });

    console.log(`[Admin] 🗑️ Đã xóa giải đấu / phòng: "${tour.name}" (${id})`);
    return res.status(200).json({
      success: true,
      message: `Đã xóa giải đấu / phòng "${tour.name}" thành công.`
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/delete:', err);
    return res.status(500).json({ error: 'Lỗi server khi xóa giải đấu.' });
  }
});

/**
 * 9. POST /api/admin/tournaments/:id/prizes
 * Cập nhật cơ cấu giải thưởng
 */
app.post('/api/admin/tournaments/:id/prizes', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const tour = dbTournaments.get(id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    const { prizes } = req.body;
    if (!Array.isArray(prizes)) {
      return res.status(400).json({ error: 'Danh sách giải thưởng không hợp lệ.' });
    }

    tour.prizes = prizes.map((p, idx) => ({
      id: p.id || `prize_${Date.now()}_${idx}`,
      rank: Number(p.rank) || (idx + 1),
      title: (p.title || `Hạng ${idx + 1}`).trim(),
      reward: (p.reward || '').trim(),
      badge: p.badge || (idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '✨')
    }));

    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: tour });

    return res.status(200).json({
      success: true,
      message: 'Đã lưu cấu hình giải thưởng thành công!',
      prizes: tour.prizes
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/prizes:', err);
    return res.status(500).json({ error: 'Lỗi server khi cập nhật giải thưởng.' });
  }
});

/**
 * 10. POST /api/admin/tournaments/:id/announce-prizes
 * Bật / tắt công bố giải thưởng
 */
app.post('/api/admin/tournaments/:id/announce-prizes', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const tour = dbTournaments.get(id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    const { isPrizeAnnounced } = req.body;
    tour.isPrizeAnnounced = typeof isPrizeAnnounced === 'boolean' ? isPrizeAnnounced : !tour.isPrizeAnnounced;

    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: tour });

    return res.status(200).json({
      success: true,
      isPrizeAnnounced: tour.isPrizeAnnounced,
      message: tour.isPrizeAnnounced ? 'Đã công bố trao giải thưởng!' : 'Đã ẩn công bố giải thưởng.'
    });
  } catch (err) {
    console.error('Error in /api/admin/tournaments/:id/announce-prizes:', err);
    return res.status(500).json({ error: 'Lỗi server khi công bố giải thưởng.' });
  }
});

// ============================================================================
// PUBLIC TOURNAMENT ENDPOINTS
// ============================================================================

/**
 * GET /api/tournaments
 * Lấy danh sách giải đấu công khai đang hoạt động (dùng cho Dropdown chọn giải ở Tab Nộp bot và BXH)
 */
app.get('/api/tournaments', (req, res) => {
  try {
    const list = Array.from(dbTournaments.values())
      .filter(t => t.status !== 'DELETED')
      .map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        type: t.type || 'GLOBAL',
        status: t.status,
        stagesCount: t.stagesCount,
        currentStageIndex: t.currentStageIndex,
        currentStageName: (t.stages[t.currentStageIndex - 1] || {}).name || `Vòng ${t.currentStageIndex}`,
        stages: t.stages.map(s => ({ stageIndex: s.stageIndex, name: s.name, topNToAdvance: s.topNToAdvance, status: s.status })),
        isOpenForRegistration: t.isOpenForRegistration,
        registrationStart: t.registrationStart,
        registrationEnd: t.registrationEnd,
        isRegistrationOpenNow: isTournamentRegistrationOpen(t),
        prizes: t.prizes,
        isPrizeAnnounced: t.isPrizeAnnounced
      }));

    return res.status(200).json({
      success: true,
      tournaments: list
    });
  } catch (err) {
    console.error('Error in GET /api/tournaments:', err);
    return res.status(500).json({ error: 'Lỗi server khi lấy danh sách giải đấu.' });
  }
});

/**
 * GET /api/tournaments/:id
 * Lấy thông tin chi tiết một giải đấu (kèm các vòng thi và bảng điểm)
 */
app.get('/api/tournaments/:id', (req, res) => {
  try {
    const tour = dbTournaments.get(req.params.id);
    if (!tour) return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });

    return res.status(200).json({
      success: true,
      tournament: tour,
      isRegistrationOpenNow: isTournamentRegistrationOpen(tour)
    });
  } catch (err) {
    console.error('Error in GET /api/tournaments/:id:', err);
    return res.status(500).json({ error: 'Lỗi server khi lấy chi tiết giải đấu.' });
  }
});

// ============================================================================
// LEGACY BACKWARDS-COMPATIBLE TOURNAMENT ENDPOINTS
// ============================================================================

app.get('/api/tournament/status', (req, res) => {
  const primary = getPrimaryGlobalTournament();
  return res.status(200).json({
    success: true,
    data: {
      id: primary ? primary.id : 'tour_global_championship',
      name: primary ? primary.name : 'RPS Arena 9x9 Championship',
      isOpenForRegistration: primary ? primary.isOpenForRegistration : true,
      isRegistrationOpenNow: primary ? isTournamentRegistrationOpen(primary) : true,
      registrationStart: primary ? primary.registrationStart : null,
      registrationEnd: primary ? primary.registrationEnd : null,
      tournamentStart: primary ? primary.registrationEnd : null,
      status: primary ? primary.status : 'REGISTRATION',
      stagesCount: primary ? primary.stagesCount : 1,
      currentStageIndex: primary ? primary.currentStageIndex : 1,
      prizes: primary ? primary.prizes : [],
      isPrizeAnnounced: primary ? primary.isPrizeAnnounced : true,
      tournamentProgress: primary ? primary.progress : { isRunning: false }
    }
  });
});

app.post('/api/admin/tournament/run-all', requireAdmin, async (req, res) => {
  try {
    const primary = getPrimaryGlobalTournament();
    if (!primary) return res.status(400).json({ error: 'Chưa có giải đấu toàn cầu nào.' });
    const progress = await runTournamentStage(primary.id, primary.currentStageIndex);
    return res.status(200).json({
      success: true,
      message: `Đã kích hoạt giải đấu "${primary.name}"!`,
      progress
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Lỗi khi khởi chạy giải đấu.' });
  }
});

app.post('/api/admin/tournament/schedule', requireAdmin, (req, res) => {
  const primary = getPrimaryGlobalTournament();
  if (primary) {
    const { registrationStart, registrationEnd, isOpenForRegistration, status } = req.body;
    if (registrationStart) primary.registrationStart = registrationStart;
    if (registrationEnd) primary.registrationEnd = registrationEnd;
    if (typeof isOpenForRegistration === 'boolean') primary.isOpenForRegistration = isOpenForRegistration;
    if (status) primary.status = status;
    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: primary });
  }
  return res.status(200).json({ success: true, message: 'Đã lưu cấu hình lịch trình!' });
});

app.post('/api/admin/tournament/toggle-registration', requireAdmin, (req, res) => {
  const primary = getPrimaryGlobalTournament();
  if (primary) {
    primary.isOpenForRegistration = !primary.isOpenForRegistration;
    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: primary });
    return res.status(200).json({
      success: true,
      isOpenForRegistration: primary.isOpenForRegistration,
      message: `Cổng nộp bot hiện ${primary.isOpenForRegistration ? 'ĐÃ MỞ' : 'ĐÃ KHÓA'}.`
    });
  }
  return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });
});

app.post('/api/admin/tournament/prizes', requireAdmin, (req, res) => {
  const primary = getPrimaryGlobalTournament();
  if (primary) {
    primary.prizes = req.body.prizes || [];
    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: primary });
  }
  return res.status(200).json({ success: true, message: 'Đã lưu giải thưởng!' });
});

app.post('/api/admin/tournament/announce-prizes', requireAdmin, (req, res) => {
  const primary = getPrimaryGlobalTournament();
  if (primary) {
    primary.isPrizeAnnounced = !primary.isPrizeAnnounced;
    saveTournaments();
    broadcastSSE('tournament_updated', { tournament: primary });
    return res.status(200).json({ success: true, isPrizeAnnounced: primary.isPrizeAnnounced });
  }
  return res.status(404).json({ error: 'Không tìm thấy giải đấu.' });
});

app.get('/api/admin/auto-queue', (req, res) => {
  return res.status(200).json({
    success: true,
    isAutoQueueEnabled,
    queueLength: matchQueue.length,
    isWorkerRunning
  });
});

app.post('/api/admin/auto-queue', requireAdmin, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled === 'boolean') {
    isAutoQueueEnabled = enabled;
  } else {
    isAutoQueueEnabled = !isAutoQueueEnabled;
  }
  broadcastSSE('auto_queue_updated', {
    isAutoQueueEnabled,
    queueLength: matchQueue.length,
    isWorkerRunning
  });
  return res.status(200).json({
    success: true,
    isAutoQueueEnabled,
    message: `Hàng chờ đấu tự động hiện: ${isAutoQueueEnabled ? 'BẬT (ON)' : 'TẮT (OFF)'}`
  });
});

app.post('/api/admin/auto-queue/trigger', requireAdmin, (req, res) => {
  const { roomId, tournamentId } = req.body || {};
  const added = enqueueAllUnplayedMatches(roomId || 'PUBLIC', tournamentId || null);
  return res.status(200).json({
    success: true,
    matchesAdded: added,
    queueLength: matchQueue.length,
    message: `Đã đưa ${added} trận đấu chưa đấu vào hàng chờ thi đấu!`
  });
});

// ============================================================================
// 4. API BOT & MATCH ENDPOINTS (HTTP REST)
// ============================================================================

/**
 * 1. POST /api/bot/submit
 * Lưu/cập nhật bot, ghi nhận vào giải đấu và đưa vào hàng đợi xoay vòng `submissionQueue`
 */
app.post('/api/bot/submit', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user.userId || req.user.id;
    const currentUsername = req.user.username;

    if (!currentUserId || !currentUsername) {
      return res.status(401).json({ success: false, error: 'Vui lòng đăng nhập để nộp bot!', message: 'Vui lòng đăng nhập để nộp bot!' });
    }

    const { botName, name, language, botCode, isAnonymous, roomId, tournamentId } = req.body;

    if (!botCode || typeof botCode !== 'string' || botCode.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'botCode is required and cannot be empty.' });
    }

    // Xác định giải đấu mục tiêu (nếu không truyền tournamentId thì lấy primary global tournament hoặc theo roomId)
    let targetTour = null;
    if (tournamentId) {
      targetTour = dbTournaments.get(tournamentId);
    }
    if (!targetTour && roomId && roomId !== 'PUBLIC') {
      targetTour = dbTournaments.get(roomId);
    }
    if (!targetTour) {
      targetTour = getPrimaryGlobalTournament();
    }

    // Kiểm tra thời hạn đăng ký giải đấu (Admin được quyền nộp mọi lúc để test)
    const isAdmin = req.user.role === 'admin';
    if (targetTour && !isTournamentRegistrationOpen(targetTour) && !isAdmin) {
      return res.status(403).json({
        success: false,
        error: `Cổng nộp bot cho giải đấu "${targetTour.name}" hiện đang đóng hoặc đã hết hạn đăng ký!`,
        details: {
          tournamentName: targetTour.name,
          isOpenForRegistration: targetTour.isOpenForRegistration,
          registrationStart: targetTour.registrationStart,
          registrationEnd: targetTour.registrationEnd
        }
      });
    }

    const targetTournamentId = targetTour ? targetTour.id : 'tour_global_championship';
    const targetRoomId = (roomId || (targetTour ? targetTour.id : 'PUBLIC')).trim().toUpperCase();
    const assignedBotName = (botName || name || 'CyberWarrior').trim();
    const assignedLanguage = (language || 'javascript').toLowerCase();

    // Chuẩn hóa tên tác giả theo Chế độ Ẩn danh (Anonymous Mode)
    const isAnon = (isAnonymous === true || isAnonymous === 'true');
    const assignedAuthor = isAnon ? 'Ẩn danh' : currentUsername;

    // 1. Kiểm tra bot đã tồn tại của user trong phòng / giải đấu này chưa (DUY NHẤT theo user_id)
    let existingBot = await db.getPlayerByUserIdAndTournament({
      userId: currentUserId,
      tournamentId: targetTournamentId,
      roomId: targetRoomId
    });

    const isUpdate = !!existingBot;
    let assignedId;

    if (isUpdate) {
      assignedId = existingBot.id || existingBot.botId;
      console.log(`🔄 [Submit] Phát hiện bot đã tồn tại của user "${currentUsername}" (ID: ${assignedId}). Thực hiện CẬP NHẬT (Update in-place).`);

      // Hủy các trận đang nằm chờ trong queue liên quan đến bot này nếu có
      for (let i = matchQueue.length - 1; i >= 0; i--) {
        if (matchQueue[i].redId === assignedId || matchQueue[i].blueId === assignedId) {
          matchQueue.splice(i, 1);
        }
      }

      // Xóa lịch sử đối đầu cũ của bot này để thi đấu lại vòng tròn từ đầu với thuật toán mới
      await db.resetPlayerMatchHistory(assignedId, targetTournamentId, targetRoomId);
    } else {
      assignedId = `player_${currentUserId}`;
      console.log(`🆕 [Submit] Đăng ký bot mới cho user "${currentUsername}" (ID: ${assignedId}). Thực hiện TẠO MỚI (Insert).`);
    }

    // Chuẩn hóa và lưu record vào Database (Bảo toàn userId)
    const record = normalizePlayerRecord({
      id: assignedId,
      botId: assignedId,
      playerId: assignedId,
      userId: currentUserId,
      name: assignedBotName,
      botName: assignedBotName,
      playerName: assignedBotName,
      author: assignedAuthor,
      language: assignedLanguage,
      botCode: botCode.trim(),
      score: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      errors: 0,
      matchesPlayed: 0,
      lastMatchId: null,
      roomId: targetRoomId,
      tournamentId: targetTournamentId,
      updatedAt: Date.now()
    });

    if (isUpdate) {
      await db.updatePlayer(assignedId, record);
    } else {
      await db.createPlayer(record);
    }

    dbPlayers.set(assignedId, record);

    // Nếu là cập nhật, tính toán lại chỉ số của các đối thủ khác sau khi đã xóa các ván đấu cũ với bot này
    if (isUpdate) {
      await recalculateStats(targetRoomId, targetTournamentId);
    }

    // Ghi danh vào Vòng 1 của giải đấu nếu chưa có hoặc cập nhật tên/tác giả trong bảng xếp hạng giải đấu
    if (targetTour && targetTour.stages && targetTour.stages[0]) {
      const stage1 = targetTour.stages[0];
      if (!Array.isArray(stage1.participatingBots)) stage1.participatingBots = [];
      if (!Array.isArray(stage1.standings)) stage1.standings = [];

      const existingStanding = stage1.standings.find(s => s.botId === assignedId);
      if (existingStanding) {
        existingStanding.name = assignedBotName;
        existingStanding.author = assignedAuthor;
        if (isUpdate) {
          existingStanding.score = 0;
          existingStanding.wins = 0;
          existingStanding.draws = 0;
          existingStanding.losses = 0;
          existingStanding.errors = 0;
          existingStanding.matchesPlayed = 0;
          existingStanding.lastMatchId = null;
        }
      } else {
        if (!stage1.participatingBots.includes(assignedId)) {
          stage1.participatingBots.push(assignedId);
        }
        stage1.standings.push({
          botId: assignedId,
          name: assignedBotName,
          author: assignedAuthor,
          score: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          errors: 0,
          matchesPlayed: 0,
          lastMatchId: null
        });
      }

      await db.saveTournament(targetTour);
      broadcastSSE('tournament_updated', { tournament: targetTour });
    }

    // Đưa vào hàng đợi thi đấu tự động nếu tính năng Auto-Queue đang bật
    let matchesQueued = 0;
    if (isAutoQueueEnabled) {
      matchesQueued = await enqueueBotUnplayedMatches(assignedId, targetRoomId, targetTournamentId);
    } else {
      console.log(`ℹ️ [Submit] Auto-Queue đang TẮT. Bot "${assignedBotName}" được lưu mà không đưa vào hàng chờ.`);
    }

    const queuePos = matchQueue.length;
    const baseMessage = isUpdate ? 'Cập nhật code bot thành công!' : 'Nộp bot thành công!';
    const userMessage = isAutoQueueEnabled
      ? (matchesQueued > 0 ? `${baseMessage} Đã đưa ${matchesQueued} trận vào hàng chờ thi đấu!` : `${baseMessage} (Đã hoàn tất mọi trận đấu)!`)
      : `${baseMessage} (Hàng chờ tự động đang tắt)!`;

    broadcastSSE('leaderboard_updated', {
      roomId: targetRoomId,
      tournamentId: targetTournamentId,
      leaderboard: getSortedLeaderboard(targetRoomId)
    });

    return res.status(200).json({
      success: true,
      isUpdate,
      message: userMessage,
      queuePosition: queuePos,
      matchesQueued,
      isAutoQueueEnabled,
      data: {
        id: assignedId,
        botId: assignedId,
        userId: currentUserId,
        name: assignedBotName,
        botName: assignedBotName,
        author: assignedAuthor,
        isAnonymous: isAnon,
        language: assignedLanguage,
        roomId: targetRoomId,
        tournamentId: targetTournamentId,
        tournamentName: targetTour ? targetTour.name : null,
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
 * 2. GET /api/leaderboard?roomId=...&tournamentId=...&stageIndex=...
 * Trả về bảng xếp hạng theo giải đấu và vòng đấu cụ thể, hoặc theo phòng (SSOT trực tiếp từ Database)
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { tournamentId, stageIndex } = req.query;
    const roomId = (req.query.roomId || 'PUBLIC').trim().toUpperCase();

    // 1. Luôn truy vấn danh sách người chơi trực tiếp từ Supabase
    const livePlayers = await db.getPlayers(tournamentId ? { tournamentId } : (roomId !== 'PUBLIC' ? { roomId } : {}));
    const livePlayerMap = new Map(livePlayers.map(p => [p.botId || p.id, p]));

    // Nếu bảng players trong Database rỗng -> Bảng xếp hạng LUÔN LUÔN rỗng [] (Không phantom bot)
    if (livePlayers.length === 0) {
      const primary = getPrimaryGlobalTournament();
      return res.status(200).json({
        success: true,
        roomId,
        tournamentId: tournamentId || (primary ? primary.id : null),
        tournamentName: primary ? primary.name : 'RPS Arena 9x9 Championship',
        stagesCount: primary ? primary.stagesCount : 3,
        currentStageIndex: primary ? primary.currentStageIndex : 1,
        selectedStageIndex: stageIndex ? Number(stageIndex) : (primary ? primary.currentStageIndex : 1),
        selectedStageName: 'Vòng 1: Vòng Bảng (Qualifier)',
        isPrizeAnnounced: primary ? primary.isPrizeAnnounced : true,
        prizes: primary ? primary.prizes : [],
        isBatchRunning: isWorkerRunning,
        queueLength: matchQueue.length,
        leaderboard: [],
        recentMatches: []
      });
    }

    // 2. Trường hợp truy vấn theo Tournament & Stage
    if (tournamentId) {
      const tour = await db.getTournamentById(tournamentId);
      if (tour) {
        const stageNum = stageIndex ? Number(stageIndex) : tour.currentStageIndex;
        const stage = (tour.stages || []).find(s => s.stageIndex === stageNum) || (tour.stages || [])[0];

        let leaderboard = [];
        if (stage && Array.isArray(stage.standings) && stage.standings.length > 0) {
          // Lọc CHẶT CHẼ: Chỉ lấy các bot thực sự còn tồn tại trong livePlayers
          leaderboard = stage.standings
            .filter(st => livePlayerMap.has(st.botId))
            .sort((a, b) => b.score - a.score || b.wins - a.wins || a.errors - b.errors);
        } else if (stage && Array.isArray(stage.participatingBots)) {
          leaderboard = stage.participatingBots
            .filter(bId => livePlayerMap.has(bId))
            .map(bId => livePlayerMap.get(bId));
        }

        // Nếu sau khi lọc mà rỗng (toàn bộ bot cũ trong stage đã bị xóa), dùng chính livePlayers
        if (leaderboard.length === 0) {
          leaderboard = [...livePlayers].sort((a, b) => b.score - a.score || b.wins - a.wins || a.errors - b.errors);
        }

        // Trận gần đây của giải đấu và vòng này từ database
        const recentMatches = await db.getRecentMatches({ tournamentId: tour.id, stageIndex: stageNum }, 20);

        return res.status(200).json({
          success: true,
          tournamentId: tour.id,
          tournamentName: tour.name,
          stagesCount: tour.stagesCount,
          currentStageIndex: tour.currentStageIndex,
          selectedStageIndex: stageNum,
          selectedStageName: stage ? stage.name : `Vòng ${stageNum}`,
          isPrizeAnnounced: tour.isPrizeAnnounced,
          prizes: tour.prizes,
          isBatchRunning: isWorkerRunning || (tour.progress && tour.progress.isRunning),
          queueLength: matchQueue.length,
          leaderboard,
          recentMatches
        });
      }
    }

    // 3. Mặc định truy vấn theo RoomId (PUBLIC hoặc phòng riêng) trực tiếp từ database
    const leaderboard = await db.getLeaderboard(roomId);
    const primary = getPrimaryGlobalTournament();
    const recentMatches = await db.getRecentMatches({ roomId }, 20);

    return res.status(200).json({
      success: true,
      roomId,
      tournamentId: primary ? primary.id : null,
      tournamentName: primary ? primary.name : null,
      isPrizeAnnounced: primary ? primary.isPrizeAnnounced : true,
      prizes: primary ? primary.prizes : [],
      isBatchRunning: isWorkerRunning,
      queueLength: matchQueue.length,
      leaderboard,
      recentMatches
    });
  } catch (error) {
    console.error('Error in /api/leaderboard:', error);
    return res.status(500).json({ error: 'Internal server error while fetching leaderboard.' });
  }
});

/**
 * GET /api/players?roomId=...&tournamentId=...
 * Lấy danh sách toàn bộ người chơi / bot trực tiếp từ Database
 */
app.get('/api/players', async (req, res) => {
  try {
    const { roomId, tournamentId } = req.query;
    const filter = {};
    if (roomId) filter.roomId = roomId;
    if (tournamentId) filter.tournamentId = tournamentId;
    const players = await db.getPlayers(filter);
    return res.status(200).json({ success: true, players });
  } catch (error) {
    console.error('Error in /api/players:', error);
    return res.status(500).json({ error: 'Internal server error while fetching players.' });
  }
});

/**
 * GET /api/matches/recent?roomId=...&tournamentId=...&stageIndex=...&limit=...
 * Lấy danh sách các trận đấu gần đây trực tiếp từ Database
 */
app.get('/api/matches/recent', async (req, res) => {
  try {
    const { roomId, tournamentId, stageIndex, limit } = req.query;
    const matches = await db.getRecentMatches({
      roomId,
      tournamentId,
      stageIndex
    }, limit ? Number(limit) : 20);
    return res.status(200).json({ success: true, matches });
  } catch (error) {
    console.error('Error in /api/matches/recent:', error);
    return res.status(500).json({ error: 'Internal server error while fetching recent matches.' });
  }
});

/**
 * 3. GET /api/matches/:matchId
 * Lấy log chi tiết trận đấu để phát Replay
 */
app.get('/api/matches/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = await db.getMatchById(matchId);

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
 * 4. ALL /api/room/create
 * Tạo mã phòng riêng và tự động đăng ký vào danh sách Private Tournaments
 */
app.all('/api/room/create', async (req, res) => {
  try {
    const authUser = extractUserFromReq(req);
    const newRoomId = `ROOM_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).substring(2, 5).toUpperCase()}`;

    const roomTour = {
      id: newRoomId,
      name: `Phòng Riêng (${newRoomId})`,
      description: `Phòng thi đấu riêng do người dùng ${authUser ? authUser.username : 'khách'} tạo.`,
      type: 'PRIVATE',
      createdBy: authUser ? authUser.username : 'User',
      createdAt: Date.now(),
      isOpenForRegistration: true,
      registrationStart: new Date().toISOString(),
      registrationEnd: new Date(Date.now() + 3600 * 1000 * 24 * 30).toISOString(),
      status: 'REGISTRATION',
      stagesCount: 1,
      currentStageIndex: 1,
      stages: [
        {
          stageIndex: 1,
          name: 'Vòng Đấu Tự Do',
          topNToAdvance: 1,
          status: 'REGISTRATION',
          participatingBots: [],
          standings: [],
          matches: []
        }
      ],
      prizes: [],
      isPrizeAnnounced: false,
      progress: {
        isRunning: false,
        totalMatches: 0,
        completedMatches: 0,
        currentBatch: 0,
        totalBatches: 0,
        percentage: 0,
        statusText: 'Sẵn sàng'
      }
    };

    await db.saveTournament(roomTour);
    broadcastSSE('tournament_updated', { tournament: roomTour });

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
  console.log(`💾 Database Mode: ${db.mode} (${db.mode === 'SUPABASE' ? 'Supabase PostgreSQL Cloud' : 'In-Memory RAM Safe Mode'})`);
  console.log(`👥 Loaded Bots: ${dbPlayers.size}`);
  console.log(`⚔️  Loaded Matches: ${dbMatches.size}`);
  console.log(`⚙️  Batch Quota: Max ${BATCH_SIZE} matches / turn (Rest: ${WORKER_REST_MS}ms)`);
  console.log(`🛡️  Disk Writes: 0 file writes (Clean local storage)`);
  console.log(`====================================================================`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`💥 [Server] Cổng ${PORT} hiện đang bận! Vui lòng kiểm tra lại tiến trình đang dùng cổng này.`);
  } else {
    console.error(`💥 [Server Error]:`, err);
  }
});

export { 
  app, 
  server, 
  db,
  dbPlayers, 
  dbMatches, 
  dbTournaments,
  dbUsers,
  matchQueue,
  submissionQueue, 
  isAutoQueueEnabled,
  processMatchQueue,
  processQueue, 
  enqueueBotUnplayedMatches,
  enqueueAllUnplayedMatches,
  enqueueBotForRoundRobin, 
  getSortedLeaderboard,
  hasMatchBeenPlayed,
  getMatchPairKey
};
