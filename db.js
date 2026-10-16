/**
 * db.js
 * 
 * LỚP TRUY XUẤT DỮ LIỆU ĐỘC LẬP (DATABASE SERVICE / REPOSITORY ADAPTER)
 * CHO ĐẤU TRƯỜNG BOT OẰN TÙ TÌ 9X9
 * 
 * KIẾN TRÚC:
 * 1. SupabaseAdapter (Cloud PostgreSQL Database):
 *    - Kết nối Supabase thông qua @supabase/supabase-js khi có biến SUPABASE_URL & SUPABASE_KEY.
 *    - Áp dụng kiến trúc Write-Through Cache: Duy trì bộ nhớ đệm RAM đồng bộ với Supabase
 *      để đảm bảo tốc độ phản hồi tính bằng micro-giây trong các vòng lặp trận đấu,
 *      đồng thời ghi nhận bền vững lên Supabase.
 *    - Lưu match_log dưới dạng JSONB cho phép Replay đầy đủ.
 *    - Khi truy vấn danh sách trận gần đây (getRecentMatches), chủ động loại trừ match_log
 *      để payload siêu nhẹ và load tức thì.
 * 
 * 2. InMemoryAdapter (Safe Fallback):
 *    - Tự động kích hoạt khi KHÔNG có file .env hoặc kết nối Supabase thất bại.
 *    - Chạy hoàn toàn trên RAM (Map), tự động nạp 5 bot mẫu, admin mặc định và giải đấu ban đầu.
 *    - Cơ chế Pruning giới hạn tối đa 100 trận gần nhất trên RAM nhưng BẢO VỆ các trận đang là lastMatchId.
 *    - TUYỆT ĐỐI KHÔNG GHI BẤT KỲ FILE JSON CỤC BỘ NÀO RA ĐĨA (fs.writeFileSync / fs.writeFile đã bị loại bỏ hoàn toàn).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { 
  GUARDIAN_AND_STRIKER_BOT_CODE, 
  HUNTER_BOT_CODE, 
  RUSHER_BOT_CODE, 
  RANDOM_BOT_CODE 
} from './botRunner.js';
import { playMatch } from './tournamentEngine.js';

// ============================================================================
// HẰNG SỐ & SEED DATA MẶC ĐỊNH
// ============================================================================

export const DEFAULT_SYSTEM_BOTS = [];

export const DEFAULT_GLOBAL_TOURNAMENT = {
  id: 'tour_global_championship',
  name: 'RPS Arena 9×9 Championship 2026',
  description: 'Giải đấu lập trình trí tuệ nhân tạo toàn cầu thể thức đa vòng leo tháp.',
  type: 'GLOBAL',
  createdBy: 'admin',
  createdAt: Date.now(),
  isOpenForRegistration: true,
  registrationStart: new Date(Date.now() - 3600 * 1000 * 24).toISOString(),
  registrationEnd: new Date(Date.now() + 3600 * 1000 * 24 * 7).toISOString(),
  status: 'REGISTRATION',
  stagesCount: 3,
  currentStageIndex: 1,
  stages: [
    {
      stageIndex: 1,
      name: 'Vòng 1: Vòng Bảng (Qualifier)',
      topNToAdvance: 8,
      status: 'REGISTRATION',
      participatingBots: [],
      standings: [],
      matches: []
    },
    {
      stageIndex: 2,
      name: 'Vòng 2: Bán Kết (Semi-Finals)',
      topNToAdvance: 2,
      status: 'PENDING',
      participatingBots: [],
      standings: [],
      matches: []
    },
    {
      stageIndex: 3,
      name: 'Vòng 3: Chung Kết (Grand Finals)',
      topNToAdvance: 1,
      status: 'PENDING',
      participatingBots: [],
      standings: [],
      matches: []
    }
  ],
  prizes: [
    { id: 'prize_1', rank: 1, title: 'Hạng 1 (Quán Quân)', reward: 'Cúp Vàng + 500.000 VNĐ', badge: '🥇' },
    { id: 'prize_2', rank: 2, title: 'Hạng 2 (Á Quân)', reward: 'Cúp Bạc + 300.000 VNĐ', badge: '🥈' },
    { id: 'prize_3', rank: 3, title: 'Hạng 3 (Quý Quân)', reward: 'Huy Chương Đồng + 100.000 VNĐ', badge: '🥉' }
  ],
  isPrizeAnnounced: true,
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

// ============================================================================
// CÁC HÀM TIỆN ÍCH CHUẨN HÓA DỮ LIỆU & BẢO MẬT MẬT KHẨU
// ============================================================================

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, hash, salt) {
  try {
    const calc = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
  } catch (err) {
    return false;
  }
}

/**
 * Chuẩn hóa đối tượng Bot/Player đảm bảo luôn có đủ các thuộc tính đồng nhất
 */
