import { executeBotMove, STARTER_CODE_PYTHON, STARTER_CODE_CPP } from './botRunner.js';
import { initBoard, getLegalMoves, PLAYER } from './boardEngine.js';

console.log("=== KIỂM THỬ THỰC THI ĐA NGÔN NGỮ (PYTHON 3 & C++) ===");

const state = initBoard();
const legalMoves = getLegalMoves(state, PLAYER.RED);
const gameState = {
  board: state.grid,
  myColor: PLAYER.RED,
  myFlag: [0, 4],
  enemyFlag: [8, 4],
  legalMoves,
  turn: PLAYER.RED
};

// 1. Kiểm thử Python 3 Bot
console.log("\n1. Test Python 3 Bot:");
const pyResult = executeBotMove({
  code: STARTER_CODE_PYTHON,
  language: 'python'
}, gameState, 1000);

console.log("Python Move Result:", pyResult);
if (pyResult.move && !pyResult.isError) {
  console.log("-> Python Bot chạy thành công xuất sắc!");
} else {
  console.error("-> Python Bot bị lỗi:", pyResult.errorMsg);
}

// 2. Kiểm thử C++ Bot (Nếu không có g++, kiểm tra cơ chế Auto-Fallback)
console.log("\n2. Test C++ Bot (Kiểm tra cơ chế Compile & Auto-fallback):");
const cppResult = executeBotMove({
  code: STARTER_CODE_CPP,
  language: 'cpp'
}, gameState, 1000);

console.log("C++ Move Result:", cppResult);
if (cppResult.move) {
  console.log("-> C++ Bot cơ chế Sandbox & Fallback hoạt động đúng chuẩn!");
  if (cppResult.isError) {
    console.log("   (Ghi nhận lỗi an toàn & cấp fallbackMove:", cppResult.errorMsg?.split('\n')[0], ")");
  }
}

console.log("\n=== TẤT CẢ KIỂM THỬ ĐA NGÔN NGỮ HOÀN TẤT! ===");
