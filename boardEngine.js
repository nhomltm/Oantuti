/**
 * boardEngine.js
 * 
 * CORE ENGINE ĐỘC LẬP - CHIẾN THUẬT OẰN TÙ TÌ (ROCK-PAPER-SCISSORS ARENA 9X9)
 * 
 * Đặc tả:
 * - Bàn cờ 9x9 (Hàng 0..8, Cột 0..8).
 * - Quân cờ: Rock ('R' - Búa), Paper ('P' - Bao), Scissors ('S' - Kéo).
 * - Cờ/Khung thành (Flag/Goal):
 *     + RED Flag tại [0, 4]
 *     + BLUE Flag tại [8, 4]
 * - Quy tắc di chuyển: 8 hướng (như Vua), tối đa 1 ô.
 * - Quy tắc ăn quân Oẳn Tù Tì: R > S, S > P, P > R. Cùng loại không ăn được nhau (cản đường).
 * - Đồng minh không dẫm lên nhau; Không dẫm lên cờ của chính phe mình.
 * - Quân đối phương có thể đi vào ô cờ đối thủ để CHIẾM CỜ (Thắng lập tức).
 * - Giới hạn tối đa 150 turns (đếm theo số nước đi hoặc nửa nước, ở đây đếm theo lượt đi turnCount).
 * - Chuẩn hóa Contract nước đi: { from: [r1, c1], to: [r2, c2] }
 */

// Định nghĩa Constants
export const BOARD_SIZE = 9;
export const MAX_TURNS = 150;

export const PLAYER = {
  RED: 'RED',
  BLUE: 'BLUE'
};

export const PIECE_TYPE = {
  ROCK: 'R',
  PAPER: 'P',
  SCISSORS: 'S'
};

export const FLAG_POSITIONS = {
  [PLAYER.RED]: [0, 4],
  [PLAYER.BLUE]: [8, 4]
};

// 8 hướng di chuyển xung quanh (như Vua trong cờ vua)
export const DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1]
];

/**
 * Kiểm tra tính hợp lệ của tọa độ trên bàn cờ 9x9
 * @param {number} r 
 * @param {number} c 
 * @returns {boolean}
 */
export function isValidCoordinate(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

/**
 * Kiểm tra quy tắc Oẳn Tù Tì: pieceA có ăn được pieceB không?
 * @param {string} typeA 
 * @param {string} typeB 
 * @returns {boolean}
 */
export function canCapture(typeA, typeB) {
  if (typeA === PIECE_TYPE.ROCK && typeB === PIECE_TYPE.SCISSORS) return true;
  if (typeA === PIECE_TYPE.SCISSORS && typeB === PIECE_TYPE.PAPER) return true;
  if (typeA === PIECE_TYPE.PAPER && typeB === PIECE_TYPE.ROCK) return true;
  return false;
}

/**
 * Khởi tạo bàn cờ ban đầu theo thiết kế:
 * Đội RED:
 * - Cờ tại [0, 4]
 * - [0, 3]: R, [0, 5]: P
 * - [1, 2]: S, [1, 3]: P, [1, 4]: R, [1, 6]: S
 * (Mỗi bên gồm 6 quân cờ đối xứng hài hòa: 2 Búa (R), 2 Bao (P), 2 Kéo (S))
 * 
 * Đội BLUE:
 * - Cờ tại [8, 4]
 * - [8, 3]: R, [8, 5]: P
 * - [7, 2]: S, [7, 3]: P, [7, 4]: R, [7, 6]: S
 * 
 * Toàn bộ hàng 2, 3, 4, 5, 6 trống.
 * 
 * @returns {Object} initial gameState
 */
export function initBoard() {
  // Tạo ma trận grid 9x9 rỗng
  const grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));

  // Cấu hình ban đầu cho RED
  const redPieces = [
    { type: PIECE_TYPE.ROCK, pos: [0, 3] },
    { type: PIECE_TYPE.PAPER, pos: [0, 5] },
    { type: PIECE_TYPE.SCISSORS, pos: [1, 2] },
    { type: PIECE_TYPE.PAPER, pos: [1, 3] },
    { type: PIECE_TYPE.ROCK, pos: [1, 4] },
    { type: PIECE_TYPE.SCISSORS, pos: [1, 6] }
  ];

  for (const item of redPieces) {
    const [r, c] = item.pos;
    grid[r][c] = {
      owner: PLAYER.RED,
      type: item.type
    };
  }

  // Cấu hình ban đầu cho BLUE
  const bluePieces = [
    { type: PIECE_TYPE.ROCK, pos: [8, 3] },
    { type: PIECE_TYPE.PAPER, pos: [8, 5] },
    { type: PIECE_TYPE.SCISSORS, pos: [7, 2] },
    { type: PIECE_TYPE.PAPER, pos: [7, 3] },
    { type: PIECE_TYPE.ROCK, pos: [7, 4] },
    { type: PIECE_TYPE.SCISSORS, pos: [7, 6] }
  ];

  for (const item of bluePieces) {
    const [r, c] = item.pos;
    grid[r][c] = {
      owner: PLAYER.BLUE,
      type: item.type
    };
  }

  return {
    grid,
    flags: {
      [PLAYER.RED]: [...FLAG_POSITIONS[PLAYER.RED]],
      [PLAYER.BLUE]: [...FLAG_POSITIONS[PLAYER.BLUE]]
    },
    turn: PLAYER.RED,
    turnCount: 0,
    winner: null,      // PLAYER.RED | PLAYER.BLUE | 'DRAW' | null
    history: []        // Lưu lịch sử các nước đi
  };
}

