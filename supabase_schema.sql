-- ============================================================================
-- SUPABASE / POSTGRESQL SCHEMA FOR RPS ARENA 9X9 (ĐẤU TRƯỜNG BOT OẰN TÙ TÌ 9X9)
-- HƯỚNG DẪN: Copy toàn bộ nội dung script này và chạy trên SQL Editor của Supabase
-- ============================================================================

-- 1. BẢNG TÀI KHOẢN NGƯỜI DÙNG & QUẢN TRỊ VIÊN (USERS)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', -- 'user' hoặc 'admin'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username));

-- 2. BẢNG BOT / NGƯỜI CHƠI (PLAYERS)
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    bot_name TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'Anonymous',
    language TEXT NOT NULL DEFAULT 'javascript',
    bot_code TEXT NOT NULL,
    score INT NOT NULL DEFAULT 0,
    wins INT NOT NULL DEFAULT 0,
    draws INT NOT NULL DEFAULT 0,
    losses INT NOT NULL DEFAULT 0,
    errors INT NOT NULL DEFAULT 0,
    matches_played INT NOT NULL DEFAULT 0,
    room_id TEXT NOT NULL DEFAULT 'PUBLIC',
    tournament_id TEXT DEFAULT 'tour_global_championship',
    last_match_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_players_room_score ON players(room_id, score DESC, wins DESC);
CREATE INDEX IF NOT EXISTS idx_players_tournament ON players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_players_user_tournament ON players(user_id, tournament_id);

-- 3. BẢNG LỊCH SỬ TRẬN ĐẤU & REPLAY (MATCHES)
-- Chú ý: Cột match_log chứa toàn bộ turns/replay dưới dạng JSONB.
-- Khi truy vấn danh sách (list), hệ thống loại bỏ cột này để tốc độ cực nhanh và payload siêu nhẹ.
CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL DEFAULT 'PUBLIC',
    tournament_id TEXT,
    stage_index INT,
    red_bot_id TEXT,
    blue_bot_id TEXT,
    winner TEXT,
    winner_bot_id TEXT,
    total_turns INT NOT NULL DEFAULT 0,
    end_reason TEXT,
    bot_red JSONB NOT NULL DEFAULT '{}'::jsonb,
    bot_blue JSONB NOT NULL DEFAULT '{}'::jsonb,
    match_log JSONB, -- Mảng các turns, trạng thái bàn cờ 9x9 phục vụ Replay
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_matches_room_created ON matches(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_tour_stage ON matches(tournament_id, stage_index, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_bots ON matches(red_bot_id, blue_bot_id);

-- 4. BẢNG QUẢN LÝ GIẢI ĐẤU ĐA VÒNG (TOURNAMENTS)
CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'GLOBAL', -- 'GLOBAL' hoặc 'PRIVATE'
    created_by TEXT NOT NULL DEFAULT 'admin',
    is_open_for_registration BOOLEAN NOT NULL DEFAULT TRUE,
    registration_start TIMESTAMPTZ,
    registration_end TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'REGISTRATION', -- 'REGISTRATION' | 'RUNNING' | 'COMPLETED' | 'PAUSED'
    stages_count INT NOT NULL DEFAULT 3,
    current_stage_index INT NOT NULL DEFAULT 1,
    stages JSONB NOT NULL DEFAULT '[]'::jsonb,
    prizes JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_prize_announced BOOLEAN NOT NULL DEFAULT TRUE,
    progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tournaments_type_status ON tournaments(type, status);

-- 5. BẬT ROW LEVEL SECURITY (RLS) & CHÍNH SÁCH TRUY CẬP ĐẦY ĐỦ CHO BACKEND
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;

-- Chính sách cho phép truy cập đầy đủ thông qua Supabase Client
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow backend full access for users') THEN
        CREATE POLICY "Allow backend full access for users" ON users FOR ALL USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow backend full access for players') THEN
        CREATE POLICY "Allow backend full access for players" ON players FOR ALL USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow backend full access for matches') THEN
        CREATE POLICY "Allow backend full access for matches" ON matches FOR ALL USING (true) WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow backend full access for tournaments') THEN
        CREATE POLICY "Allow backend full access for tournaments" ON tournaments FOR ALL USING (true) WITH CHECK (true);
    END IF;
END $$;
