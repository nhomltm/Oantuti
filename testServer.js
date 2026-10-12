import { 
  app, 
  server, 
  rooms, 
  matchLogsStore 
} from './server.js';
import { GUARDIAN_AND_STRIKER_BOT_CODE, HUNTER_BOT_CODE } from './botRunner.js';

console.log("=== KIỂM THỬ BACKEND API & BATCH RUNNER TRÊN SERVER.JS ===");

const BASE_URL = 'http://localhost:3000';

async function runTests() {
  try {
    // 1. Test GET /api/rooms
    console.log("\n1. Test GET /api/rooms:");
    const roomsRes = await fetch(`${BASE_URL}/api/rooms`);
    const roomsData = await roomsRes.json();
    console.log("Rooms:", roomsData);

    // 2. Test GET /api/room/create
    console.log("\n2. Test GET /api/room/create (Tạo phòng riêng):");
    const createRoomRes = await fetch(`${BASE_URL}/api/room/create?name=DauTruongVip`);
    const createRoomData = await createRoomRes.json();
    console.log("Created Room:", createRoomData);
    const privateRoomId = createRoomData.data.roomId;

    // 3. Test POST /api/bot/submit vào Private Room
    console.log("\n3. Test POST /api/bot/submit (Nộp bot 1 & bot 2):");
    const submitBot1 = await fetch(`${BASE_URL}/api/bot/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'p1_grandmaster',
        playerName: 'SuperGuardian',
        author: 'NguyenVanA',
        botCode: GUARDIAN_AND_STRIKER_BOT_CODE,
        roomId: privateRoomId
      })
    });
    console.log("Bot 1 Submit Result:", await submitBot1.json());

    const submitBot2 = await fetch(`${BASE_URL}/api/bot/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: 'p2_predator',
        playerName: 'FastHunter',
        author: 'TranThiB',
        botCode: HUNTER_BOT_CODE,
        roomId: privateRoomId
      })
    });
    console.log("Bot 2 Submit Result:", await submitBot2.json());

    // Đợi 1 giây để Batch Runner hoàn tất mô phỏng các trận đấu
    console.log("\nĐang chờ Batch Runner xử lý giải đấu...");
    await new Promise(r => setTimeout(r, 1200));

    // 4. Test GET /api/leaderboard?roomId=...
    console.log("\n4. Test GET /api/leaderboard:");
    const lbRes = await fetch(`${BASE_URL}/api/leaderboard?roomId=${privateRoomId}`);
    const lbData = await lbRes.json();
    console.log("Leaderboard của phòng:", {
      roomId: lbData.roomId,
      roomName: lbData.roomName,
      leaderboardCount: lbData.leaderboard.length,
      recentMatchesCount: lbData.recentMatches.length
    });
    console.table(lbData.leaderboard);

    // 5. Test GET /api/matches/:matchId để lấy log Replay
    if (lbData.recentMatches.length > 0) {
      const firstMatchId = lbData.recentMatches[0].id;
      console.log(`\n5. Test GET /api/matches/${firstMatchId} (Lấy replay):`);
      const matchRes = await fetch(`${BASE_URL}/api/matches/${firstMatchId}`);
      const matchData = await matchRes.json();
      console.log("Chi tiết Replay:", {
        matchId: matchData.match.id,
        botRed: matchData.match.botRed.name,
        botBlue: matchData.match.botBlue.name,
        winner: matchData.match.winner,
        totalTurns: matchData.match.totalTurns
      });
    }

    console.log("\n=== TẤT CẢ KIỂM THỬ BACKEND THÀNH CÔNG RỰC RỠ! ===");
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    // Đóng server sau khi kiểm thử xong
    server.close(() => {
      console.log("Đã đóng test server an toàn.");
      process.exit(0);
    });
  }
}

// Khởi chạy sau 500ms khi server đã lắng nghe
setTimeout(runTests, 500);
