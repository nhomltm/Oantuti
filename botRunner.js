/**
 * botRunner.js
 * 
 * RUNNER VÀ SANDBOX CHO BOT - CHIẾN THUẬT OẰN TÙ TÌ 9X9
 * HỖ TRỢ ĐA NGÔN NGỮ: JAVASCRIPT, PYTHON 3, C++
 * 
 * Chuẩn hóa Interface & Standard I/O Contract:
 * 1. JavaScript:
 *    - Hàm trực tiếp hoặc function body nhận `gameState`, trả về `{ from: [r, c], to: [r, c] }`
 * 2. Python 3:
 *    - Nhận JSON qua stdin `sys.stdin.read()`
 *    - Xuất JSON qua stdout: `{"from": [r, c], "to": [r, c]}`
 * 3. C++:
 *    - Nhận JSON qua stdin `std::cin`
 *    - Biên dịch qua `g++ -O3` (hoặc clang++/cl nếu có)
 *    - Xuất JSON qua stdout: `{"from": [r, c], "to": [r, c]}`
 * 
 * Sandbox An Toàn & Auto-Fallback:
 * - Khi bot gặp lỗi biên dịch, runtime, timeout (500ms) hoặc trả về nước đi không hợp lệ:
 *   -> Tự động bốc fallbackMove = legalMoves[0]
 *   -> Đánh dấu isError = true và ghi nhận errorMsg.
 * - Tự động dọn dẹp (cleanup) file tạm sau khi biên dịch/thực thi.
 */

import { PLAYER, PIECE_TYPE, canCapture } from './boardEngine.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync, execSync } from 'child_process';

const TEMP_DIR = path.join(os.tmpdir(), 'oantuti_bot_sandbox');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Kiểm tra xem 2 tọa độ [r1, c1] và [r2, c2] có trùng nhau không
 */
function isSameCoord(p1, p2) {
  return Array.isArray(p1) && Array.isArray(p2) && p1[0] === p2[0] && p1[1] === p2[1];
}

/**
 * Kiểm tra xem move có khớp với một trong các nước đi trong legalMoves không
 */
function findMatchingMove(move, legalMoves) {
  if (!move || !Array.isArray(move.from) || !Array.isArray(move.to)) return null;
  return legalMoves.find(
    lm => isSameCoord(lm.from, move.from) && isSameCoord(lm.to, move.to)
  ) || null;
}

/**
 * Khoảng cách Chebyshev (bước đi của Vua 8 hướng) giữa 2 ô
 */
function chebyshevDistance(p1, p2) {
  return Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]));
}

/**
 * Hàm hỗ trợ tạo payload `gameState` chuẩn hóa cho Bot từ game engine state
 */
export function formatGameStateForBot(rawEngineState, myColor = rawEngineState.turn) {
  const board = rawEngineState.grid 
    ? rawEngineState.grid.map(row => row.map(cell => (cell ? { ...cell } : null)))
    : rawEngineState.board.map(row => row.map(cell => (cell ? { ...cell } : null)));

  const enemyColor = myColor === PLAYER.RED ? PLAYER.BLUE : PLAYER.RED;

  const myFlag = rawEngineState.flags 
    ? [...rawEngineState.flags[myColor]] 
    : (myColor === PLAYER.RED ? [0, 4] : [8, 4]);

  const enemyFlag = rawEngineState.flags 
    ? [...rawEngineState.flags[enemyColor]] 
    : (myColor === PLAYER.RED ? [8, 4] : [0, 4]);

  const legalMoves = rawEngineState.legalMoves 
    ? rawEngineState.legalMoves.map(m => ({ from: [...m.from], to: [...m.to] }))
    : [];

  return {
    board,
    myColor,
    myFlag,
    enemyFlag,
    legalMoves,
    turn: rawEngineState.turn || myColor
  };
}

// ============================================================================
// TEMPLATE MÃ NGUỒN MẪU KHỞI TẠO (STARTER CODE TEMPLATES)
// ============================================================================