export function normalizePlayerRecord(raw) {
  if (!raw) return null;
  const id = raw.botId || raw.playerId || raw.id || `bot_${Date.now()}`;
  const displayName = (raw.botName || raw.name || raw.playerName || raw.bot_name || 'Unnamed Bot').trim();
  const authorName = (raw.author || raw.playerName || 'Anonymous').trim();
  const language = (raw.language || 'javascript').toLowerCase();
  const roomId = (raw.roomId || raw.room_id || 'PUBLIC').trim().toUpperCase();
  const tournamentId = raw.tournamentId || raw.tournament_id || 'tour_global_championship';

  const wins = Number(raw.wins) || 0;
  const draws = Number(raw.draws) || 0;
  const losses = Number(raw.losses) || 0;
  const errors = Number(raw.errors) || 0;
  const score = Number(raw.score) || 0;
  const matchesPlayed = Number(raw.matchesPlayed ?? raw.matches_played) || (wins + draws + losses);

  let parsedUpdatedAt = Date.now();
  if (raw.updatedAt || raw.updated_at) {
    parsedUpdatedAt = typeof (raw.updatedAt || raw.updated_at) === 'number' 
      ? (raw.updatedAt || raw.updated_at) 
      : new Date(raw.updatedAt || raw.updated_at).getTime();
  }

  let parsedCreatedAt = Date.now();
  if (raw.createdAt || raw.created_at) {
    parsedCreatedAt = typeof (raw.createdAt || raw.created_at) === 'number' 
      ? (raw.createdAt || raw.created_at) 
      : new Date(raw.createdAt || raw.created_at).getTime();
  }

  const userId = raw.userId || raw.user_id || (typeof id === 'string' && id.startsWith('player_user_') ? id.replace(/^player_/, '') : (typeof id === 'string' && id.startsWith('player_') ? id.replace(/^player_/, '').split('_')[0] : null));

  return {
    id,
    botId: id,
    playerId: id,
    userId: userId || null,
    name: displayName,
    botName: displayName,
    playerName: displayName,
    author: authorName,
    language,
    botCode: raw.botCode || raw.bot_code || raw.code || RANDOM_BOT_CODE,
    score,
    wins,
    draws,
    losses,
    errors,
    matchesPlayed,
    roomId,
    tournamentId,
    lastMatchId: raw.lastMatchId || raw.last_match_id || null,
    updatedAt: parsedUpdatedAt,
    createdAt: parsedCreatedAt
  };
}

/**
 * Chuẩn hóa đối tượng Tournament
 */
export function normalizeTournamentRecord(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name || 'Giải đấu Oẳn Tù Tì',
    description: raw.description || '',
    type: raw.type || 'GLOBAL',
    createdBy: raw.createdBy || raw.created_by || 'admin',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : new Date(raw.createdAt || raw.created_at || Date.now()).getTime(),
    isOpenForRegistration: raw.isOpenForRegistration !== undefined ? raw.isOpenForRegistration : (raw.is_open_for_registration !== false),
    registrationStart: raw.registrationStart || raw.registration_start || new Date().toISOString(),
    registrationEnd: raw.registrationEnd || raw.registration_end || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    status: raw.status || 'REGISTRATION',
    stagesCount: Number(raw.stagesCount || raw.stages_count) || 3,
    currentStageIndex: Number(raw.currentStageIndex || raw.current_stage_index) || 1,
    stages: Array.isArray(raw.stages) ? raw.stages : [],
    prizes: Array.isArray(raw.prizes) ? raw.prizes : [],
    isPrizeAnnounced: raw.isPrizeAnnounced !== undefined ? raw.isPrizeAnnounced : (raw.is_prize_announced !== false),
    progress: raw.progress || {
      isRunning: false,
      totalMatches: 0,
      completedMatches: 0,
      currentBatch: 0,
      totalBatches: 0,
      percentage: 0,
      statusText: 'Sẵn sàng'
    }
  };
}

/**
 * Chuẩn hóa đối tượng User
 */
export function normalizeUserRecord(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    username: raw.username,
    passwordHash: raw.passwordHash || raw.password_hash,
    salt: raw.salt,
    role: raw.role || 'user',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : new Date(raw.createdAt || raw.created_at || Date.now()).getTime()
  };
}

// ============================================================================
// 1. IN-MEMORY ADAPTER (SAFE FALLBACK - KHÔNG GHI FILE CỤC BỘ)
// ============================================================================

export class InMemoryAdapter {
  constructor() {
    this.name = 'IN_MEMORY';
    this.players = new Map();
    this.matches = new Map();
    this.tournaments = new Map();
    this.users = new Map();
    this.MAX_MATCHES = 100; // Giới hạn số trận lưu trong RAM để tránh tràn bộ nhớ
  }

  async init() {
    console.log('⚡ [InMemoryAdapter] Khởi tạo kho lưu trữ In-Memory trên RAM.');

    // 1. Khởi tạo người dùng admin mặc định nếu chưa có
    if (this.users.size === 0) {
      const { hash, salt } = hashPassword('admin123');
      const adminUser = {
        id: 'user_admin_default',
        username: 'admin',
        passwordHash: hash,
        salt: salt,
        role: 'admin',
        createdAt: Date.now()
      };
      this.users.set(adminUser.id, adminUser);
    }

    // Không tự động chèn bot mẫu hay trận đấu mẫu để đảm bảo dữ liệu sạch sẽ
  }

  // --- PLAYERS CRUD ---
  async getPlayers(filter = {}) {
    let list = Array.from(this.players.values());
    if (filter.roomId && filter.roomId !== 'PUBLIC') {
      list = list.filter(p => p.roomId === filter.roomId);
    }
    if (filter.tournamentId) {
      list = list.filter(p => p.tournamentId === filter.tournamentId);
    }
    return list.map(normalizePlayerRecord);
  }

  async getPlayerById(id) {
    if (!id) return null;
    const p = this.players.get(id);
    return p ? normalizePlayerRecord(p) : null;
  }

  async savePlayer(playerData) {
    const record = normalizePlayerRecord(playerData);
    this.players.set(record.id, record);
    return record;
  }

  async createPlayer(playerData) {
    return this.savePlayer(playerData);
  }

  async updatePlayer(id, updateFields) {
    const existing = await this.getPlayerById(id);
    if (!existing) return null;
    const merged = {
      ...existing,
      ...updateFields,
      id,
      botId: id,
      updatedAt: Date.now()
    };
    return this.savePlayer(merged);
  }

