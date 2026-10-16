/**
 * tournamentEngine.js
 * 
 * HỆ THỐNG TỔ CHỨC GIẢI ĐẤU & GHÉP CẶP ĐẤU CHO GAME OẰN TÙ TÌ 9X9
 * 
 * Tính năng chính:
 * 1. playMatch(botA, botB, options):
 *    - Đấu 1 trận duy nhất giữa Bot RED (botA) và Bot BLUE (botB).
 *    - Chạy tối đa 150 turns theo chuẩn boardEngine & botRunner.
 *    - Ghi lại toàn bộ lịch sử trận đấu (phục vụ Replay/Visualizer):
 *      matchLog = { id, botRed, botBlue, winner, reason, turns: [ { turn, player, move, captured, boardState } ] }
 * 
 * 2. runTournament(botList, options):
 *    - Ghép cặp Round-Robin 2 lượt (Double Round-Robin): Mỗi cặp đấu 2 trận (Bot A cầm RED trận 1, Bot B cầm RED trận 2).
 *    - Tính điểm: Thắng +3 điểm, Hòa +1 điểm, Thua 0 điểm.
 *    - Thống kê lỗi bot (chỉ đếm khi isError === true từ botRunner).
 *    - Trả về Leaderboard sắp xếp theo: Score giảm dần -> Hiệu số Thắng/Thua -> Ít lỗi nhất.
 *    - Trả về toàn bộ danh sách matches để xem lại.
 * 
 * 3. Quản lý Phòng đấu:
 *    - PrivateRoom(roomId, options): Phòng riêng mời bạn bè/tự chọn bot để đấu giải.
 *    - PublicArena(options): Đấu trường công cộng với hàng đợi nộp bot và tự động ghép cặp chu kỳ.
 */

import { initBoard, getLegalMoves, applyMove, PLAYER } from './boardEngine.js';
import { formatGameStateForBot, executeBotMove } from './botRunner.js';

// Hệ thống tính điểm chuẩn phong cách bóng đá / Kaggle
export const SCORING = {
  WIN: 3,
  DRAW: 1,
  LOSS: 0
};

/**
 * Tạo bản clone độc lập của board state phục vụ lưu trữ replay
 */
function cloneBoard(grid) {
  return grid.map(row => row.map(cell => (cell ? { ...cell } : null)));
}

/**
 * Chuẩn hóa thông tin bot
 * @param {Object} bot 
 * @param {number} index 
 * @returns {Object}
 */