export const STARTER_CODE_JS = `/**
 * Bot Chiến Thuật Oẳn Tù Tì 9x9 (JavaScript)
 * @param {Object} gameState: { board, myColor, myFlag, enemyFlag, legalMoves, turn }
 * @returns {Object} { from: [r, c], to: [r, c] }
 */
function makeMove(gameState) {
  const { board, legalMoves, enemyFlag } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  // 1. Nếu có nước đi trực tiếp vào ô cờ đối thủ -> Đi ngay để thắng!
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (m.to[0] === enemyFlag[0] && m.to[1] === enemyFlag[1]) {
      return m;
    }
  }

  // 2. Ưu tiên ăn quân đối phương nếu có
  const captureMoves = legalMoves.filter(m => board[m.to[0]][m.to[1]] !== null);
  if (captureMoves.length > 0) {
    return captureMoves[0];
  }

  // 3. Mặc định đi nước đầu tiên hoặc ngẫu nhiên
  return legalMoves[0];
}

return makeMove(gameState);
`.trim();

export const STARTER_CODE_PYTHON = `import sys
import json

def make_move(game_state):
    board = game_state.get("board", [])
    legal_moves = game_state.get("legalMoves", [])
    enemy_flag = game_state.get("enemyFlag", [0, 4])
    
    if not legal_moves:
        return None

    # 1. Chiếm cờ đối phương nếu có thể
    for move in legal_moves:
        if move["to"] == enemy_flag:
            return move

    # 2. Ưu tiên ăn quân đối phương
    for move in legal_moves:
        to_r, to_c = move["to"]
        if board[to_r][to_c] is not None:
            return move

    # 3. Mặc định chọn nước đi hợp lệ đầu tiên
    return legal_moves[0]

def main():
    try:
        raw_input = sys.stdin.read().strip()
        if not raw_input:
            return
        game_state = json.loads(raw_input)
        best_move = make_move(game_state)
        if best_move:
            print(json.dumps(best_move))
    except Exception as e:
        sys.stderr.write(f"Error: {e}\\n")

if __name__ == "__main__":
    main()
`.trim();

export const STARTER_CODE_CPP = `#include <iostream>
#include <string>
#include <vector>
#include <sstream>

// Standard I/O Contract: Nhận chuỗi JSON từ cin, xuất JSON ra cout
int main() {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(NULL);

    std::string input;
    std::string line;
    while (std::getline(std::cin, line)) {
        input += line;
    }

    if (input.empty()) return 0;

    // Tìm kiếm nước đi đầu tiên trong mảng "legalMoves"
    // Cấu trúc: "legalMoves":[{"from":[r,c],"to":[r,c]}, ...]
    size_t movesPos = input.find("\"legalMoves\"");
    if (movesPos != std::string::npos) {
        size_t fromPos = input.find("\"from\"", movesPos);
        size_t toPos = input.find("\"to\"", fromPos);
        if (fromPos != std::string::npos && toPos != std::string::npos) {
            size_t openBracketFrom = input.find('[', fromPos);
            size_t closeBracketFrom = input.find(']', openBracketFrom);
            size_t openBracketTo = input.find('[', toPos);
            size_t closeBracketTo = input.find(']', openBracketTo);

            std::string fromCoord = input.substr(openBracketFrom, closeBracketFrom - openBracketFrom + 1);
            std::string toCoord = input.substr(openBracketTo, closeBracketTo - openBracketTo + 1);

            // Xuất ra stdout định dạng chuẩn JSON
            std::cout << "{\\"from\\":" << fromCoord << ",\\"to\\":" << toCoord << "}" << std::endl;
            return 0;
        }
    }

    std::cout << "{\\"from\\":[0,0],\\"to\\":[0,0]}" << std::endl;
    return 0;
}
`.trim();