  async getPlayerByUserAndTournament(params = {}) {
    const { userId, username, author, botId, playerId, tournamentId, roomId } = params;
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

    for (const p of this.players.values()) {
      const tourMatch = tournamentId ? p.tournamentId === tournamentId : (normRoom === 'PUBLIC' || (p.roomId || 'PUBLIC').trim().toUpperCase() === normRoom);
      if (!tourMatch) continue;

      if (botId && (p.id === botId || p.botId === botId)) return normalizePlayerRecord(p);
      if (playerId && (p.id === playerId || p.playerId === playerId)) return normalizePlayerRecord(p);
      if (userId && (p.id === `player_${userId}` || p.id === userId || p.author === userId)) return normalizePlayerRecord(p);
      const authorName = username || author;
      if (authorName && authorName !== 'Anonymous' && p.author === authorName) return normalizePlayerRecord(p);
    }
    return null;
  }

  async getPlayerByUserIdAndTournament(params = {}) {
    const { userId, tournamentId, roomId } = params;
    if (!userId) return null;
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

    for (const p of this.players.values()) {
      const isUserMatch = (p.userId === userId || p.id === `player_${userId}` || p.id === userId || (tournamentId && p.id === `player_${userId}_${tournamentId}`));
      if (!isUserMatch) continue;

      const tourMatch = tournamentId
        ? p.tournamentId === tournamentId
        : (normRoom === 'PUBLIC' || (p.roomId || 'PUBLIC').trim().toUpperCase() === normRoom);
      if (tourMatch) {
        return normalizePlayerRecord(p);
      }
    }
    return null;
  }

  async resetPlayerMatchHistory(botId, tournamentId = null, roomId = 'PUBLIC') {
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();
    for (const [mId, m] of this.matches.entries()) {
      const rId = m.botRed?.id || m.botRed?.botId;
      const bId = m.botBlue?.id || m.botBlue?.botId;
      if (rId === botId || bId === botId) {
        const tourMatch = tournamentId ? m.tournamentId === tournamentId : (normRoom === 'PUBLIC' || (m.roomId || 'PUBLIC').trim().toUpperCase() === normRoom);
        if (tourMatch) {
          this.matches.delete(mId);
        }
      }
    }
  }

  async getLeaderboard(roomId = 'PUBLIC', tournamentId = null) {
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();
    const list = Array.from(this.players.values())
      .filter(p => {
        if (tournamentId) return p.tournamentId === tournamentId;
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

  // --- MATCHES CRUD ---
  async saveMatch(matchResult) {
    if (!matchResult || !matchResult.id) return null;
    const matchRecord = {
      ...matchResult,
      roomId: matchResult.roomId || 'PUBLIC',
      timestamp: matchResult.timestamp || Date.now()
    };
    this.matches.set(matchResult.id, matchRecord);

    // Cập nhật lastMatchId cho cả Red & Blue
    const redId = matchResult.botRed?.id || matchResult.botRed?.botId;
    const blueId = matchResult.botBlue?.id || matchResult.botBlue?.botId;
    if (redId && this.players.has(redId)) {
      this.players.get(redId).lastMatchId = matchResult.id;
    }
    if (blueId && this.players.has(blueId)) {
      this.players.get(blueId).lastMatchId = matchResult.id;
    }

    // Dọn dẹp bớt trận cũ để không tràn RAM, nhưng bảo vệ các trận là lastMatchId
    this.pruneOldMatches();
    return matchRecord;
  }

  async getMatchById(matchId) {
    if (!matchId) return null;
    return this.matches.get(matchId) || null;
  }

  async getRecentMatches(filter = {}, limit = 20) {
    const normRoom = filter.roomId ? filter.roomId.trim().toUpperCase() : null;
    const tourId = filter.tournamentId || null;
    const stageNum = filter.stageIndex ? Number(filter.stageIndex) : null;

    let list = Array.from(this.matches.values());

    if (tourId) {
      list = list.filter(m => (m.tournamentId === tourId || m.roomId === tourId) && (!stageNum || m.stageIndex === stageNum));
    } else if (normRoom) {
      list = list.filter(m => (m.roomId || 'PUBLIC') === normRoom);
    }

    return list
      .slice(-limit)
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
        endReason: m.endReason,
        timestamp: m.timestamp || (m.created_at ? new Date(m.created_at).getTime() : Date.now()),
        roomId: m.roomId,
        tournamentId: m.tournamentId,
        stageIndex: m.stageIndex
      }));
  }

  pruneOldMatches() {
    if (this.matches.size <= this.MAX_MATCHES) return;

    const protectedMatchIds = new Set();
    for (const p of this.players.values()) {
      if (p.lastMatchId) protectedMatchIds.add(p.lastMatchId);
    }

    for (const key of this.matches.keys()) {
      if (this.matches.size <= this.MAX_MATCHES) break;
      if (!protectedMatchIds.has(key)) {
        this.matches.delete(key);
      }
    }
  }

  // --- TOURNAMENTS CRUD ---
  async getTournaments() {
    return Array.from(this.tournaments.values()).map(normalizeTournamentRecord);
  }

  async getTournamentById(id) {
    if (!id) return null;
    const t = this.tournaments.get(id);
    return t ? normalizeTournamentRecord(t) : null;
  }

  async saveTournament(tourData) {
    const t = normalizeTournamentRecord(tourData);
    this.tournaments.set(t.id, t);
    return t;
  }

  async deleteTournament(id) {
    if (!id) return false;
    return this.tournaments.delete(id);
  }