export function normalizeBot(bot, index = 0) {
  const language = bot.language || (typeof bot.code === 'object' && bot.code?.language) || 'javascript';
  const code = bot.code || bot.botFunction || bot.botCode || bot;
  return {
    id: bot.id || `bot_${index}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    name: bot.name || bot.botName || `Bot_${index + 1}`,
    author: bot.author || 'Anonymous',
    language: language,
    code: typeof code === 'object' ? code : { code, language },
    avatar: bot.avatar || null
  };
}

/**
 * 1. THI ĐẤU 1 TRẬN: playMatch(botRed, botBlue, options)
 * 
 * @param {Object} botRedConfig - Bot cầm quân RED
 * @param {Object} botBlueConfig - Bot cầm quân BLUE
 * @param {Object} options - { timeoutMs: 200, maxTurns: 150 }
 * @returns {Object} matchLog đầy đủ chi tiết
 */
export function playMatch(botRedConfig, botBlueConfig, options = {}) {
  const timeoutMs = options.timeoutMs || 200;
  const botRed = normalizeBot(botRedConfig, 1);
  const botBlue = normalizeBot(botBlueConfig, 2);

  const matchId = options.matchId || `match_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  
  let state = initBoard();
  const turnsLog = [];

  let redErrors = 0;
  let blueErrors = 0;
  let endReason = null;

  while (!state.winner && state.turnCount < 150) {
    const currentTurn = state.turn;
    const currentBot = currentTurn === PLAYER.RED ? botRed : botBlue;

    const legalMoves = getLegalMoves(state, currentTurn);
    if (legalMoves.length === 0) {
      // Bên tới lượt không còn nước đi hợp lệ -> Đối phương thắng
      state.winner = currentTurn === PLAYER.RED ? PLAYER.BLUE : PLAYER.RED;
      endReason = `No legal moves available for ${currentTurn}`;
      break;
    }

    const payload = formatGameStateForBot({
      ...state,
      legalMoves
    }, currentTurn);

    // Chạy bot trong sandbox an toàn với timeout
    const botResult = executeBotMove(currentBot.code, payload, timeoutMs);

    if (botResult.isError) {
      if (currentTurn === PLAYER.RED) redErrors++;
      else blueErrors++;
    }

    const move = botResult.move;
    if (!move) {
      // Bot trả về null khi vẫn có legalMoves -> lỗi nặng
      state.winner = currentTurn === PLAYER.RED ? PLAYER.BLUE : PLAYER.RED;
      endReason = `Bot ${currentBot.name} returned null move`;
      break;
    }

    // Áp dụng nước đi vào board engine
    const stepResult = applyMove(state, move, currentTurn);

    // Ghi lại turn log phục vụ xem lại (Replay)
    turnsLog.push({
      turnIndex: state.turnCount,
      player: currentTurn,
      botId: currentBot.id,
      move: { from: [...move.from], to: [...move.to] },
      captured: stepResult.captured ? { ...stepResult.captured } : null,
      isError: botResult.isError,
      errorMsg: botResult.errorMsg || null,
      executionTimeMs: botResult.executionTimeMs,
      boardState: cloneBoard(stepResult.newState.grid)
    });

    state = stepResult.newState;

    if (state.winner) {
      endReason = state.winner === 'DRAW' ? 'Turn limit reached with equal pieces' : `Objective reached by ${state.winner}`;
      break;
    }
  }

  // Kết quả cuối cùng
  let winner = state.winner; // 'RED' | 'BLUE' | 'DRAW'
  if (!winner) {
    const counts = countPieces(state.grid);
    if (counts[PLAYER.RED] > counts[PLAYER.BLUE]) {
      winner = PLAYER.RED;
      endReason = endReason || `Turn limit reached: RED has more pieces (${counts[PLAYER.RED]} vs ${counts[PLAYER.BLUE]})`;
    } else if (counts[PLAYER.BLUE] > counts[PLAYER.RED]) {
      winner = PLAYER.BLUE;
      endReason = endReason || `Turn limit reached: BLUE has more pieces (${counts[PLAYER.BLUE]} vs ${counts[PLAYER.RED]})`;
    } else {
      winner = 'DRAW';
      endReason = endReason || `Turn limit reached: Equal pieces (${counts[PLAYER.RED]} vs ${counts[PLAYER.BLUE]})`;
    }
  }

  let winnerBotId = null;
  if (winner === PLAYER.RED) winnerBotId = botRed.id;
  else if (winner === PLAYER.BLUE) winnerBotId = botBlue.id;
  else {
    winner = 'DRAW';
    winnerBotId = 'DRAW';
  }

  return {
    id: matchId,
    botRed: { id: botRed.id, name: botRed.name, author: botRed.author, errors: redErrors },
    botBlue: { id: botBlue.id, name: botBlue.name, author: botBlue.author, errors: blueErrors },
    winner,              // 'RED' | 'BLUE' | 'DRAW'
    winnerBotId,
    endReason: endReason || 'Normal completion',
    totalTurns: turnsLog.length,
    initialBoard: cloneBoard(initBoard().grid),
    turns: turnsLog
  };
}

/**
 * 2. CHẠY GIẢI ĐẤU VÒNG TRÒN 1 LƯỢT: runTournament(botList, options)
 * 
 * Thể thức Single Round-Robin (C_n^2):
 * Mỗi cặp (Bot i, Bot j) sẽ thi đấu đúng 1 trận duy nhất:
 * Tổng số trận đấu: C_n^2 = n * (n - 1) / 2
 * 
 * @param {Array<Object>} botList - Danh sách các bot tham gia
 * @param {Object} options - { timeoutMs: 200, onMatchComplete: Function }
 * @returns {{ leaderboard: Array<Object>, matches: Array<Object>, summary: Object }}
 */
export function runTournament(botList, options = {}) {
  if (!Array.isArray(botList) || botList.length < 2) {
    throw new Error('Tournament requires at least 2 bots to participate');
  }

  const normalizedBots = botList.map((b, idx) => normalizeBot(b, idx));
  const matches = [];

  // Khởi tạo bảng thống kê cho từng bot
  const statsMap = new Map();
  for (const bot of normalizedBots) {
    statsMap.set(bot.id, {
      botId: bot.id,
      botName: bot.name,
      author: bot.author,
      score: 0,
      matchesPlayed: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      errors: 0
    });
  }

  const n = normalizedBots.length;

  // Ghép cặp Round-Robin 1 lượt duy nhất: C_n^2 = n * (n - 1) / 2 trận
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const isAlt = (i + j) % 2 === 0;
      const botRed = isAlt ? normalizedBots[i] : normalizedBots[j];
      const botBlue = isAlt ? normalizedBots[j] : normalizedBots[i];

      // Đấu trận
      const matchResult = playMatch(botRed, botBlue, options);
      matches.push(matchResult);

      const redStat = statsMap.get(botRed.id);
      const blueStat = statsMap.get(botBlue.id);

      redStat.matchesPlayed++;
      blueStat.matchesPlayed++;

      redStat.errors += matchResult.botRed.errors;
      blueStat.errors += matchResult.botBlue.errors;

      if (matchResult.winner === PLAYER.RED) {
        redStat.wins++;
        redStat.score += SCORING.WIN; // 3
        blueStat.losses++;
        blueStat.score += SCORING.LOSS; // 0
      } else if (matchResult.winner === PLAYER.BLUE) {
        blueStat.wins++;
        blueStat.score += SCORING.WIN; // 3
        redStat.losses++;
        redStat.score += SCORING.LOSS; // 0
      } else {
        // DRAW (Hòa: mỗi bên 1 điểm và cộng 1 lượt hòa)
        redStat.draws++;
        redStat.score += SCORING.DRAW; // 1
        blueStat.draws++;
        blueStat.score += SCORING.DRAW; // 1
      }

      if (typeof options.onMatchComplete === 'function') {
        options.onMatchComplete(matchResult, matches.length);
      }
    }
  }

  // Chuyển stats sang array và sắp xếp bảng xếp hạng
  const leaderboard = Array.from(statsMap.values()).sort((a, b) => {
    // 1. Điểm số cao hơn đứng trước
    if (b.score !== a.score) return b.score - a.score;
    // 2. Số trận thắng nhiều hơn đứng trước
    if (b.wins !== a.wins) return b.wins - a.wins;
    // 3. Số lỗi ít hơn đứng trước (ưu tiên bot sạch lỗi)
    if (a.errors !== b.errors) return a.errors - b.errors;
    // 4. Số trận thua ít hơn
    return a.losses - b.losses;
  });

  return {
    leaderboard,
    matches,
    summary: {
      totalBots: normalizedBots.length,
      totalMatches: matches.length,
      completedAt: new Date().toISOString()
    }
  };
}

