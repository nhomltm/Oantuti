/**
 * server.js
 * 
 * BACKEND NODE.JS EXPRESS CHO ĐẤU TRƯỜNG BOT OẰN TÙ TÌ 9X9 ĐA NGƯỜI CHƠI
 * 
 * Kiến trúc & Tính năng:
 * 1. Quản lý Phòng:
 *    - Public Arena: Đấu trường chung toàn cầu.
 *    - Private Room (roomId): Phòng đấu kín do người chơi tạo.
 * 
 * 2. Hàng đợi & Giới hạn Batch (Queue & Batch Runner):
 *    - Khi nộp/cập nhật code bot: lưu vào database bộ nhớ và đẩy bot vào matchmakingQueue.
 *    - Giới hạn Batch: Mỗi lượt chạy giải đấu lấy TỐI ĐA 10 bot.
 *      + Nếu hàng đợi ít hơn 2 bot: Tự động bổ sung các Bot Mẫu tiêu chuẩn (Guardian, Hunter, Random) để đủ tối thiểu.
 *    - Xử lý bất đồng bộ (Non-blocking): Chạy trên background task (async/setImmediate),
 *      không làm nghẽn Event Loop hay các HTTP request của người khác.
 *    - Tự động tiếp tục xử lý các batch tiếp theo trong hàng đợi.
 * 
 * 3. Tích hợp Engine & Lưu trữ:
 *    - Kết nối trực tiếp tournamentEngine.js, botRunner.js, boardEngine.js.
 *    - Lưu Leaderboard theo từng phòng/arena.
 *    - Lưu Match Logs phục vụ người xem Replay qua ID.
 * 
 * 4. API Endpoints:
 *    - POST /api/bot/submit
 *    - GET /api/leaderboard?roomId=...
 *    - GET /api/matches/:matchId
 *    - GET /api/room/create
 *    - GET /api/rooms
 *    - Static file serving (index.html, style.css, ui.js, boardEngine.js, botRunner.js, tournamentEngine.js)
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { 
  GUARDIAN_AND_STRIKER_BOT_CODE, 
  HUNTER_BOT_CODE, 
  RANDOM_BOT_CODE 
} from './botRunner.js';
import { runTournament, SCORING } from './tournamentEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const BATCH_SIZE_LIMIT = 10; // Giới hạn tối đa 10 bot mỗi batch giải đấu

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Phục vụ giao diện web tĩnh
app.use(express.static(__dirname));

// ============================================================================
// BỘ NHỚ LƯU TRỮ TRONG RAM (IN-MEMORY STORAGE)
// ============================================================================
const DEFAULT_SAMPLE_BOTS = [
  { id: 'bot_system_guardian', name: 'Master Guardian AI', author: 'System AI', code: GUARDIAN_AND_STRIKER_BOT_CODE },
  { id: 'bot_system_hunter', name: 'Vicious Hunter AI', author: 'System AI', code: HUNTER_BOT_CODE },
  { id: 'bot_system_random', name: 'Lucky Rookie AI', author: 'System AI', code: RANDOM_BOT_CODE }
];

// Cấu trúc dữ liệu cho mỗi Room:
// {
//   roomId: 'PUBLIC' | string,
//   name: string,
//   isPrivate: boolean,
//   bots: Map<playerId, BotInfo>,
//   queue: Set<playerId>,
//   leaderboard: Array<Stats>,
//   isBatchRunning: boolean,
//   createdAt: number
// }
const rooms = new Map();

// Kho lưu trữ match log toàn cục để phục vụ xem lại (matchId -> MatchLog)
const matchLogsStore = new Map();

/**
 * Lấy hoặc khởi tạo phòng (Mặc định có phòng 'PUBLIC')
 */
function getOrCreateRoom(roomId = 'PUBLIC', roomName = null) {
  const normalizedId = (roomId || 'PUBLIC').trim().toUpperCase();
  if (!rooms.has(normalizedId)) {
    const isPublic = normalizedId === 'PUBLIC';
    const room = {
      roomId: normalizedId,
      name: roomName || (isPublic ? 'Public Global Arena' : `Private Room ${normalizedId}`),
      isPrivate: !isPublic,
      bots: new Map(),
      queue: new Set(),
      leaderboard: [],
      isBatchRunning: false,
      createdAt: Date.now()
    };

    // Nạp sẵn bot mẫu cho phòng public
    if (isPublic) {
      for (const b of DEFAULT_SAMPLE_BOTS) {
        room.bots.set(b.id, {
          playerId: b.id,
          playerName: b.name,
          author: b.author,
          botCode: b.code,
          updatedAt: Date.now()
        });
      }
    }

    rooms.set(normalizedId, room);
  }
  return rooms.get(normalizedId);
}

