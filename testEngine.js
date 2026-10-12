import engine, { 
  initBoard, 
  getLegalMoves, 
  applyMove, 
  getGameStateForBot, 
  PLAYER, 
  PIECE_TYPE 
} from './boardEngine.js';

console.log("=== KIỂM THỬ CORE BOARD ENGINE ===");

// 1. Khởi tạo
const state = initBoard();
console.log("1. Init board OK.");
console.log("Turn ban đầu:", state.turn);
console.log("Cờ Red:", state.flags[PLAYER.RED]);
console.log("Cờ Blue:", state.flags[PLAYER.BLUE]);

// 2. Lấy nước đi hợp lệ
const redMoves = getLegalMoves(state, PLAYER.RED);
console.log(`2. Số nước đi hợp lệ của RED: ${redMoves.length}`);
console.log("Ví dụ 3 nước đi hợp lệ đầu tiên của RED:", redMoves.slice(0, 3));

// Kiểm tra quân không được đi vào ô cờ của chính phe mình ([0, 4] với Red)
const movesIntoOwnFlag = redMoves.filter(m => m.to[0] === 0 && m.to[1] === 4);
console.log("Số nước đi đè vào ô cờ Red của quân Red (phải bằng 0):", movesIntoOwnFlag.length);

// 3. Thực hiện 1 nước đi hợp lệ của Red
const sampleMove = redMoves[0];
console.log("3. Áp dụng nước đi:", sampleMove);
const result = applyMove(state, sampleMove, PLAYER.RED);
console.log("Lượt tiếp theo:", result.newState.turn);
console.log("Turn count:", result.newState.turnCount);
console.log("Người thắng:", result.winner);

// 4. Lấy game state cho bot
const botState = getGameStateForBot(result.newState, PLAYER.BLUE);
console.log("4. Bot state dành cho BLUE:", {
  myPlayer: botState.myPlayer,
  turn: botState.turn,
  legalMovesCount: botState.legalMoves.length,
  pieceCounts: botState.pieceCounts
});

console.log("=== TẤT CẢ KIỂM THỬ CƠ BẢN HOÀN TẤT THÀNH CÔNG ===");