/**
 * 3. QUẢN LÝ PHÒNG RIÊNG: PrivateRoom(roomId, options)
 * Thích hợp cho kịch bản người chơi tạo phòng mời bạn bè, nộp bot tùy ý rồi bấm "Start Tournament"
 */
export class PrivateRoom {
  constructor(roomId = `room_${Date.now()}`, options = {}) {
    this.roomId = roomId;
    this.name = options.name || `Private Arena ${roomId}`;
    this.creator = options.creator || 'Host';
    this.options = {
      timeoutMs: options.timeoutMs || 200,
      maxBots: options.maxBots || 16,
      ...options
    };
    this.bots = [];
    this.status = 'WAITING'; // 'WAITING' | 'RUNNING' | 'FINISHED'
    this.result = null;
  }

  /**
   * Thêm bot vào phòng riêng
   * @param {Object} botConfig 
   */
  addBot(botConfig) {
    if (this.status === 'RUNNING') {
      throw new Error('Tournament is currently in progress. Cannot add bots.');
    }
    if (this.bots.length >= this.options.maxBots) {
      throw new Error(`Room reached maximum capacity of ${this.options.maxBots} bots.`);
    }
    const bot = normalizeBot(botConfig, this.bots.length);
    this.bots.push(bot);
    return bot;
  }