/**
 * Đếm số lượng quân của mỗi bên
 * @param {Array<Array<Object|null>>} grid 
 * @returns {{ RED: number, BLUE: number }}
 */
export function countPieces(grid) {
  let red = 0;
  let blue = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = grid[r][c];
      if (cell) {
        if (cell.owner === PLAYER.RED) red++;
        else if (cell.owner === PLAYER.BLUE) blue++;
      }
    }
  }
  return { [PLAYER.RED]: red, [PLAYER.BLUE]: blue };
}

/**
 * Lấy danh sách tất cả các nước đi hợp lệ cho player hiện tại
 * @param {Object} state - Trạng thái game hiện tại
 * @param {string} player - PLAYER.RED hoặc PLAYER.BLUE (nếu không truyền sẽ lấy state.turn)
 * @returns {Array<{ from: [number, number], to: [number, number] }>}
 */
export function getLegalMoves(state, player = state.turn) {
  if (state.winner) {
    return [];
  }

  const legalMoves = [];
  const ownFlag = state.flags[player];
  const { grid } = state;

  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const piece = grid[r][c];
      if (!piece || piece.owner !== player) continue;

      // Quân thuộc về player, kiểm tra 8 hướng
      for (const [dr, dc] of DIRECTIONS) {
        const nr = r + dr;
        const nc = c + dc;

        // 1. Kiểm tra trong phạm vi bàn cờ
        if (!isValidCoordinate(nr, nc)) continue;

        // 2. Không được đi vào ô cờ của chính phe mình
        if (nr === ownFlag[0] && nc === ownFlag[1]) continue;

        const targetCell = grid[nr][nc];

        // 3. Ô đích trống
        if (!targetCell) {
          legalMoves.push({
            from: [r, c],
            to: [nr, nc]
          });
          continue;
        }

        // 4. Ô đích có quân phe mình -> Không được đi vào
        if (targetCell.owner === player) {
          continue;
        }

        // 5. Ô đích có quân đối phương -> Kiểm tra quy tắc Oẳn Tù Tì
        if (canCapture(piece.type, targetCell.type)) {
          legalMoves.push({
            from: [r, c],
            to: [nr, nc]
          });
        }
      }
    }
  }

  return legalMoves;
}

/**
 * Kiểm tra xem một nước đi có hợp lệ không
 * @param {Object} state 
 * @param {{ from: [number, number], to: [number, number] }} move 
 * @param {string} player 
 * @returns {boolean}
 */
export function isMoveLegal(state, move, player = state.turn) {
  if (!move || !Array.isArray(move.from) || !Array.isArray(move.to)) return false;
  const legalMoves = getLegalMoves(state, player);
  return legalMoves.some(
    m => m.from[0] === move.from[0] &&
         m.from[1] === move.from[1] &&
         m.to[0] === move.to[0] &&
         m.to[1] === move.to[1]
  );
}

/**
 * Áp dụng một nước đi vào bàn cờ và trả về trạng thái mới
 * @param {Object} state - Trạng thái bàn cờ hiện tại
 * @param {{ from: [number, number], to: [number, number] }} move - Nước đi hợp lệ
 * @param {string} player - Phe thực hiện nước đi (mặc định state.turn)
 * @returns {{ newState: Object, winner: string|null, captured: Object|null }}
 */