// Khởi tạo sẵn phòng PUBLIC
getOrCreateRoom('PUBLIC');

// ============================================================================
// HỆ THỐNG QUEUE & BATCH RUNNER BẤT ĐỒNG BỘ (NON-BLOCKING)
// ============================================================================

/**
 * Kích hoạt xử lý hàng đợi theo Batch tối đa 10 bot
 * Chạy bất đồng bộ qua setImmediate / async, không block Event Loop
 */
function triggerBatchRunner(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // Nếu batch trước đang chạy, batch runner sẽ tự động cuốn chiếu sau khi batch đó xong
  if (room.isBatchRunning) {
    return;
  }

  // Nếu hàng đợi rỗng, không cần chạy
  if (room.queue.size === 0) {
    return;
  }

  // Đánh dấu batch bắt đầu chạy
  room.isBatchRunning = true;

  // Sử dụng setImmediate để giải phóng call stack hiện tại ngay lập tức
  setImmediate(async () => {
    try {
      await processNextBatch(room);
    } catch (err) {
      console.error(`[BatchRunner] Lỗi khi chạy giải đấu phòng ${room.roomId}:`, err);
    } finally {
      room.isBatchRunning = false;
      // Nếu sau khi chạy xong vẫn còn bot trong queue (do người chơi mới nộp vào), tiếp tục batch kế tiếp
      if (room.queue.size > 0) {
        triggerBatchRunner(room.roomId);
      }
    }
  });
}

/**
 * Xử lý 1 batch tối đa 10 bot
 */
async function processNextBatch(room) {
  // 1. Lấy tối đa BATCH_SIZE_LIMIT bot từ queue
  const candidateIds = Array.from(room.queue).slice(0, BATCH_SIZE_LIMIT);

  // Xóa các bot này khỏi queue vì đã được đưa vào batch thi đấu
  for (const id of candidateIds) {
    room.queue.delete(id);
  }

  // Lấy dữ liệu bot tương ứng
  const batchBots = [];
  for (const id of candidateIds) {
    const b = room.bots.get(id);
    if (b) {
      batchBots.push({
        id: b.playerId,
        name: b.playerName,
        author: b.author,
        code: b.botCode
      });
    }
  }

  // 2. Nếu thiếu bot để ghép cặp (< 2 bot), bổ sung các bot mẫu
  if (batchBots.length < 2) {
    for (const sample of DEFAULT_SAMPLE_BOTS) {
      if (!batchBots.some(b => b.id === sample.id)) {
        batchBots.push({
          id: sample.id,
          name: sample.name,
          author: sample.author,
          code: sample.code
        });
      }
      if (batchBots.length >= 2) break;
    }
  }

  console.log(`[BatchRunner] Phòng ${room.roomId}: Bắt đầu chạy Batch gồm ${batchBots.length} bots...`);

  // 3. Thực thi giải đấu không đồng bộ
  // Wrap tournament run trong Promise để mô phỏng async non-blocking task
  const tournamentResult = await new Promise((resolve) => {
    setImmediate(() => {
      const res = runTournament(batchBots, { timeoutMs: 150 });
      resolve(res);
    });
  });

  // 4. Lưu Match Logs vào kho lưu trữ
  for (const match of tournamentResult.matches) {
    matchLogsStore.set(match.id, {
      ...match,
      roomId: room.roomId,
      timestamp: Date.now()
    });
  }

  // Giới hạn bộ nhớ match log (giữ 500 trận gần nhất)
  if (matchLogsStore.size > 500) {
    const keysToRemove = Array.from(matchLogsStore.keys()).slice(0, 100);
    keysToRemove.forEach(k => matchLogsStore.delete(k));
  }

  // 5. Cập nhật Bảng xếp hạng (Leaderboard) của phòng
  updateRoomLeaderboard(room, tournamentResult.leaderboard);

  console.log(`[BatchRunner] Phòng ${room.roomId}: Batch hoàn tất với ${tournamentResult.matches.length} trận đấu!`);
}

/**
 * Cập nhật bảng xếp hạng phòng dựa trên kết quả batch mới nhất
 */
function updateRoomLeaderboard(room, batchLeaderboard) {
  const currentMap = new Map();
  for (const entry of room.leaderboard) {
    currentMap.set(entry.botId, { ...entry });
  }

  for (const batchEntry of batchLeaderboard) {
    if (currentMap.has(batchEntry.botId)) {
      // Cập nhật tích lũy điểm số và thành tích
      const existing = currentMap.get(batchEntry.botId);
      existing.score += batchEntry.score;
      existing.matchesPlayed += batchEntry.matchesPlayed;
      existing.wins += batchEntry.wins;
      existing.draws += batchEntry.draws;
      existing.losses += batchEntry.losses;
      existing.errors += batchEntry.errors;
    } else {
      currentMap.set(batchEntry.botId, { ...batchEntry });
    }
  }

  // Sắp xếp lại Leaderboard theo: Điểm cao -> Thắng nhiều -> Ít lỗi
  room.leaderboard = Array.from(currentMap.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.errors !== b.errors) return a.errors - b.errors;
    return a.losses - b.losses;
  });
}

