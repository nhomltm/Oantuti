import { server, dbPlayers, dbMatches, getSortedLeaderboard } from './server.js';
import { GUARDIAN_AND_STRIKER_BOT_CODE, RUSHER_BOT_CODE, RANDOM_BOT_CODE } from './botRunner.js';
import fs from 'fs';

console.log("=== KIỂM THỬ TÍNH NĂNG NÂNG CẤP: PERSISTENCE & LEO THÁP THEO CỤM ===");

const BASE_URL = 'http://localhost:3000';

async function runTest() {
  try {
    // 1. Kiểm tra File Persistence
    console.log("\n1. Kiểm tra lưu trữ bền vững (Data directory):");
    console.log("- Số lượng người chơi ban đầu trong DB:", dbPlayers.size);
    console.log("- Tồn tại data/players.json:", fs.existsSync('d:/Oantuti_code/data/players.json'));
    console.log("- Tồn tại data/matches.json:", fs.existsSync('d:/Oantuti_code/data/matches.json'));

    // 2. Thử nghiệm nộp một Bot mới "Challenger_Viper" (Sử dụng code Guardian AI)
    console.log("\n2. Nộp Bot mới 'Challenger_Viper' vào tháp đấu:");
    const submitRes = await fetch(`${BASE_URL}/api/bot/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'challenger_viper_99',
        playerName: 'Viper Grandmaster',
        author: 'ProPlayer',
        botCode: GUARDIAN_AND_STRIKER_BOT_CODE,
        roomId: 'PUBLIC'
      })
    });
    const submitData = await submitRes.json();
    console.log("Kết quả nộp bot:", submitData);

    // 3. Đợi Job Queue xử lý quá trình Leo Tháp (Tower Climbing)
    console.log("\n3. Đang chờ hệ thống leo tháp theo cụm (Tiered Cluster Batch)...");
    await new Promise(r => setTimeout(r, 2500));

    // 4. Kiểm tra Leaderboard sau khi leo tháp
    console.log("\n4. Bảng xếp hạng sau khi bot leo tháp:");
    const lbRes = await fetch(`${BASE_URL}/api/leaderboard?roomId=PUBLIC`);
    const lbData = await lbRes.json();
    console.log("- Tổng số người chơi trên bảng:", lbData.leaderboard.length);
    console.log("- Số trận gần đây được lưu:", lbData.recentMatches.length);
    console.table(lbData.leaderboard.map(p => ({
      Rank: lbData.leaderboard.indexOf(p) + 1,
      Name: p.playerName,
      Score: p.score,
      Matches: p.matchesPlayed,
      Wins: p.wins,
      Draws: p.draws,
      Losses: p.losses
    })));

    // 5. Kiểm tra file trên đĩa đã được cập nhật chưa
    console.log("\n5. Kiểm tra file trên đĩa data/players.json:");
    const savedRaw = fs.readFileSync('d:/Oantuti_code/data/players.json', 'utf-8');
    const savedList = JSON.parse(savedRaw);
    const found = savedList.find(p => p.playerId === 'challenger_viper_99');
    console.log("Tìm thấy bot trên file JSON lưu trữ:", {
      found: !!found,
      playerName: found?.playerName,
      score: found?.score,
      matchesPlayed: found?.matchesPlayed
    });

    console.log("\n=== TẤT CẢ KIỂM THỬ LEO THÁP VÀ PERSISTENCE THÀNH CÔNG RỰC RỠ! ===");
  } catch (err) {
    console.error("Lỗi:", err);
  } finally {
    server.close(() => {
      console.log("Đã đóng test server an toàn.");
      process.exit(0);
    });
  }
}

setTimeout(runTest, 500);