  // --- USERS CRUD ---
  async getUsers() {
    return Array.from(this.users.values()).map(normalizeUserRecord);
  }

  async getUserById(id) {
    if (!id) return null;
    const u = this.users.get(id);
    return u ? normalizeUserRecord(u) : null;
  }

  async getUserByUsername(username) {
    if (!username) return null;
    const lower = username.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.username && u.username.toLowerCase() === lower) {
        return normalizeUserRecord(u);
      }
    }
    return null;
  }

  async saveUser(userData) {
    const u = normalizeUserRecord(userData);
    this.users.set(u.id, u);
    return u;
  }
}

// ============================================================================
// 2. SUPABASE ADAPTER (POSTGRESQL CLOUD DATABASE VỚI WRITE-THROUGH CACHE)
// ============================================================================

export class SupabaseAdapter {
  constructor(client) {
    this.name = 'SUPABASE';
    this.client = client;
    this.players = new Map();
    this.matches = new Map();
    this.tournaments = new Map();
    this.users = new Map();
    this.MAX_MATCHES = 100;
  }

  async init() {
    console.log('☁️ [SupabaseAdapter] Đang đồng bộ hóa dữ liệu từ Supabase Cloud...');

    // 1. Tải và kiểm tra bảng users
    try {
      const { data: users, error: uErr } = await this.client.from('users').select('*');
      if (!uErr && Array.isArray(users)) {
        for (const u of users) {
          const norm = normalizeUserRecord(u);
          this.users.set(norm.id, norm);
        }
      }

      if (this.users.size === 0) {
        const { hash, salt } = hashPassword('admin123');
        const adminUser = {
          id: 'user_admin_default',
          username: 'admin',
          passwordHash: hash,
          salt: salt,
          role: 'admin',
          createdAt: Date.now()
        };
        await this.saveUser(adminUser);
        console.log('[Supabase] 👑 Đã khởi tạo tài khoản Admin mặc định trên Supabase (admin / admin123).');
      }
    } catch (err) {
      console.warn('[Supabase] Cảnh báo kiểm tra bảng users:', err.message);
    }

    // 2. Tải bảng tournaments (Không tự động insert nếu database rỗng)
    try {
      const { data: tours, error: tErr } = await this.client.from('tournaments').select('*');
      if (!tErr && Array.isArray(tours)) {
        for (const t of tours) {
          const norm = normalizeTournamentRecord(t);
          this.tournaments.set(norm.id, norm);
        }
      }
    } catch (err) {
      console.warn('[Supabase] Cảnh báo kiểm tra bảng tournaments:', err.message);
    }

    // 3. Tải bảng players (Không tự động insert các bot mẫu cũ nếu database rỗng)
    try {
      const { data: bots, error: bErr } = await this.client.from('players').select('*');
      if (!bErr && Array.isArray(bots)) {
        for (const b of bots) {
          const norm = normalizePlayerRecord(b);
          this.players.set(norm.id, norm);
        }
      }
    } catch (err) {
      console.warn('[Supabase] Cảnh báo kiểm tra bảng players:', err.message);
    }

    // 4. Tải các trận gần đây vào cache RAM
    try {
      const { data: recent, error: mErr } = await this.client
        .from('matches')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (!mErr && Array.isArray(recent)) {
        for (const m of recent) {
          const log = m.match_log || {};
          this.matches.set(m.id, {
            id: m.id,
            roomId: m.room_id,
            tournamentId: m.tournament_id,
            stageIndex: m.stage_index,
            winner: m.winner,
            winnerBotId: m.winner_bot_id,
            totalTurns: m.total_turns,
            endReason: m.end_reason,
            botRed: log.botRed || m.bot_red,
            botBlue: log.botBlue || m.bot_blue,
            turns: log.turns || [],
            timestamp: new Date(m.created_at).getTime()
          });
        }
      }
    } catch (err) {
      console.warn('[Supabase] Cảnh báo tải trận đấu gần đây:', err.message);
    }
  }

  // --- PLAYERS CRUD ---
  async getPlayers(filter = {}) {
    try {
      let query = this.client.from('players').select('*');
      if (filter.roomId && filter.roomId !== 'PUBLIC') {
        query = query.eq('room_id', filter.roomId);
      }
      if (filter.tournamentId) {
        query = query.eq('tournament_id', filter.tournamentId);
      }
      const { data, error } = await query;
      if (error) {
        console.error('[Supabase getPlayers Error]:', error.message);
        return [];
      }
      if (Array.isArray(data)) {
        if (!filter.roomId || filter.roomId === 'PUBLIC') {
          this.players.clear();
          for (const row of data) {
            const norm = normalizePlayerRecord(row);
            this.players.set(norm.id, norm);
          }
        }
        return data.map(normalizePlayerRecord);
      }
    } catch (e) {
      console.error('[Supabase getPlayers Exception]:', e.message);
    }
    return [];
  }

  async getPlayerById(id) {
    if (!id) return null;
    if (this.players.has(id)) {
      return normalizePlayerRecord(this.players.get(id));
    }
    try {
      const { data, error } = await this.client.from('players').select('*').eq('id', id).maybeSingle();
      if (!error && data) {
        const norm = normalizePlayerRecord(data);
        this.players.set(norm.id, norm);
        return norm;
      }
    } catch (e) {}
    return null;
  }