  /**
   * Xóa bot khỏi phòng
   * @param {string} botId 
   */
  removeBot(botId) {
    if (this.status === 'RUNNING') {
      throw new Error('Tournament is in progress. Cannot remove bots.');
    }
    this.bots = this.bots.filter(b => b.id !== botId);
  }

  /**
   * Bắt đầu giải đấu trong phòng riêng
   * @returns {{ leaderboard: Array, matches: Array }}
   */
  startTournament() {
    if (this.bots.length < 2) {
      throw new Error('Cannot start tournament with fewer than 2 bots.');
    }
    this.status = 'RUNNING';
    try {
      this.result = runTournament(this.bots, this.options);
      this.status = 'FINISHED';
      return this.result;
    } catch (err) {
      this.status = 'WAITING';
      throw err;
    }
  }

  /**
   * Lấy thông tin trạng thái hiện tại của phòng
   */
  getInfo() {
    return {
      roomId: this.roomId,
      name: this.name,
      creator: this.creator,
      botCount: this.bots.length,
      status: this.status,
      bots: this.bots.map(b => ({ id: b.id, name: b.name, author: b.author })),
      leaderboard: this.result ? this.result.leaderboard : null
    };
  }
}

/**
 * 4. ĐẤU TRƯỜNG CHUNG (PUBLIC ARENA)
 * Mô hình Kaggle Leaderboard:
 * - Người chơi nộp bot vào hàng đợi (Queue).
 * - Chu kỳ (Tick / Batch) tự động gom các bot mới nhất cùng top bot hiện có để tổ chức giải đấu và cập nhật Bảng xếp hạng toàn cầu.
 */
export class PublicArena {
  constructor(options = {}) {
    this.name = options.name || 'Global Arena 9x9';
    this.options = {
      timeoutMs: options.timeoutMs || 200,
      seasonLength: options.seasonLength || 50,
      ...options
    };
    this.botRegistry = new Map(); // id -> Bot
    this.globalLeaderboard = [];
    this.matchHistory = [];
  }

  /**
   * Nộp hoặc cập nhật bot vào Public Arena
   * @param {Object} botConfig 
   */
  submitBot(botConfig) {
    const bot = normalizeBot(botConfig, this.botRegistry.size);
    this.botRegistry.set(bot.id, bot);
    return bot;
  }

  /**
   * Lấy danh sách tất cả các bot trong đấu trường
   */
  getAllBots() {
    return Array.from(this.botRegistry.values());
  }

  /**
   * Chạy một chu kỳ giải đấu toàn diện (Season Run)
   * Gom tất cả các bot đã đăng ký vào thi đấu Round-Robin để lập Bảng xếp hạng chính thức
   */
  runSeason() {
    const bots = this.getAllBots();
    if (bots.length < 2) {
      throw new Error('Public Arena needs at least 2 bots to run a season.');
    }

    const tournamentResult = runTournament(bots, this.options);
    this.globalLeaderboard = tournamentResult.leaderboard;
    this.matchHistory = tournamentResult.matches;

    return {
      seasonDate: new Date().toISOString(),
      leaderboard: this.globalLeaderboard,
      totalMatches: tournamentResult.matches.length
    };
  }

  /**
   * Xem lại chi tiết 1 trận đấu theo matchId
   * @param {string} matchId 
   */
  getMatchReplay(matchId) {
    return this.matchHistory.find(m => m.id === matchId) || null;
  }

  /**
   * Lấy bảng xếp hạng toàn cầu hiện tại
   */
  getLeaderboard() {
    return this.globalLeaderboard;
  }
}

export default {
  SCORING,
  playMatch,
  runTournament,
  PrivateRoom,
  PublicArena
};
