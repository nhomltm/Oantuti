/**
 * botRunner.js
 * 
 * RUNNER VÀ SANDBOX CHO BOT - CHIẾN THUẬT OẰN TÙ TÌ 9X9
 * 
 * Chuẩn hóa Interface:
 * 1. Bot input `gameState`:
 *    - board: Ma trận 9x9 (mỗi ô là null hoặc { owner: 'RED'|'BLUE', type: 'R'|'P'|'S' })
 *    - myColor: 'RED' hoặc 'BLUE'
 *    - myFlag: [r, c] (tọa độ cờ của phe mình: [0, 4] cho RED, [8, 4] cho BLUE)
 *    - enemyFlag: [r, c] (tọa độ cờ đối phương: [8, 4] cho RED, [0, 4] cho BLUE)
 *    - legalMoves: Danh sách [{ from: [r, c], to: [r, c] }]
 *    - turn: 'RED' hoặc 'BLUE'
 * 
 * 2. Bot return:
 *    - { from: [r, c], to: [r, c] }
 * 
 * 3. An toàn sandbox & Auto-fallback:
 *    - executeBotMove(botCodeString, gameState, timeoutMs = 200)
 *    - Cơ chế fallback tự động về legalMoves[0] khi gặp lỗi cú pháp, runtime, timeout, hoặc trả về move bất hợp lệ.
 */

import { PLAYER, PIECE_TYPE, canCapture } from './boardEngine.js';

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
 * @param {Object} rawEngineState (State từ boardEngine hoặc getGameStateForBot)
 * @param {string} myColor ('RED' | 'BLUE')
 * @returns {Object} Chuẩn interface: { board, myColor, myFlag, enemyFlag, legalMoves, turn }
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
// 3 BOT MẪU CHUẨN (BUILT-IN BOTS)
// ============================================================================

/**
 * Bot 1: RandomBot
 * Đi ngẫu nhiên một nước đi hợp lệ bất kỳ trong legalMoves
 */
