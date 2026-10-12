/**
 * server.js
 * 
 * BACKEND NODE.JS EXPRESS CHO ĐẤU TRƯỜNG BOT OẰN TÙ TÌ 9X9
 * 
 * TÍNH NĂNG NÂNG CẤP CAO CẤP:
 * 1. LƯU TRỮ DỮ LIỆU BỀN VỮNG (PERSISTENCE):
 *    - Lưu tự động vào 'data/players.json' và 'data/matches.json'
 *    - Khi khởi động lại server, toàn bộ 50+ người chơi, bot code, Leaderboard, và Match Logs
 *      được load nguyên vẹn từ ổ đĩa mà không bị mất.
 * 
 * 2. THUẬT TOÁN LEO THÁP THEO CỤM (TIERED BATCH MATCHMAKING - 10 NGƯỜI/LẦN):
 *    - Khi nộp/cập nhật code:
 *      + Xác định vị trí hiện tại của bot trên Leaderboard.
 *      + Nếu là người mới: Ghép vào Cụm 10 người ở đáy bảng (Lowest Tier).
 *      + Tổ chức 1 mini-tournament giữa bot đó và 9 bot trong cụm (đủ 10 bot).
 *      + ĐIỀU KIỆN LEO HẠNG: Nếu bot đạt tỉ lệ thắng áp đảo (thắng >= 6/10 trận hoặc lọt top 3 của cụm):
 *        * Tăng điểm thưởng ELO/Score.
 *        * TỰ ĐỘNG đưa bot vào Job Queue để đấu tiếp với CỤM 10 NGƯỜI TIẾP THEO ở thứ hạng cao hơn.
 *        * Quá trình leo tháp lặp lại liên tục cho đến khi bot gặp nhóm cân tài cân sức hoặc đạt TOP 1!
 * 
 * 3. QUẢN LÝ TẢI & TRÁNH NGHẼN SERVER (SEQUENTIAL ASYNC JOB QUEUE):
 *    - Toàn bộ các batch leo tháp xếp vào Job Queue và chạy tuần tự với async/await.
 *    - Không làm đơ CPU hay nghẽn Event Loop.
 *    - Broadcast Server-Sent Events (SSE) tại `/api/stream` cho client nhận thông báo realtime!
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { 
  GUARDIAN_AND_STRIKER_BOT_CODE, 
  HUNTER_BOT_CODE, 
  RUSHER_BOT_CODE,
  RANDOM_BOT_CODE 
} from './botRunner.js';
import { runTournament, playMatch, SCORING } from './tournamentEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TIER_CLUSTER_SIZE = 10; // Cụm 10 bot thi đấu mỗi lượt

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ============================================================================
// 1. LƯU TRỮ DỮ LIỆU BỀN VỮNG (PERSISTENCE)
// ============================================================================
const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');

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
let dbPlayers = new Map(); // playerId -> Player Record
let dbMatches = new Map(); // matchId -> Match Log

/**
 * Tải dữ liệu từ ổ đĩa khi khởi động server
 */
function loadPersistedData() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      const raw = fs.readFileSync(PLAYERS_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const p of list) {
          dbPlayers.set(p.playerId, p);
        }
        console.log(`[Persistence] Đã tải ${dbPlayers.size} người chơi từ ${PLAYERS_FILE}`);
      }
    }
  } catch (err) {
    console.error('[Persistence] Lỗi khi đọc players.json:', err.message);
  }

  // Nạp bot hệ thống nếu chưa có
  for (const b of DEFAULT_SYSTEM_BOTS) {
    if (!dbPlayers.has(b.id)) {
      dbPlayers.set(b.id, {
        playerId: b.id,
        playerName: b.name,
        author: b.author,
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
}

/**
 * Lưu dữ liệu bền vững ra file
 */
function savePersistedData() {
  try {
    const playersList = Array.from(dbPlayers.values());
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(playersList, null, 2), 'utf-8');

    // Lưu tối đa 300 trận đấu gần nhất vào file
    const matchesList = Array.from(dbMatches.values()).slice(-300);
    fs.writeFileSync(MATCHES_FILE, JSON.stringify(matchesList, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Persistence] Lỗi khi lưu dữ liệu:', err.message);
  }
}

// Khởi chạy nạp dữ liệu ngay khi khởi động
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

// ============================================================================
// 2. THUẬT TOÁN LEO THÁP THEO CỤM (TIERED CLUSTER MATCHMAKING)
// ============================================================================

/**
 * Lấy Bảng xếp hạng sắp xếp theo điểm số
 */
function getSortedLeaderboard(roomId = 'PUBLIC') {
  const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();
  const list = Array.from(dbPlayers.values()).filter(p => {
    if (normRoom === 'PUBLIC') return true;
    return p.roomId === normRoom;
  });

  return list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.errors !== b.errors) return a.errors - b.errors;
    return a.losses - b.losses;
  });
}