// 3 Bot Mẫu JS có sẵn
export const RANDOM_BOT_CODE = `
function bot(gameState) {
  const moves = gameState.legalMoves;
  if (!moves || moves.length === 0) return null;
  const idx = Math.floor(Math.random() * moves.length);
  return moves[idx];
}
return bot(gameState);
`.trim();

export const HUNTER_BOT_CODE = `
function bot(gameState) {
  const { board, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  const captureMoves = [];
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    const target = board[m.to[0]][m.to[1]];
    if (target) {
      captureMoves.push(m);
    }
  }

  if (captureMoves.length > 0) {
    const idx = Math.floor(Math.random() * captureMoves.length);
    return captureMoves[idx];
  }

  const randIdx = Math.floor(Math.random() * legalMoves.length);
  return legalMoves[randIdx];
}
return bot(gameState);
`.trim();

export const GUARDIAN_AND_STRIKER_BOT_CODE = `
function bot(gameState) {
  const { board, myColor, myFlag, enemyFlag, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  function dist(p1, p2) {
    return Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]));
  }

  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (m.to[0] === enemyFlag[0] && m.to[1] === enemyFlag[1]) {
      return m;
    }
  }

  let primaryThreat = null;
  let minThreatDist = 999;
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      const cell = board[r][c];
      if (cell && cell.owner !== myColor) {
        const d = dist([r, c], myFlag);
        if (d <= 2 && d < minThreatDist) {
          minThreatDist = d;
          primaryThreat = [r, c];
        }
      }
    }
  }

  if (primaryThreat) {
    for (let i = 0; i < legalMoves.length; i++) {
      const m = legalMoves[i];
      if (m.to[0] === primaryThreat[0] && m.to[1] === primaryThreat[1]) {
        return m;
      }
    }
  }

  const captureMoves = [];
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (board[m.to[0]][m.to[1]]) {
      captureMoves.push(m);
    }
  }
  if (captureMoves.length > 0) {
    captureMoves.sort((a, b) => dist(a.to, enemyFlag) - dist(b.to, enemyFlag));
    return captureMoves[0];
  }

  let bestMove = legalMoves[0];
  let minEnemyFlagDist = 999;
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    const d = dist(m.to, enemyFlag);
    if (d < minEnemyFlagDist) {
      minEnemyFlagDist = d;
      bestMove = m;
    }
  }

  return bestMove;
}
return bot(gameState);
`.trim();

export const RUSHER_BOT_CODE = `
function bot(gameState) {
  const { board, enemyFlag, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  function dist(p1, p2) {
    return Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]));
  }

  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (m.to[0] === enemyFlag[0] && m.to[1] === enemyFlag[1]) {
      return m;
    }
  }

  const captureMoves = [];
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (board[m.to[0]][m.to[1]]) {
      captureMoves.push(m);
    }
  }
  if (captureMoves.length > 0) {
    captureMoves.sort((a, b) => dist(a.to, enemyFlag) - dist(b.to, enemyFlag));
    return captureMoves[0];
  }

  let bestMove = legalMoves[0];
  let minEnemyDist = 999;
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    const d = dist(m.to, enemyFlag);
    if (d < minEnemyDist) {
      minEnemyDist = d;
      bestMove = m;
    }
  }

  return bestMove;
}
return bot(gameState);
`.trim();

// Tên bí danh để tương thích hoàn toàn
export const STRIKER_BOT_CODE = GUARDIAN_AND_STRIKER_BOT_CODE;
export const RandomBot = RANDOM_BOT_CODE;
export const HunterBot = HUNTER_BOT_CODE;
export const GuardianAndStrikerBot = GUARDIAN_AND_STRIKER_BOT_CODE;
export const RusherBot = RUSHER_BOT_CODE;

/**
 * 100% DANH SÁCH BOT MẪU CÓ SẴN (Người chơi giả / Sample Bots trong file hệ thống)
 * Export rõ ràng đối tượng chứa mã nguồn để UI và Server đọc trực tiếp.
 */