  async savePlayer(playerData) {
    const p = normalizePlayerRecord(playerData);
    this.players.set(p.id, p);

    try {
      const row = {
        id: p.id,
        bot_name: p.botName || p.name,
        author: p.author || 'Anonymous',
        language: p.language || 'javascript',
        bot_code: p.botCode || '',
        score: p.score || 0,
        wins: p.wins || 0,
        draws: p.draws || 0,
        losses: p.losses || 0,
        errors: p.errors || 0,
        matches_played: p.matchesPlayed || (p.wins + p.draws + p.losses),
        room_id: p.roomId || 'PUBLIC',
        tournament_id: p.tournamentId || 'tour_global_championship',
        last_match_id: p.lastMatchId || null,
        updated_at: new Date(p.updatedAt || Date.now()).toISOString()
      };

      const { data, error } = await this.client
        .from('players')
        .upsert(row, { onConflict: 'id' });

      if (error) {
        console.error('[Supabase savePlayer Error]:', error.message);
      }
    } catch (err) {
      console.error('Lỗi lưu player vào Supabase:', err.message || err);
    }

    return p;
  }

  async createPlayer(playerData) {
    return this.savePlayer(playerData);
  }

  async updatePlayer(id, updateFields) {
    const existing = await this.getPlayerById(id);
    if (!existing) return null;
    const merged = {
      ...existing,
      ...updateFields,
      id,
      botId: id,
      updatedAt: Date.now()
    };
    return this.savePlayer(merged);
  }

  async getPlayerByUserAndTournament(params = {}) {
    const { userId, username, author, botId, playerId, tournamentId, roomId } = params;
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

    // 1. Tìm trong Supabase
    try {
      let query = this.client.from('players').select('*');
      if (tournamentId) {
        query = query.eq('tournament_id', tournamentId);
      } else if (normRoom !== 'PUBLIC') {
        query = query.eq('room_id', normRoom);
      }

      const orConditions = [];
      if (botId) orConditions.push(`id.eq.${botId}`);
      if (playerId) orConditions.push(`id.eq.${playerId}`);
      if (userId) {
        orConditions.push(`id.eq.player_${userId}`);
        orConditions.push(`id.eq.${userId}`);
      }
      const authorName = username || author;
      if (authorName && authorName !== 'Anonymous') {
        orConditions.push(`author.eq.${authorName}`);
      }

      if (orConditions.length > 0) {
        query = query.or(orConditions.join(','));
      } else {
        return null;
      }

      const { data, error } = await query.limit(1);
      if (!error && Array.isArray(data) && data.length > 0) {
        const found = normalizePlayerRecord(data[0]);
        this.players.set(found.id, found);
        return found;
      }
    } catch (err) {
      console.warn('[Supabase getPlayerByUserAndTournament]:', err.message);
    }

    // 2. Fallback tìm trong cache RAM
    for (const p of this.players.values()) {
      const tourMatch = tournamentId ? p.tournamentId === tournamentId : (normRoom === 'PUBLIC' || (p.roomId || 'PUBLIC').trim().toUpperCase() === normRoom);
      if (!tourMatch) continue;

      if (botId && (p.id === botId || p.botId === botId)) return normalizePlayerRecord(p);
      if (playerId && (p.id === playerId || p.playerId === playerId)) return normalizePlayerRecord(p);
      if (userId && (p.id === `player_${userId}` || p.id === userId || p.author === userId)) return normalizePlayerRecord(p);
      const authorName = username || author;
      if (authorName && authorName !== 'Anonymous' && p.author === authorName) return normalizePlayerRecord(p);
    }

    return null;
  }

  async getPlayerByUserIdAndTournament(params = {}) {
    const { userId, tournamentId, roomId } = params;
    if (!userId) return null;
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

    // 1. Tìm trong Supabase theo ID cố định theo User (player_${userId})
    try {
      let query = this.client.from('players').select('*');
      if (tournamentId) {
        query = query.eq('tournament_id', tournamentId);
      } else if (normRoom !== 'PUBLIC') {
        query = query.eq('room_id', normRoom);
      }

      const orConds = [`id.eq.player_${userId}`, `id.eq.${userId}`];
      if (tournamentId) {
        orConds.push(`id.eq.player_${userId}_${tournamentId}`);
      }
      query = query.or(orConds.join(','));

      const { data, error } = await query.limit(1);
      if (!error && Array.isArray(data) && data.length > 0) {
        const found = normalizePlayerRecord(data[0]);
        found.userId = userId;
        this.players.set(found.id, found);
        return found;
      }
    } catch (err) {
      console.warn('[Supabase getPlayerByUserIdAndTournament]:', err.message);
    }

    // 2. Fallback tìm trong cache RAM
    for (const p of this.players.values()) {
      const isUserMatch = (p.userId === userId || p.id === `player_${userId}` || p.id === userId || (tournamentId && p.id === `player_${userId}_${tournamentId}`));
      if (!isUserMatch) continue;

      const tourMatch = tournamentId
        ? p.tournamentId === tournamentId
        : (normRoom === 'PUBLIC' || (p.roomId || 'PUBLIC').trim().toUpperCase() === normRoom);
      if (tourMatch) {
        p.userId = userId;
        return normalizePlayerRecord(p);
      }
    }

    return null;
  }