// ============================================================================
// API ENDPOINTS (HTTP REST)
// ============================================================================

/**
 * 1. POST /api/bot/submit
 * Nộp hoặc cập nhật code bot
 * Body: { playerId, playerName, author, botCode, roomId }
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

    const room = getOrCreateRoom(targetRoomId);

    // Lưu / Cập nhật thông tin bot của người chơi
    room.bots.set(assignedPlayerId, {
      playerId: assignedPlayerId,
      playerName: assignedPlayerName,
      author: assignedAuthor,
      botCode: botCode.trim(),
      updatedAt: Date.now()
    });

    // Đưa bot vào hàng đợi matchmakingQueue
    room.queue.add(assignedPlayerId);

    // Kích hoạt Batch Runner ngay lập tức
    triggerBatchRunner(targetRoomId);

    return res.status(200).json({
      success: true,
      message: 'Bot submitted successfully and queued for next tournament batch.',
      data: {
        playerId: assignedPlayerId,
        playerName: assignedPlayerName,
        roomId: targetRoomId,
        queuePosition: room.queue.size
      }
    });
  } catch (error) {
    console.error('Error in /api/bot/submit:', error);
    return res.status(500).json({ error: 'Internal server error while submitting bot.' });
  }
});

/**
 * 2. GET /api/leaderboard?roomId=...
 * Lấy bảng xếp hạng mới nhất của phòng
 */
app.get('/api/leaderboard', (req, res) => {
  try {
    const roomId = (req.query.roomId || 'PUBLIC').trim().toUpperCase();
    const room = rooms.get(roomId);

    if (!room) {
      return res.status(404).json({ error: `Room ${roomId} not found.` });
    }

    // Danh sách các trận đấu gần nhất của phòng này
    const recentMatches = Array.from(matchLogsStore.values())
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
      roomId: room.roomId,
      roomName: room.name,
      isBatchRunning: room.isBatchRunning,
      queueLength: room.queue.size,
      leaderboard: room.leaderboard,
      recentMatches
    });
  } catch (error) {
    console.error('Error in /api/leaderboard:', error);
    return res.status(500).json({ error: 'Internal server error while fetching leaderboard.' });
  }
});

/**
 * 3. GET /api/matches/:matchId
 * Lấy log chi tiết trận đấu để xem Replay
 */
app.get('/api/matches/:matchId', (req, res) => {
  try {
    const { matchId } = req.params;
    const match = matchLogsStore.get(matchId);

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
 * Tạo mã phòng riêng mới
 */
app.get('/api/room/create', (req, res) => {
  try {
    const roomName = req.query.name || null;
    const newRoomId = `ROOM_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).substring(2, 5).toUpperCase()}`;

    const newRoom = getOrCreateRoom(newRoomId, roomName);

    return res.status(201).json({
      success: true,
      message: 'Private room created successfully.',
      data: {
        roomId: newRoom.roomId,
        name: newRoom.name,
        createdAt: newRoom.createdAt
      }
    });
  } catch (error) {
    console.error('Error in /api/room/create:', error);
    return res.status(500).json({ error: 'Internal server error while creating private room.' });
  }
});

/**
 * 5. GET /api/rooms
 * Lấy danh sách các phòng hiện có
 */
app.get('/api/rooms', (req, res) => {
  try {
    const list = Array.from(rooms.values()).map(r => ({
      roomId: r.roomId,
      name: r.name,
      isPrivate: r.isPrivate,
      botCount: r.bots.size,
      queueCount: r.queue.size,
      isBatchRunning: r.isBatchRunning
    }));

    return res.status(200).json({
      success: true,
      rooms: list
    });
  } catch (error) {
    console.error('Error in /api/rooms:', error);
    return res.status(500).json({ error: 'Internal server error while fetching rooms.' });
  }
});

// ============================================================================
// KHỞI ĐỘNG SERVER
// ============================================================================
const server = app.listen(PORT, () => {
  console.log(`====================================================================`);
  console.log(`🎮 RPS ARENA 9X9 BACKEND SERVER IS RUNNING`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`⚙️  Batch Size Limit: ${BATCH_SIZE_LIMIT} bots per round`);
  console.log(`🛡️  Public Arena: Ready & Listening`);
  console.log(`====================================================================`);
});

export { app, server, rooms, matchLogsStore, getOrCreateRoom, triggerBatchRunner };