export function applyMove(state, move, player = state.turn) {
  if (state.winner) {
    throw new Error(`Game already ended with winner: ${state.winner}`);
  }

  if (player !== state.turn) {
    throw new Error(`Not player ${player}'s turn. Current turn: ${state.turn}`);
  }

  if (!isMoveLegal(state, move, player)) {
    throw new Error(`Illegal move from [${move?.from}] to [${move?.to}] for player ${player}`);
  }

  // Deep clone grid
  const newGrid = state.grid.map(row => row.map(cell => (cell ? { ...cell } : null)));
  const [fr, fc] = move.from;
  const [tr, tc] = move.to;

  const movingPiece = newGrid[fr][fc];
  const targetCell = newGrid[tr][tc];
  const captured = targetCell ? { ...targetCell } : null;

  // Thực hiện di chuyển
  newGrid[tr][tc] = movingPiece;
  newGrid[fr][fc] = null;

  const opponent = player === PLAYER.RED ? PLAYER.BLUE : PLAYER.RED;
  const opponentFlag = state.flags[opponent];

  let winner = null;

  // 1. Điều kiện Thắng: Chiếm cờ đối phương
  if (tr === opponentFlag[0] && tc === opponentFlag[1]) {
    winner = player;
  }

  // Đếm số lượng quân sau nước đi
  const counts = countPieces(newGrid);

  // 2. Điều kiện Thắng: Quét sạch toàn bộ quân đối phương
  if (!winner) {
    if (counts[opponent] === 0) {
      winner = player;
    }
  }

  const nextTurnCount = state.turnCount + 1;

  // 3. Điều kiện Thắng: Đạt giới hạn 150 turns
  if (!winner && nextTurnCount >= MAX_TURNS) {
    if (counts[PLAYER.RED] > counts[PLAYER.BLUE]) {
      winner = PLAYER.RED;
    } else if (counts[PLAYER.BLUE] > counts[PLAYER.RED]) {
      winner = PLAYER.BLUE;
    } else {
      winner = 'DRAW';
    }
  }

  // 4. Nếu đối phương hết nước đi hợp lệ ở lượt tiếp theo (bị chặn đứng hoàn toàn)
  // Tạo state tạm để kiểm tra nước đi tiếp theo của đối phương
  const nextPlayer = opponent;
  const nextStateDraft = {
    grid: newGrid,
    flags: {
      [PLAYER.RED]: [...state.flags[PLAYER.RED]],
      [PLAYER.BLUE]: [...state.flags[PLAYER.BLUE]]
    },
    turn: nextPlayer,
    turnCount: nextTurnCount,
    winner,
    history: []
  };

  if (!winner) {
    const oppLegalMoves = getLegalMoves(nextStateDraft, nextPlayer);
    if (oppLegalMoves.length === 0) {
      // Đối phương không còn nước đi hợp lệ -> Bên vừa đi giành chiến thắng
      winner = player;
    }
  }

  const newState = {
    grid: newGrid,
    flags: {
      [PLAYER.RED]: [...state.flags[PLAYER.RED]],
      [PLAYER.BLUE]: [...state.flags[PLAYER.BLUE]]
    },
    turn: nextPlayer,
    turnCount: nextTurnCount,
    winner,
    history: [
      ...state.history,
      {
        player,
        move: { from: [...move.from], to: [...move.to] },
        captured
      }
    ]
  };

  return {
    newState,
    winner,
    captured
  };
}

/**
 * Trả về deep copy của state để gửi cho Bot hoặc Client
 * Đảm bảo Bot không thể vô tình sửa đổi trực tiếp state của game engine.
 * @param {Object} state 
 * @param {string} player - Phe bot đang điều khiển (RED hoặc BLUE)
 * @returns {Object} Deep copy của game state cùng các thông tin bổ sung tiện ích
 */
export function getGameStateForBot(state, player = state.turn) {
  const clonedGrid = state.grid.map(row => row.map(cell => (cell ? { ...cell } : null)));
  const myColor = player || state.turn || PLAYER.RED;
  const enemyColor = myColor === PLAYER.RED ? PLAYER.BLUE : PLAYER.RED;
  const myFlag = state.flags && state.flags[myColor]
    ? [...state.flags[myColor]]
    : (myColor === PLAYER.RED ? [0, 4] : [8, 4]);
  const enemyFlag = state.flags && state.flags[enemyColor]
    ? [...state.flags[enemyColor]]
    : (myColor === PLAYER.RED ? [8, 4] : [0, 4]);

  return {
    board: clonedGrid,
    grid: clonedGrid,
    boardSize: BOARD_SIZE,
    maxTurns: MAX_TURNS,
    myColor,
    myPlayer: myColor,
    myFlag,
    enemyFlag,
    turn: state.turnCount,
    turnPlayer: state.turn,
    turnCount: state.turnCount,
    winner: state.winner,
    flags: {
      [PLAYER.RED]: [...state.flags[PLAYER.RED]],
      [PLAYER.BLUE]: [...state.flags[PLAYER.BLUE]]
    },
    legalMoves: getLegalMoves(state, myColor),
    pieceCounts: countPieces(state.grid),
    lastMove: state.history.length > 0 ? { ...state.history[state.history.length - 1] } : null
  };
}

// Export default object gom tất cả API chuẩn
export default {
  BOARD_SIZE,
  MAX_TURNS,
  PLAYER,
  PIECE_TYPE,
  FLAG_POSITIONS,
  DIRECTIONS,
  isValidCoordinate,
  canCapture,
  initBoard,
  countPieces,
  getLegalMoves,
  isMoveLegal,
  applyMove,
  getGameStateForBot
};