export const SAMPLE_BOTS_MAP = {
  random: {
    key: 'random',
    name: '[Sample] Random Bot',
    author: 'System Rookie',
    code: RANDOM_BOT_CODE,
    description: 'Đi ngẫu nhiên 1 nước hợp lệ bất kỳ'
  },
  hunter: {
    key: 'hunter',
    name: '[Sample] Hunter Bot',
    author: 'System Hunter',
    code: HUNTER_BOT_CODE,
    description: 'Ưu tiên săn và ăn quân đối phương theo luật Oẳn Tù Tì'
  },
  striker: {
    key: 'striker',
    name: '[Sample] Striker Bot',
    author: 'System Guardian',
    code: GUARDIAN_AND_STRIKER_BOT_CODE,
    description: 'Ưu tiên chiếm cờ đối thủ và bảo vệ cờ phe mình'
  },
  guardian: {
    key: 'guardian',
    name: '[Sample] Guardian Bot',
    author: 'System Guardian',
    code: GUARDIAN_AND_STRIKER_BOT_CODE,
    description: 'Vừa công vừa thủ toàn diện'
  },
  rusher: {
    key: 'rusher',
    name: '[Sample] Rusher Bot',
    author: 'System Master',
    code: RUSHER_BOT_CODE,
    description: 'Tấn công dồn dập thẳng vào ô cờ đối phương'
  }
};

// ============================================================================
// TẦNG THỰC THI TIẾN TRÌNH CON ĐA NGÔN NGỮ (EXTERNAL RUNNER)
// ============================================================================

/**
 * Thực thi bot viết bằng Python 3
 */
function executePythonBot(code, gameState, timeoutMs = 500) {
  const botId = `bot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const filePath = path.join(TEMP_DIR, `${botId}.py`);

  try {
    fs.writeFileSync(filePath, code, 'utf-8');
    const inputJson = JSON.stringify(gameState);

    // Chạy python với stdin và timeout
    const result = spawnSync('python', [filePath], {
      input: inputJson,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });

    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') {
        throw new Error(`Python execution timed out after ${timeoutMs}ms`);
      }
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(`Python error (Exit code ${result.status}): ${result.stderr || 'Unknown'}`);
    }

    const stdout = (result.stdout || '').trim();
    if (!stdout) {
      throw new Error('Python bot did not output any move to stdout');
    }

    return JSON.parse(stdout);
  } finally {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

/**
 * Thực thi bot viết bằng C++
 */
function executeCppBot(code, gameState, timeoutMs = 500) {
  const botId = `bot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const srcPath = path.join(TEMP_DIR, `${botId}.cpp`);
  const binExt = process.platform === 'win32' ? '.exe' : '';
  const binPath = path.join(TEMP_DIR, `${botId}${binExt}`);

  try {
    fs.writeFileSync(srcPath, code, 'utf-8');

    // 1. Biên dịch C++
    try {
      execSync(`g++ -O3 "${srcPath}" -o "${binPath}"`, {
        timeout: 8000,
        stdio: 'pipe'
      });
    } catch (compileErr) {
      const errDetail = compileErr.stderr ? compileErr.stderr.toString() : compileErr.message;
      throw new Error(`C++ Compile Error:\n${errDetail}`);
    }

    // 2. Chạy binary
    const inputJson = JSON.stringify(gameState);
    const runResult = spawnSync(binPath, [], {
      input: inputJson,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });

    if (runResult.error) {
      if (runResult.error.code === 'ETIMEDOUT') {
        throw new Error(`C++ execution timed out after ${timeoutMs}ms`);
      }
      throw runResult.error;
    }

    if (runResult.status !== 0) {
      throw new Error(`C++ runtime error (Exit code ${runResult.status}): ${runResult.stderr || 'Unknown'}`);
    }

    const stdout = (runResult.stdout || '').trim();
    if (!stdout) {
      throw new Error('C++ bot did not output any move to stdout');
    }

    return JSON.parse(stdout);
  } finally {
    try {
      if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
      if (fs.existsSync(binPath)) fs.unlinkSync(binPath);
    } catch (_) {}
  }
}