  async resetPlayerMatchHistory(botId, tournamentId = null, roomId = 'PUBLIC') {
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();

    // 1. Xóa trong database Supabase
    try {
      let query = this.client.from('matches').delete()
        .or(`red_bot_id.eq.${botId},blue_bot_id.eq.${botId}`);
      if (tournamentId) {
        query = query.eq('tournament_id', tournamentId);
      } else if (normRoom !== 'PUBLIC') {
        query = query.eq('room_id', normRoom);
      }
      const { error } = await query;
      if (error) {
        console.warn('[Supabase resetPlayerMatchHistory]:', error.message);
      }
    } catch (e) {
      console.warn('[Supabase resetPlayerMatchHistory Error]:', e.message);
    }

    // 2. Xóa trong RAM cache matches
    for (const [mId, m] of this.matches.entries()) {
      const rId = m.botRed?.id || m.botRed?.botId;
      const bId = m.botBlue?.id || m.botBlue?.botId;
      if (rId === botId || bId === botId) {
        const tourMatch = tournamentId ? m.tournamentId === tournamentId : (normRoom === 'PUBLIC' || (m.roomId || 'PUBLIC').trim().toUpperCase() === normRoom);
        if (tourMatch) {
          this.matches.delete(mId);
        }
      }
    }
  }

