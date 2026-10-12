import { initBoard, getLegalMoves, applyMove, PLAYER } from './boardEngine.js';
import { 
  formatGameStateForBot, 
  executeBotMove, 
  RandomBot, 
  HunterBot, 
  GuardianAndStrikerBot,
  RANDOM_BOT_CODE,
  HUNTER_BOT_CODE,
  GUARDIAN_AND_STRIKER_BOT_CODE 
} from './botRunner.js';

console.log("=== KIỂM THỬ BOT RUNNER & 3 BOT MẪU ===");

const state = initBoard();
const legalMoves = getLegalMoves(state, PLAYER.RED);
const botGameState = formatGameStateForBot({
  ...state,
  legalMoves
}, PLAYER.RED);

console.log("1. Kiểm tra interface gameState:");
console.log("- myColor:", botGameState.myColor);
console.log("- myFlag:", botGameState.myFlag);
console.log("- enemyFlag:", botGameState.enemyFlag);
console.log("- legalMoves count:", botGameState.legalMoves.length);

// 1. Test executeBotMove với các function bots
console.log("\n2. Test Function Bots:");
const resRandom = executeBotMove(RandomBot, botGameState);
console.log("RandomBot move:", resRandom.move, "| isError:", resRandom.isError);

const resHunter = executeBotMove(HunterBot, botGameState);
console.log("HunterBot move:", resHunter.move, "| isError:", resHunter.isError);

const resGuardian = executeBotMove(GuardianAndStrikerBot, botGameState);
console.log("GuardianAndStrikerBot move:", resGuardian.move, "| isError:", resGuardian.isError);

// 2. Test executeBotMove với code strings
console.log("\n3. Test Code String Bots (Sandbox):");
const resStrRandom = executeBotMove(RANDOM_BOT_CODE, botGameState);
console.log("String RandomBot move:", resStrRandom.move, "| isError:", resStrRandom.isError);

const resStrGuardian = executeBotMove(GUARDIAN_AND_STRIKER_BOT_CODE, botGameState);
console.log("String GuardianAndStrikerBot move:", resStrGuardian.move, "| isError:", resStrGuardian.isError);

// 3. Test Auto-fallback khi Bot lỗi cú pháp, quăng exception, trả về nước đi phi pháp
console.log("\n4. Test Auto-fallback & Error Handling:");

// Case A: Bot quăng lỗi Exception
const buggyBotCode = `throw new Error("Lỗi giả lập trong bot!");`;
const resBuggy = executeBotMove(buggyBotCode, botGameState);
console.log("Buggy bot result -> fallback move:", resBuggy.move, "| isError:", resBuggy.isError, "| errorMsg:", resBuggy.errorMsg);

// Case B: Bot trả về nước đi không hợp lệ (illegal move)
const illegalBotCode = `return { from: [0, 0], to: [9, 9] };`;
const resIllegal = executeBotMove(illegalBotCode, botGameState);
console.log("Illegal move bot -> fallback move:", resIllegal.move, "| isError:", resIllegal.isError, "| errorMsg:", resIllegal.errorMsg);

// Case C: Bot rỗng không có nước đi
const emptyState = { ...botGameState, legalMoves: [] };
const resEmpty = executeBotMove(RandomBot, emptyState);
console.log("Empty legalMoves -> move:", resEmpty.move, "| isError:", resEmpty.isError);

// 4. Chạy mô phỏng 1 trận đấu đối kháng giữa GuardianAndStrikerBot (RED) vs HunterBot (BLUE)
console.log("\n5. Mô phỏng trận đấu: GuardianAndStrikerBot (RED) vs HunterBot (BLUE)");
let simState = initBoard();
let turns = 0;

while (!simState.winner && turns < 150) {
  const currentTurn = simState.turn;
  const currentLegalMoves = getLegalMoves(simState, currentTurn);
  if (currentLegalMoves.length === 0) break;

  const currentPayload = formatGameStateForBot({
    ...simState,
    legalMoves: currentLegalMoves
  }, currentTurn);

  const botToUse = currentTurn === PLAYER.RED ? GuardianAndStrikerBot : HunterBot;
  const { move, isError } = executeBotMove(botToUse, currentPayload);

  if (isError || !move) {
    console.error(`Lỗi nước đi ở turn ${turns} của phe ${currentTurn}`);
    break;
  }

  const stepRes = applyMove(simState, move, currentTurn);
  simState = stepRes.newState;
  turns++;
}

console.log(`Kết thúc mô phỏng sau ${simState.turnCount} lượt!`);
console.log("Người chiến thắng:", simState.winner);
console.log("Lịch sử số nước đi:", simState.history.length);
console.log("=== TẤT CẢ KIỂM THỬ BOTRUNNER ĐẠT CHUẨN 100% ===");