/**
 * Job Queue: Quản lý hàng đợi leo tháp tuần tự, tránh nghẽn CPU
 */
class LadderQueueManager {
  constructor() {
    this.jobQueue = [];
    this.isProcessing = false;
  }

  enqueue(playerId, roomId) {
    this.jobQueue.push({ playerId, roomId, step: 0 });
    console.log(`[Ladder] Enqueued bot ${playerId} vào hàng đợi leo tháp. Tổng hàng đợi: ${this.jobQueue.length}`);
    this.processNext();
  }

  async processNext() {
    if (this.isProcessing || this.jobQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const currentJob = this.jobQueue.shift();

    try {
      await this.runTowerClimbStep(currentJob);
    } catch (err) {
      console.error(`[Ladder] Lỗi khi xử lý leo tháp cho bot ${currentJob.playerId}:`, err);
    } finally {
      this.isProcessing = false;
      // Thông báo cập nhật realtime
      broadcastSSE('leaderboard_updated', {
        roomId: currentJob.roomId,
        leaderboard: getSortedLeaderboard(currentJob.roomId)
      });
      // Tiếp tục job tiếp theo
      if (this.jobQueue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  /**
   * Thực hiện 1 bước leo tháp (Leo qua 1 Cụm 10 người)
   */
  async runTowerClimbStep(job) {
    const { playerId, roomId } = job;
    const challenger = dbPlayers.get(playerId);
    if (!challenger) return;

    const leaderboard = getSortedLeaderboard(roomId);
    const totalPlayers = leaderboard.length;
    const challengerIndex = leaderboard.findIndex(p => p.playerId === playerId);

    // Xác định vị trí cụm 10 người để thử thách
    // Nếu là người mới hoặc đứng cuối bảng: Bắt đầu từ đáy bảng
    let clusterStartIndex;
    let clusterEndIndex;

    if (challengerIndex === -1 || challengerIndex >= totalPlayers - TIER_CLUSTER_SIZE) {
      // Ở cụm đáy bảng (Hạng thấp nhất)
      clusterStartIndex = Math.max(0, totalPlayers - TIER_CLUSTER_SIZE);
      clusterEndIndex = totalPlayers;
    } else {
      // Đang ở giữa tháp -> Thử thách cụm 10 người xếp ngay TRÊN vị trí hiện tại
      clusterEndIndex = challengerIndex;
      clusterStartIndex = Math.max(0, challengerIndex - TIER_CLUSTER_SIZE);
    }

    // Chọn tối đa 9 đối thủ trong cụm này (không bao gồm chính challenger)
    let clusterOpponents = leaderboard
      .slice(clusterStartIndex, clusterEndIndex)
      .filter(p => p.playerId !== playerId);

    // Nếu không đủ đối thủ trong phòng, bổ sung bot mẫu để đủ cụm thi đấu
    if (clusterOpponents.length === 0) {
      clusterOpponents = DEFAULT_SYSTEM_BOTS.filter(b => b.id !== playerId).slice(0, 4);
    }

    console.log(`[Ladder] Bot "${challenger.playerName}" (Hạng ${challengerIndex + 1}/${totalPlayers}) bắt đầu thử thách Cụm ${clusterOpponents.length} đối thủ (Hạng ${clusterStartIndex + 1} -> ${clusterEndIndex})...`);

    // Tạo danh sách 10 bot thi đấu
    const batchBots = [
      { id: challenger.playerId, name: challenger.playerName, author: challenger.author, code: challenger.botCode },
      ...clusterOpponents.map(o => ({ id: o.playerId, name: o.playerName, author: o.author, code: o.botCode }))
    ];

    // Chạy mini-tournament bất đồng bộ (Non-blocking)
    const tournamentResult = await new Promise(resolve => {
      setImmediate(() => {
        const res = runTournament(batchBots, { timeoutMs: 150 });
        resolve(res);
      });
    });

    // Lưu các trận đấu vào dbMatches
    for (const match of tournamentResult.matches) {
      dbMatches.set(match.id, {
        ...match,
        roomId: challenger.roomId,
        timestamp: Date.now()
      });
    }

    // Lấy thành tích của Challenger trong batch này
    const challengerStatsInBatch = tournamentResult.leaderboard.find(b => b.botId === challenger.playerId);
    const challengerRankInBatch = tournamentResult.leaderboard.findIndex(b => b.botId === challenger.playerId) + 1;

    let winsInBatch = challengerStatsInBatch ? challengerStatsInBatch.wins : 0;
    let matchesInBatch = challengerStatsInBatch ? challengerStatsInBatch.matchesPlayed : 0;
    let winRate = matchesInBatch > 0 ? (winsInBatch / matchesInBatch) : 0;

    console.log(`[Ladder] Kết quả Cụm: "${challenger.playerName}" Thắng ${winsInBatch}/${matchesInBatch} trận (Tỉ lệ ${(winRate * 100).toFixed(1)}%), Đứng thứ ${challengerRankInBatch}/${batchBots.length} trong cụm.`);

    // Cập nhật tích lũy điểm số cho tất cả bot trong batch
    for (const stat of tournamentResult.leaderboard) {
      const p = dbPlayers.get(stat.botId);
      if (p) {
        p.score += stat.score;
        p.wins += stat.wins;
        p.draws += stat.draws;
        p.losses += stat.losses;
        p.errors += stat.errors;
        p.matchesPlayed += stat.matchesPlayed;
        p.updatedAt = Date.now();
      }
    }

    // Lưu dữ liệu bền vững
    savePersistedData();

    // ========================================================================
    // ĐIỀU KIỆN LEO HẠNG:
    // Thắng >= 50% số trận (hoặc lọt Top 3 của cụm) VÀ chưa phải Top 1 toàn server
    // -> TỰ ĐỘNG ĐƯA VÀO HÀNG ĐỢI ĐỂ ĐẤU TIẾP CỤM CAO HƠN!
    // ========================================================================
    const isDominant = (winRate >= 0.5) || (challengerRankInBatch <= 3);
    const canClimbHigher = clusterStartIndex > 0;

    if (isDominant && canClimbHigher) {
      console.log(`🔥 [Ladder Level Up!] Bot "${challenger.playerName}" ÁP ĐẢO CỤM! Tự động leo tiếp lên Cụm cao hơn...`);
      // Đưa bot vào hàng đợi leo tiếp nấc thang tiếp theo
      this.jobQueue.push({
        playerId: challenger.playerId,
        roomId: challenger.roomId,
        step: job.step + 1
      });
    } else {
      if (!canClimbHigher) {
        console.log(`👑 [Ladder Champion!] Bot "${challenger.playerName}" đã chinh phục đỉnh tháp (Top cụm dẫn đầu)!`);
      } else {
        console.log(`🛑 [Ladder Balanced] Bot "${challenger.playerName}" đã dừng lại ở cụm cân bằng.`);
      }
    }
  }
}

const ladderManager = new LadderQueueManager();

// ============================================================================
// 3. API ENDPOINTS (HTTP REST)
// ============================================================================

/**
 * 1. POST /api/bot/submit
 * Nộp hoặc cập nhật code bot -> Đưa vào hàng đợi Leo Tháp
 */
app.post('/api/bot/submit', (req, res) => {
  try {
    const { playerId, playerName, author, botCode, roomId } = req.body;

    if (!botCode || typeof botCode !== 'string' || botCode.trim().length === 0) {
      return res.status(400).json({ error: 'botCode is required and cannot be empty.' });
    }

    const assignedPlayerId = playerId || `player_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const assignedPlayerName = playerName || 'Mysterious Bot';
    const assignedAuthor = author || 'Anonymous';
    const targetRoomId = (roomId || 'PUBLIC').trim().toUpperCase();

    // Lấy record cũ hoặc tạo mới (Giữ nguyên điểm số cũ nếu chỉ cập nhật code bot)
    let playerRecord = dbPlayers.get(assignedPlayerId);
    if (!playerRecord) {
      playerRecord = {
        playerId: assignedPlayerId,
        playerName: assignedPlayerName,
        author: assignedAuthor,
        botCode: botCode.trim(),
        score: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        errors: 0,
        matchesPlayed: 0,
        roomId: targetRoomId,
        updatedAt: Date.now()
      };
    } else {
      playerRecord.playerName = assignedPlayerName;
      playerRecord.author = assignedAuthor;
      playerRecord.botCode = botCode.trim();
      playerRecord.roomId = targetRoomId;
      playerRecord.updatedAt = Date.now();
    }

    dbPlayers.set(assignedPlayerId, playerRecord);
    savePersistedData();

    // Đưa bot vào hàng đợi leo tháp theo cụm
    ladderManager.enqueue(assignedPlayerId, targetRoomId);

    return res.status(200).json({
      success: true,
      message: 'Bot đã nộp thành công và bắt đầu hành trình Leo Tháp theo cụm!',
      data: {
        playerId: assignedPlayerId,
        playerName: assignedPlayerName,
        roomId: targetRoomId,
        currentScore: playerRecord.score,
        queuePosition: ladderManager.jobQueue.length
      }
    });
  } catch (error) {
    console.error('Error in /api/bot/submit:', error);
    return res.status(500).json({ error: 'Internal server error while submitting bot.' });
  }
});

/**
 * 2. GET /api/leaderboard?roomId=...
 * Lấy Bảng xếp hạng bền vững mới nhất
 */
app.get('/api/leaderboard', (req, res) => {
  try {
    const roomId = (req.query.roomId || 'PUBLIC').trim().toUpperCase();
    const leaderboard = getSortedLeaderboard(roomId);

    // 20 trận gần đây nhất
    const recentMatches = Array.from(dbMatches.values())
      .filter(m => m.roomId === roomId)
      .slice(-20)
      .reverse()
      .map(m => ({
        id: m.id,
        botRed: m.botRed,
        botBlue: m.botBlue,
        winner: m.winner,
        winnerBotId: m.winnerBotId,
        totalTurns: m.totalTurns,
        timestamp: m.timestamp
      }));

    return res.status(200).json({
      success: true,
      roomId,
      isBatchRunning: ladderManager.isProcessing,
      queueLength: ladderManager.jobQueue.length,
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
 * Lấy log chi tiết trận đấu từ database bền vững để xem Replay
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
  console.log(`🏰 RPS ARENA 9X9 - TIERED LADDER CLIMBING & PERSISTENCE SERVER`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`💾 Data Path: ${DATA_DIR}`);
  console.log(`👥 Loaded Players: ${dbPlayers.size}`);
  console.log(`⚔️  Loaded Matches: ${dbMatches.size}`);
  console.log(`🪜 Tier Cluster Size: ${TIER_CLUSTER_SIZE} bots / batch`);
  console.log(`====================================================================`);
});

export { app, server, dbPlayers, dbMatches, ladderManager, getSortedLeaderboard };