  async getLeaderboard(roomId = 'PUBLIC', tournamentId = null) {
    const normRoom = (roomId || 'PUBLIC').trim().toUpperCase();
    try {
      let query = this.client.from('players').select('*');
      if (tournamentId) {
        query = query.eq('tournament_id', tournamentId);
      } else if (normRoom !== 'PUBLIC') {
        query = query.eq('room_id', normRoom);
      }
      const { data, error } = await query;
      if (error) {
        console.error('[Supabase getLeaderboard Error]:', error.message);
        return [];
      }
      if (Array.isArray(data)) {
        if (normRoom === 'PUBLIC' && !tournamentId) {
          this.players.clear();
          for (const row of data) {
            const norm = normalizePlayerRecord(row);
            this.players.set(norm.id, norm);
          }
        }
        const list = data.map(normalizePlayerRecord);
        return list.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.wins !== a.wins) return b.wins - a.wins;
          if (a.errors !== b.errors) return a.errors - b.errors;
          return a.losses - b.losses;
        });
      }
    } catch (e) {
      console.error('[Supabase getLeaderboard Exception]:', e.message);
    }
    return [];
  }

  // --- MATCHES CRUD ---
  async saveMatch(matchResult) {
    if (!matchResult || !matchResult.id) return null;

    const matchRecord = {
      ...matchResult,
      roomId: matchResult.roomId || 'PUBLIC',
      timestamp: matchResult.timestamp || Date.now()
    };
    this.matches.set(matchResult.id, matchRecord);

    // Cập nhật lastMatchId cho cả Red & Blue trong cache
    const redId = matchResult.botRed?.id || matchResult.botRed?.botId;
    const blueId = matchResult.botBlue?.id || matchResult.botBlue?.botId;
    if (redId && this.players.has(redId)) {
      this.players.get(redId).lastMatchId = matchResult.id;
    }
    if (blueId && this.players.has(blueId)) {
      this.players.get(blueId).lastMatchId = matchResult.id;
    }

    try {
      const row = {
        id: matchResult.id,
        room_id: matchResult.roomId || 'PUBLIC',
        tournament_id: matchResult.tournamentId || null,
        stage_index: matchResult.stageIndex || null,
        red_bot_id: redId || null,
        blue_bot_id: blueId || null,
        winner: matchResult.winner || null,
        winner_bot_id: matchResult.winnerBotId || null,
        total_turns: matchResult.totalTurns || 0,
        end_reason: matchResult.endReason || null,
        bot_red: matchResult.botRed || {},
        bot_blue: matchResult.botBlue || {},
        match_log: {
          id: matchResult.id,
          totalTurns: matchResult.totalTurns,
          winner: matchResult.winner,
          winnerBotId: matchResult.winnerBotId,
          endReason: matchResult.endReason,
          botRed: matchResult.botRed,
          botBlue: matchResult.botBlue,
          turns: matchResult.turns || []
        },
        created_at: new Date(matchResult.timestamp || Date.now()).toISOString()
      };

      const { data, error } = await this.client
        .from('matches')
        .upsert(row, { onConflict: 'id' });

      if (error) {
        console.error('[Supabase saveMatch Error]:', error.message);
      } else {
        if (redId) {
          const { error: rErr } = await this.client.from('players').update({ last_match_id: row.id }).eq('id', redId);
          if (rErr) console.warn('[Supabase update red last_match_id]:', rErr.message);
        }
        if (blueId) {
          const { error: bErr } = await this.client.from('players').update({ last_match_id: row.id }).eq('id', blueId);
          if (bErr) console.warn('[Supabase update blue last_match_id]:', bErr.message);
        }
      }
    } catch (err) {
      console.error('Lỗi lưu match vào Supabase:', err.message || err);
    }

    this.pruneOldMatches();
    return matchRecord;
  }

  async getMatchById(matchId) {
    if (!matchId) return null;
    if (this.matches.has(matchId)) {
      return this.matches.get(matchId);
    }

    const { data, error } = await this.client.from('matches').select('*').eq('id', matchId).maybeSingle();
    if (error || !data) return null;

    const log = data.match_log || {};
    const fullMatch = {
      id: data.id,
      roomId: data.room_id,
      tournamentId: data.tournament_id,
      stageIndex: data.stage_index,
      winner: data.winner,
      winnerBotId: data.winner_bot_id,
      totalTurns: data.total_turns,
      endReason: data.end_reason,
      botRed: log.botRed || data.bot_red,
      botBlue: log.botBlue || data.bot_blue,
      turns: log.turns || [],
      timestamp: new Date(data.created_at).getTime()
    };

    this.matches.set(data.id, fullMatch);
    return fullMatch;
  }

  async getRecentMatches(filter = {}, limit = 20) {
    const normRoom = filter.roomId ? filter.roomId.trim().toUpperCase() : null;
    const tourId = filter.tournamentId || null;
    const stageNum = filter.stageIndex ? Number(filter.stageIndex) : null;

    try {
      let query = this.client.from('matches').select('*').order('created_at', { ascending: false }).limit(limit);
      if (tourId) {
        query = query.or(`tournament_id.eq.${tourId},room_id.eq.${tourId}`);
      } else if (normRoom && normRoom !== 'PUBLIC') {
        query = query.eq('room_id', normRoom);
      }
      if (stageNum) {
        query = query.eq('stage_index', stageNum);
      }

      const { data, error } = await query;
      if (!error && Array.isArray(data)) {
        if (!tourId && (!normRoom || normRoom === 'PUBLIC')) {
          this.matches.clear();
        }
        const matchesList = [];
        for (const m of data) {
          const log = m.match_log || {};
          const fullMatch = {
            id: m.id,
            roomId: m.room_id,
            tournamentId: m.tournament_id,
            stageIndex: m.stage_index,
            winner: m.winner,
            winnerBotId: m.winner_bot_id,
            totalTurns: m.total_turns,
            endReason: m.end_reason,
            botRed: log.botRed || m.bot_red || { id: m.red_bot_id, name: 'Red Bot' },
            botBlue: log.botBlue || m.bot_blue || { id: m.blue_bot_id, name: 'Blue Bot' },
            turns: log.turns || [],
            timestamp: new Date(m.created_at).getTime()
          };
          this.matches.set(fullMatch.id, fullMatch);
          matchesList.push(fullMatch);
        }
        return matchesList.map(m => ({
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
          endReason: m.endReason,
          timestamp: m.timestamp,
          roomId: m.roomId,
          tournamentId: m.tournamentId,
          stageIndex: m.stageIndex
        }));
      }
      if (error) {
        console.error('[Supabase getRecentMatches Error]:', error.message);
        return [];
      }
    } catch (e) {
      console.error('[Supabase getRecentMatches Exception]:', e.message);
    }
    return [];
  }

  pruneOldMatches() {
    if (this.matches.size <= this.MAX_MATCHES) return;

    const protectedMatchIds = new Set();
    for (const p of this.players.values()) {
      if (p.lastMatchId) protectedMatchIds.add(p.lastMatchId);
    }

    for (const key of this.matches.keys()) {
      if (this.matches.size <= this.MAX_MATCHES) break;
      if (!protectedMatchIds.has(key)) {
        this.matches.delete(key);
      }
    }
  }

  // --- TOURNAMENTS CRUD ---
  async getTournaments() {
    try {
      const { data, error } = await this.client.from('tournaments').select('*');
      if (!error && Array.isArray(data)) {
        this.tournaments.clear();
        for (const t of data) {
          const norm = normalizeTournamentRecord(t);
          this.tournaments.set(norm.id, norm);
        }
        return data.map(normalizeTournamentRecord);
      }
    } catch (e) {
      console.warn('[Supabase getTournaments Error]:', e.message);
    }
    return Array.from(this.tournaments.values()).map(normalizeTournamentRecord);
  }

  async getTournamentById(id) {
    if (!id) return null;
    if (this.tournaments.has(id)) {
      return this.tournaments.get(id);
    }
    try {
      const { data, error } = await this.client.from('tournaments').select('*').eq('id', id).maybeSingle();
      if (!error && data) {
        const norm = normalizeTournamentRecord(data);
        this.tournaments.set(norm.id, norm);
        return norm;
      }
    } catch (e) {}
    return null;
  }

  async saveTournament(tourData) {
    const t = normalizeTournamentRecord(tourData);
    this.tournaments.set(t.id, t);

    try {
      const row = {
        id: t.id,
        name: t.name,
        description: t.description || '',
        type: t.type || 'GLOBAL',
        created_by: t.createdBy || 'admin',
        is_open_for_registration: t.isOpenForRegistration !== false,
        registration_start: t.registrationStart ? new Date(t.registrationStart).toISOString() : null,
        registration_end: t.registrationEnd ? new Date(t.registrationEnd).toISOString() : null,
        status: t.status || 'REGISTRATION',
        stages_count: t.stagesCount || 3,
        current_stage_index: t.currentStageIndex || 1,
        stages: t.stages || [],
        prizes: t.prizes || [],
        is_prize_announced: t.isPrizeAnnounced !== false,
        progress: t.progress || {},
        updated_at: new Date().toISOString()
      };

      const { data, error } = await this.client
        .from('tournaments')
        .upsert(row, { onConflict: 'id' });

      if (error) {
        console.error('[Supabase saveTournament Error]:', error.message);
        throw new Error(error.message);
      }
    } catch (err) {
      console.error('Lỗi lưu tournament vào Supabase:', err.message || err);
    }

    return t;
  }

  async deleteTournament(id) {
    if (!id) return false;
    this.tournaments.delete(id);
    const { error } = await this.client.from('tournaments').delete().eq('id', id);
    if (error) {
      console.error('[Supabase] Lỗi khi xóa tournament:', error.message);
      return false;
    }
    return true;
  }

  // --- USERS CRUD ---
  async getUsers() {
    return Array.from(this.users.values()).map(normalizeUserRecord);
  }

  async getUserById(id) {
    if (!id) return null;
    const u = this.users.get(id);
    return u ? normalizeUserRecord(u) : null;
  }

  async getUserByUsername(username) {
    if (!username) return null;
    const lower = username.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.username && u.username.toLowerCase() === lower) {
        return normalizeUserRecord(u);
      }
    }
    return null;
  }

  async saveUser(user) {
    const u = normalizeUserRecord(user);
    this.users.set(u.id, u);

    try {
      const payload = {
        id: u.id,
        username: u.username,
        password_hash: u.passwordHash || u.password_hash,
        salt: u.salt,
        role: u.role || 'user',
        created_at: u.createdAt ? new Date(u.createdAt).toISOString() : new Date().toISOString()
      };

      const { data, error } = await this.client
        .from('users')
        .upsert(payload, { onConflict: 'username' });

      if (error) {
        console.error('[Supabase saveUser Error]:', error.message);
        throw new Error(error.message);
      }

      return u;
    } catch (err) {
      console.error('Lỗi lưu user vào Supabase:', err.message || err);
      throw err;
    }
  }
}