export function RandomBot(gameState) {
  const { legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;
  const randomIndex = Math.floor(Math.random() * legalMoves.length);
  return legalMoves[randomIndex];
}

export const RANDOM_BOT_CODE = `
function bot(gameState) {
  const moves = gameState.legalMoves;
  if (!moves || moves.length === 0) return null;
  const idx = Math.floor(Math.random() * moves.length);
  return moves[idx];
}
return bot(gameState);
`.trim();

/**
 * Bot 2: HunterBot (Bot săn mồi)
 * Ưu tiên các nước đi ăn quân đối phương theo luật tương khắc Oẳn Tù Tì.
 * Nếu có nhiều nước ăn quân -> chọn ngẫu nhiên 1 trong số đó.
 * Nếu không có nước ăn quân nào -> đi ngẫu nhiên 1 nước trong legalMoves.
 */
export function HunterBot(gameState) {
  const { board, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  const captureMoves = [];

  for (const move of legalMoves) {
    const targetCell = board[move.to[0]][move.to[1]];
    // Nếu ô đích có quân (nghĩa là quân đối phương bị ăn)
    if (targetCell) {
      captureMoves.push(move);
    }
  }

  if (captureMoves.length > 0) {
    const idx = Math.floor(Math.random() * captureMoves.length);
    return captureMoves[idx];
  }

  // Không có nước ăn quân -> đi ngẫu nhiên
  const randIdx = Math.floor(Math.random() * legalMoves.length);
  return legalMoves[randIdx];
}

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

/**
 * Bot 3: GuardianAndStrikerBot (Bot chiến thuật: Vừa công vừa thủ)
 * 1. CHIẾM CỜ: Nếu có nước đi trực tiếp vào ô cờ đối phương enemyFlag -> Đi ngay lập tức để kết thúc trận đấu.
 * 2. THỦ CỜ: Kiểm tra nếu có quân đối phương áp sát myFlag trong phạm vi 1-2 ô:
 *    - Ưu tiên 2.1: Ăn trực tiếp quân đe dọa đó bằng nước cờ hợp lệ.
 *    - Ưu tiên 2.2: Di chuyển quân về chắn hoặc tiếp cận quân đe dọa / bảo vệ cờ (giảm khoảng cách tới cờ phe mình).
 * 3. SĂN MỒI: Nếu không bị đe dọa khẩn cấp, nếu có nước ăn quân đối phương -> thực hiện ăn quân.
 * 4. TẤN CÔNG / ÁP SÁT: Nếu không, chọn nước đi đưa quân tiến gần nhất về phía ô cờ đối thủ enemyFlag.
 */
export function GuardianAndStrikerBot(gameState) {
  const { board, myColor, myFlag, enemyFlag, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  // 1. CHIẾM CỜ (Tối thượng)
  const winningMove = legalMoves.find(
    m => m.to[0] === enemyFlag[0] && m.to[1] === enemyFlag[1]
  );
  if (winningMove) {
    return winningMove;
  }

  // Tìm các quân đối phương và đánh giá độ nguy hiểm với myFlag
  const enemyThreats = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      const cell = board[r][c];
      if (cell && cell.owner !== myColor) {
        const distToMyFlag = chebyshevDistance([r, c], myFlag);
        if (distToMyFlag <= 2) {
          enemyThreats.push({ pos: [r, c], dist: distToMyFlag, type: cell.type });
        }
      }
    }
  }

  // 2. PHÒNG THỦ CỜ (Nếu có kẻ địch trong phạm vi <= 2 ô so với cờ)
  if (enemyThreats.length > 0) {
    // Sắp xếp kẻ địch gần cờ nhất lên đầu
    enemyThreats.sort((a, b) => a.dist - b.dist);
    const primaryThreat = enemyThreats[0];

    // 2.1 Tiêu diệt trực tiếp kẻ đe dọa
    const captureThreatMove = legalMoves.find(
      m => m.to[0] === primaryThreat.pos[0] && m.to[1] === primaryThreat.pos[1]
    );
    if (captureThreatMove) {
      return captureThreatMove;
    }

    // 2.2 Di chuyển quân bọc lót về gần cờ hoặc áp sát kẻ đe dọa
    const defensiveMoves = legalMoves.map(m => {
      const distToThreat = chebyshevDistance(m.to, primaryThreat.pos);
      const distToFlag = chebyshevDistance(m.to, myFlag);
      return { move: m, score: -(distToThreat * 2 + distToFlag) };
    });

    defensiveMoves.sort((a, b) => b.score - a.score);
    if (defensiveMoves.length > 0 && defensiveMoves[0].score > -10) {
      return defensiveMoves[0].move;
    }
  }

  // 3. SĂN MỒI (Nếu an toàn thì ưu tiên ăn quân)
  const captureMoves = legalMoves.filter(m => board[m.to[0]][m.to[1]] !== null);
  if (captureMoves.length > 0) {
    // Ưu tiên ăn quân có vị trí gần cờ đối thủ hơn để vừa ăn vừa tiến lên
    captureMoves.sort((a, b) => {
      const distA = chebyshevDistance(a.to, enemyFlag);
      const distB = chebyshevDistance(b.to, enemyFlag);
      return distA - distB;
    });
    return captureMoves[0];
  }

  // 4. TIẾN CÔNG VỀ PHÍA CỜ ĐỐI THỦ
  // Chọn nước đi giúp giảm khoảng cách tới enemyFlag nhiều nhất
  let bestMove = legalMoves[0];
  let minDistance = Infinity;

  for (const move of legalMoves) {
    const dist = chebyshevDistance(move.to, enemyFlag);
    // Ưu tiên khoảng cách nhỏ hơn, nếu bằng nhau thì thêm chút ngẫu nhiên để linh hoạt
    if (dist < minDistance) {
      minDistance = dist;
      bestMove = move;
    }
  }

  return bestMove;
}

export const GUARDIAN_AND_STRIKER_BOT_CODE = `
function bot(gameState) {
  const { board, myColor, myFlag, enemyFlag, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  function dist(p1, p2) {
    return Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]));
  }

  // 1. Chiếm cờ
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (m.to[0] === enemyFlag[0] && m.to[1] === enemyFlag[1]) {
      return m;
    }
  }

  // 2. Quét mối đe dọa gần cờ phe mình (khoảng cách <= 2)
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

  // Nếu bị uy hiếp, tìm cách ăn kẻ đe dọa
  if (primaryThreat) {
    for (let i = 0; i < legalMoves.length; i++) {
      const m = legalMoves[i];
      if (m.to[0] === primaryThreat[0] && m.to[1] === primaryThreat[1]) {
        return m;
      }
    }
  }

  // 3. Ăn quân nếu có
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

  // 4. Tiến công về phía cờ đối thủ
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

// ============================================================================
// HÀM AN TOÀN EXECUTE BOT MOVE (SANDBOX + TIMEOUT + AUTO-FALLBACK)
// ============================================================================

/**
 * Thực thi mã nguồn bot an toàn với Sandbox, Timeout và Cơ chế Auto-Fallback
 * 
 * @param {string|Function} botInput - Chuỗi code của bot hoặc hàm JS function của bot
 * @param {Object} gameState - State chuẩn: { board, myColor, myFlag, enemyFlag, legalMoves, turn }
 * @param {number} timeoutMs - Giới hạn thời gian chạy bot (mặc định 200ms)
 * @returns {{ move: Object|null, isError: boolean, errorMsg: string|null, executionTimeMs: number }}
 */
export function executeBotMove(botInput, gameState, timeoutMs = 200) {
  const startTime = Date.now();
  const legalMoves = gameState?.legalMoves || [];

  // Trường hợp không còn nước đi hợp lệ
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

    if (typeof botInput === 'function') {
      // Trường hợp truyền trực tiếp hàm JavaScript
      returnedMove = botInput(gameState);
    } else if (typeof botInput === 'string') {
      // Trường hợp truyền code string: Tạo Function sandbox độc lập
      // Cung cấp các tham số cần thiết trong scope, cô lập môi trường
      const wrappedBody = `
        "use strict";
        const startTime = Date.now();
        const timeoutMs = ${Number(timeoutMs) || 200};
        
        // Wrap execution
        const run = function() {
          ${botInput}
        };

        const result = run();
        if (Date.now() - startTime > timeoutMs) {
          throw new Error("Bot execution exceeded timeout of " + timeoutMs + "ms");
        }
        return result;
      `;

      // Tạo function an toàn với các biến truyền vào
      const botExecutor = new Function('gameState', wrappedBody);
      returnedMove = botExecutor(gameState);
    } else {
      throw new Error(`Invalid bot input type: expected function or string, got ${typeof botInput}`);
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      throw new Error(`Bot execution timed out (${elapsed}ms > ${timeoutMs}ms)`);
    }

    // Kiểm tra tính hợp lệ của move trả về
    const validMove = findMatchingMove(returnedMove, legalMoves);
    if (!validMove) {
      throw new Error(
        `Bot returned illegal move: ${JSON.stringify(returnedMove)}. Must be one of legalMoves.`
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
  RandomBot,
  HunterBot,
  GuardianAndStrikerBot,
  RANDOM_BOT_CODE,
  HUNTER_BOT_CODE,
  GUARDIAN_AND_STRIKER_BOT_CODE
};
// Thêm code mẫu RusherBot (Bot tấn công dồn dập vào cờ đối thủ)
export const RUSHER_BOT_CODE = `
function bot(gameState) {
  const { board, myFlag, enemyFlag, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  function dist(p1, p2) {
    return Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]));
  }

  // 1. Chiếm cờ trực tiếp nếu có cơ hội
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (m.to[0] === enemyFlag[0] && m.to[1] === enemyFlag[1]) {
      return m;
    }
  }

  // 2. Nếu có nước ăn quân trên đường tiến tới cờ đối phương -> Ăn ngay
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

  // 3. Tiến công tối đa về phía cờ đối phương (Rusher Style)
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
