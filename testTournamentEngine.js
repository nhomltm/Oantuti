import { 
  playMatch, 
  runTournament, 
  PrivateRoom, 
  PublicArena 
} from './tournamentEngine.js';
import { 
  RandomBot, 
  HunterBot, 
  GuardianAndStrikerBot,
  RANDOM_BOT_CODE,
  HUNTER_BOT_CODE,
  GUARDIAN_AND_STRIKER_BOT_CODE
} from './botRunner.js';

console.log("=== KIỂM THỬ TOURNAMENT ENGINE ===");

// 1. Kiểm thử playMatch (1 trận)
console.log("\n1. Test playMatch giữa Guardian (RED) vs Hunter (BLUE):");
const singleMatch = playMatch(
  { id: 'bot_guardian', name: 'Guardian Bot', code: GuardianAndStrikerBot },
  { id: 'bot_hunter', name: 'Hunter Bot', code: HunterBot }
);
console.log(`- Trận đấu: ${singleMatch.botRed.name} vs ${singleMatch.botBlue.name}`);
console.log(`- Người thắng: ${singleMatch.winner} (Bot ID: ${singleMatch.winnerBotId})`);
console.log(`- Tổng số turn: ${singleMatch.totalTurns}`);
console.log(`- Lỗi của Red: ${singleMatch.botRed.errors}, Blue: ${singleMatch.botBlue.errors}`);

// 2. Kiểm thử runTournament (Vòng tròn 4 bots)
console.log("\n2. Test runTournament (Double Round-Robin 4 Bots):");
const sampleBots = [
  { id: 'b_guardian_fn', name: 'Guardian_Fn', author: 'Team Alpha', code: GuardianAndStrikerBot },
  { id: 'b_hunter_fn', name: 'Hunter_Fn', author: 'Team Beta', code: HunterBot },
  { id: 'b_random_fn', name: 'Random_Fn', author: 'Team Gamma', code: RandomBot },
  { id: 'b_guardian_str', name: 'Guardian_Str', author: 'Team Delta', code: GUARDIAN_AND_STRIKER_BOT_CODE }
];

const tourResult = runTournament(sampleBots);
console.log(`- Tổng số trận đã đấu: ${tourResult.summary.totalMatches}`);
console.log("- BẢNG XẾP HẠNG (LEADERBOARD):");
console.table(tourResult.leaderboard);

// 3. Kiểm thử PrivateRoom
console.log("\n3. Test PrivateRoom:");
const room = new PrivateRoom("VIP_ROOM_888", { name: "Đại Chiến Anh Hào" });
room.addBot({ id: 'p1', name: 'P1_Guardian', code: GuardianAndStrikerBot });
room.addBot({ id: 'p2', name: 'P2_Hunter', code: HunterBot });
room.addBot({ id: 'p3', name: 'P3_Random', code: RandomBot });

console.log("Thông tin phòng trước khi đấu:", room.getInfo());
const roomResult = room.startTournament();
console.log("Phòng đã đấu xong! Trạng thái phòng:", room.getInfo().status);
console.log("Top 1 phòng:", roomResult.leaderboard[0]);

// 4. Kiểm thử PublicArena
console.log("\n4. Test PublicArena:");
const arena = new PublicArena({ name: "Kaggle-like Global Arena" });
arena.submitBot({ id: 'pub_g1', name: 'Master_Guardian', author: 'Grandmaster', code: GuardianAndStrikerBot });
arena.submitBot({ id: 'pub_h1', name: 'Vicious_Hunter', author: 'Player99', code: HunterBot });
arena.submitBot({ id: 'pub_r1', name: 'Lucky_Random', author: 'Beginner', code: RandomBot });

const season = arena.runSeason();
console.log(`Mùa giải hoàn tất: ${season.totalMatches} trận.`);
console.log("Global Leaderboard:");
console.table(arena.getLeaderboard());

// Thử lấy replay 1 trận đấu
const firstMatchId = arena.matchHistory[0].id;
const replay = arena.getMatchReplay(firstMatchId);
console.log(`Lấy Replay trận ${firstMatchId} thành công, số bước cờ:`, replay.turns.length);

console.log("\n=== TẤT CẢ KIỂM THỬ TOURNAMENT ENGINE HOÀN TẤT THÀNH CÔNG! ===");
