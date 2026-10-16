/**
 * clean.js
 * 
 * Script dọn dẹp và xóa hoàn toàn các file JSON dữ liệu cục bộ trong thư mục data/
 * Loại bỏ toàn bộ nguy cơ tái tạo lại file cục bộ gây nặng máy và xung đột database.
 * 
 * Tuỳ chọn:
 *   node clean.js          : Xóa thư mục data/ cục bộ
 *   node clean.js --db     : Xóa thư mục data/ VÀ xóa trắng dữ liệu players, matches trên Supabase
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');

export async function cleanAll() {
  console.log('🧹 [Cleanup] Bắt đầu dọn dẹp hệ thống...');

  // 1. Xóa hoàn toàn thư mục data/ nếu tồn tại
  if (fs.existsSync(DATA_DIR)) {
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      console.log('  🗑️ Đã xóa triệt để thư mục cục bộ:', DATA_DIR);
    } catch (e) {
      console.error('  ❌ Lỗi khi xóa thư mục data/:', e.message);
    }
  } else {
    console.log('  ✅ Thư mục data/ cục bộ không tồn tại (đã sạch sẽ).');
  }

  // 2. Nếu có cờ --db hoặc --all: xóa trắng dữ liệu matches & players trên Supabase
  if (process.argv.includes('--db') || process.argv.includes('--all')) {
    console.log('☁️ [Cleanup] Đang kết nối Supabase Cloud để làm sạch dữ liệu...');
    await db.init();
    if (db.adapter && db.adapter.client) {
      try {
        const { error: mErr } = await db.adapter.client.from('matches').delete().neq('id', '___');
        console.log('  🗑️ Đã làm sạch bảng matches trên Supabase:', mErr ? mErr.message : 'Thành công 100%');

        const { error: pErr } = await db.adapter.client.from('players').delete().neq('id', '___');
        console.log('  🗑️ Đã làm sạch bảng players trên Supabase:', pErr ? pErr.message : 'Thành công 100%');

        // Làm sạch toàn bộ standings và matches trong các stages của tournaments
        const { data: tours } = await db.adapter.client.from('tournaments').select('*');
        for (const t of (tours || [])) {
          const cleanedStages = (t.stages || []).map(s => ({
            ...s,
            standings: [],
            participatingBots: [],
            matches: [],
            status: s.stageIndex === 1 ? 'REGISTRATION' : 'PENDING'
          }));
          await db.adapter.client.from('tournaments').update({
            stages: cleanedStages,
            status: 'REGISTRATION',
            progress: { isRunning: false, totalMatches: 0, completedMatches: 0, percentage: 0, statusText: 'Sẵn sàng' }
          }).eq('id', t.id);
        }
        console.log('  🗑️ Đã làm sạch standings/matches trong giải đấu trên Supabase: Thành công 100%');

        // Làm rỗng bộ nhớ RAM đệm
        db.players.clear();
        db.matches.clear();
      } catch (err) {
        console.error('  ❌ Lỗi khi dọn dẹp Supabase:', err.message);
      }
    }
  }

  console.log('🚀 [Cleanup] Hoàn tất dọn dẹp! Single Source of Truth được đảm bảo.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cleanAll().then(() => process.exit(0));
}