// ============================================================================
// 3. DATABASE SERVICE (FACADE SINGLETON QUẢN LÝ ADAPTER)
// ============================================================================

export class DatabaseService {
  constructor() {
    this.adapter = null;
    this.mode = 'UNINITIALIZED';
  }

  get players() {
    return this.adapter ? this.adapter.players : new Map();
  }

  get matches() {
    return this.adapter ? this.adapter.matches : new Map();
  }

  get tournaments() {
    return this.adapter ? this.adapter.tournaments : new Map();
  }

  get users() {
    return this.adapter ? this.adapter.users : new Map();
  }

  async init() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    let useSupabase = false;

    if (supabaseUrl && supabaseKey && supabaseUrl.trim().length > 0 && supabaseKey.trim().length > 0) {
      try {
        console.log(`🔌 [Database] Tìm thấy thông số Supabase. Đang kiểm tra kết nối tới: ${supabaseUrl}...`);
        const client = createClient(supabaseUrl.trim(), supabaseKey.trim(), {
          auth: { persistSession: false }
        });

        // Test nhẹ kết nối
        const testRes = await client.from('users').select('id').limit(1);
        if (testRes.error && testRes.error.code !== 'PGRST116') {
          console.error('❌ [Database] Không thể truy vấn Supabase:', testRes.error.message);
          console.error('👉 CẢNH BÁO: Tạm thời chuyển sang IN-MEMORY an toàn (RAM).');
        } else {
          this.adapter = new SupabaseAdapter(client);
          await this.adapter.init();
          this.mode = 'SUPABASE';
          useSupabase = true;
          console.log('====================================================');
          console.log('✅ [Database] CHẾ ĐỘ HOẠT ĐỘNG: SUPABASE CLOUD');
          console.log('🌐 Endpoint:', supabaseUrl);
          console.log('🛡️  Single Source of Truth: 100% từ Supabase (Không dùng mock bot / local file)');
          console.log('====================================================');
        }
      } catch (err) {
        console.error('❌ [Database] Lỗi kết nối Supabase:', err.message);
        console.error('👉 CẢNH BÁO: Tạm thời chuyển sang IN-MEMORY an toàn (RAM).');
      }
    } else {
      console.warn('⚠️ [Database] Không tìm thấy SUPABASE_URL hoặc SUPABASE_KEY trong file .env');
    }

    if (!useSupabase) {
      this.adapter = new InMemoryAdapter();
      await this.adapter.init();
      this.mode = 'IN_MEMORY';
      console.log('====================================================');
      console.log('⚠️ [Database] CHẾ ĐỘ HOẠT ĐỘNG: IN-MEMORY (RAM)');
      console.log('ℹ️  Để kết nối Supabase, hãy kiểm tra lại biến môi trường trong .env.');
      console.log('🛡️  Cam kết: Hoàn toàn không tự gieo bot mẫu hay ghi file JSON cục bộ.');
      console.log('====================================================');
    }

    return this.mode;
  }

  // --- Wrapper Methods chuyển tiếp tới Adapter đang hoạt động ---

  async getPlayers(filter) {
    return this.adapter.getPlayers(filter);
  }

  async getPlayerById(id) {
    return this.adapter.getPlayerById(id);
  }

  async savePlayer(playerData) {
    return this.adapter.savePlayer(playerData);
  }

  async createPlayer(playerData) {
    return this.adapter.createPlayer(playerData);
  }

  async updatePlayer(id, updateFields) {
    return this.adapter.updatePlayer(id, updateFields);
  }

  async getPlayerByUserAndTournament(params) {
    return this.adapter.getPlayerByUserAndTournament(params);
  }

  async getPlayerByUserIdAndTournament(params) {
    return this.adapter.getPlayerByUserIdAndTournament(params);
  }

  async resetPlayerMatchHistory(botId, tournamentId, roomId) {
    return this.adapter.resetPlayerMatchHistory(botId, tournamentId, roomId);
  }

  async getLeaderboard(roomId, tournamentId) {
    return this.adapter.getLeaderboard(roomId, tournamentId);
  }

  async saveMatch(matchResult) {
    return this.adapter.saveMatch(matchResult);
  }

  async getMatchById(matchId) {
    return this.adapter.getMatchById(matchId);
  }

  async getRecentMatches(filter, limit) {
    return this.adapter.getRecentMatches(filter, limit);
  }

  async getTournaments() {
    return this.adapter.getTournaments();
  }

  async getTournamentById(id) {
    return this.adapter.getTournamentById(id);
  }

  async saveTournament(tourData) {
    return this.adapter.saveTournament(tourData);
  }

  async deleteTournament(id) {
    return this.adapter.deleteTournament(id);
  }

  async getUsers() {
    return this.adapter.getUsers();
  }

  async getUserById(id) {
    return this.adapter.getUserById(id);
  }

  async getUserByUsername(username) {
    return this.adapter.getUserByUsername(username);
  }

  async saveUser(userData) {
    return this.adapter.saveUser(userData);
  }
}

// Export singleton instance
export const db = new DatabaseService();
export default db;