// ============================================================================
// HÀM AN TOÀN EXECUTE BOT MOVE (TỔNG HỢP JS / PYTHON / C++)
// ============================================================================

/**
 * Thực thi mã nguồn bot an toàn với Sandbox, Timeout và Cơ chế Auto-Fallback
 * 
 * @param {string|Function|Object} botConfig - Code string, function, hoặc object { code, language }
 * @param {Object} gameState - State chuẩn: { board, myColor, myFlag, enemyFlag, legalMoves, turn }
 * @param {number} timeoutMs - Giới hạn thời gian chạy bot (mặc định 500ms)
 * @returns {{ move: Object|null, isError: boolean, errorMsg: string|null, executionTimeMs: number }}
 */
export function executeBotMove(botConfig, gameState, timeoutMs = 500) {
  const startTime = Date.now();
  const legalMoves = gameState?.legalMoves || [];

  if (!legalMoves || legalMoves.length === 0) {
    return {
      move: null,
      isError: false,
      errorMsg: null,
      executionTimeMs: 0
    };
  }

  // Nước đi fallback dự phòng (bốc ngẫu nhiên hoặc legalMoves[0])
  const fallbackMove = legalMoves[Math.floor(Math.random() * legalMoves.length)] || legalMoves[0];

  try {
    let returnedMove = null;
    let language = 'javascript';
    let code = botConfig;

    if (typeof botConfig === 'object' && botConfig !== null) {
      language = (botConfig.language || 'javascript').toLowerCase();
      code = botConfig.code || botConfig.botCode || '';
    }

    // 1. Phân nhánh ngôn ngữ Python 3
    if (language === 'python' || language === 'python3' || language === 'py') {
      returnedMove = executePythonBot(code, gameState, timeoutMs);
    }
    // 2. Phân nhánh ngôn ngữ C++
    else if (language === 'cpp' || language === 'c++') {
      returnedMove = executeCppBot(code, gameState, timeoutMs);
    }
    // 3. Phân nhánh JavaScript (Mặc định)
    else {
      if (typeof code === 'function') {
        returnedMove = code(gameState);
      } else if (typeof code === 'string') {
        const wrappedBody = `
          "use strict";
          const startTime = Date.now();
          const timeoutMs = ${Number(timeoutMs) || 500};
          
          const run = function() {
            ${code}
          };

          const result = run();
          if (Date.now() - startTime > timeoutMs) {
            throw new Error("Bot execution exceeded timeout of " + timeoutMs + "ms");
          }
          return result;
        `;
        const botExecutor = new Function('gameState', wrappedBody);
        returnedMove = botExecutor(gameState);
      } else {
        throw new Error(`Invalid bot input type for JavaScript: ${typeof code}`);
      }
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error(`Bot execution timed out (${elapsed}ms > ${timeoutMs}ms)`);
    }

    // Kiểm tra tính hợp lệ của move trả về
    const validMove = findMatchingMove(returnedMove, legalMoves);
    if (!validMove) {
      throw new Error(
        `Bot returned illegal move: ${JSON.stringify(returnedMove)}. Must match one of legalMoves.`
      );
    }

    return {
      move: validMove,
      isError: false,
      errorMsg: null,
      executionTimeMs: elapsed
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    // Cơ chế AUTO-FALLBACK: Tự động trả về fallbackMove hợp lệ
    return {
      move: fallbackMove,
      isError: true,
      errorMsg: error?.message || 'Unknown bot execution error',
      executionTimeMs: elapsed
    };
  }
}

export default {
  formatGameStateForBot,
  executeBotMove,
  STARTER_CODE_JS,
  STARTER_CODE_PYTHON,
  STARTER_CODE_CPP,
  RANDOM_BOT_CODE,
  HUNTER_BOT_CODE,
  GUARDIAN_AND_STRIKER_BOT_CODE,
  RUSHER_BOT_CODE
};
