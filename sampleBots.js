/**
 * sampleBots.js
 * 
 * BỘ MÃ NGUỒN BOT MẪU DÀNH RIÊNG CHO CLIENT (TRÌNH DUYỆT)
 * THUẦN JAVASCRIPT / STRING - TUYỆT ĐỐI KHÔNG IMPORT FS HAY MODULE NODE.JS NÀO!
 */

export const SAMPLE_BOTS = {
  random: `/**
 * [Sample] Random Bot
 * Chiến thuật: Đi ngẫu nhiên một nước đi hợp lệ bất kỳ
 */
function makeMove(gameState) {
  const moves = gameState.legalMoves;
  if (!moves || moves.length === 0) return null;
  const idx = Math.floor(Math.random() * moves.length);
  return moves[idx];
}

return makeMove(gameState);`,

  hunter: `/**
 * [Sample] Hunter Bot (Thợ Săn)
 * Chiến thuật: Ưu tiên tìm và ăn quân đối phương theo luật Oẳn Tù Tì
 */
function makeMove(gameState) {
  const { board, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  // Lọc các nước đi vào ô có quân đối phương (ăn quân)
  const captureMoves = legalMoves.filter(m => board[m.to[0]][m.to[1]] !== null);

  if (captureMoves.length > 0) {
    // Chọn ngẫu nhiên một trong các nước ăn quân
    const idx = Math.floor(Math.random() * captureMoves.length);
    return captureMoves[idx];
  }

  // Nếu không có quân để ăn, đi ngẫu nhiên
  const randIdx = Math.floor(Math.random() * legalMoves.length);
  return legalMoves[randIdx];
}

return makeMove(gameState);`,

  striker: `/**
 * [Sample] Striker Bot (Bot Chiếm Cờ / Vừa Công Vừa Thủ)
 * Chiến thuật: 
 * 1. Chiếm cờ đối phương ngay lập tức nếu có nước đi tới enemyFlag
 * 2. Bảo vệ cờ phe mình nếu có địch áp sát
 * 3. Tiến quân dần về phía cờ đối phương
 */
function makeMove(gameState) {
  const { board, myColor, myFlag, enemyFlag, legalMoves } = gameState;
  if (!legalMoves || legalMoves.length === 0) return null;

  function dist(p1, p2) {
    return Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]));
  }

  // 1. CHIẾM CỜ THẮNG LUÔN
  for (let i = 0; i < legalMoves.length; i++) {
    const m = legalMoves[i];
    if (m.to[0] === enemyFlag[0] && m.to[1] === enemyFlag[1]) {
      return m;
    }
  }

  // 2. PHÒNG THỦ CỜ: Quét địch gần cờ trong bán kính <= 2 ô
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

  // Nếu cờ bị đe dọa, ưu tiên diệt kẻ xâm nhập
  if (primaryThreat) {
    for (let i = 0; i < legalMoves.length; i++) {
      const m = legalMoves[i];
      if (m.to[0] === primaryThreat[0] && m.to[1] === primaryThreat[1]) {
        return m;
      }
    }
  }

  // 3. ƯU TIÊN ĂN QUÂN ĐỐI PHƯƠNG
  const captureMoves = legalMoves.filter(m => board[m.to[0]][m.to[1]] !== null);
  if (captureMoves.length > 0) {
    captureMoves.sort((a, b) => dist(a.to, enemyFlag) - dist(b.to, enemyFlag));
    return captureMoves[0];
  }

  // 4. TIẾN CÔNG VỀ PHÍA CỜ ĐỐI THỦ
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

return makeMove(gameState);`
};

export const STARTER_TEMPLATES = {
  javascript: SAMPLE_BOTS.striker,

  python: `import sys
import json

def make_move(game_state):
    board = game_state.get("board", [])
    legal_moves = game_state.get("legalMoves", [])
    enemy_flag = game_state.get("enemyFlag", [0, 4])
    
    if not legal_moves:
        return None

    # 1. Chiếm cờ đối phương nếu có cơ hội
    for move in legal_moves:
        if move["to"] == enemy_flag:
            return move

    # 2. Ưu tiên ăn quân đối phương
    for move in legal_moves:
        to_r, to_c = move["to"]
        if board[to_r][to_c] is not None:
            return move

    # 3. Mặc định chọn nước đi đầu tiên
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
    main()`,

  cpp: `#include <iostream>
#include <string>

// Standard I/O Contract: Nhận chuỗi JSON từ cin, xuất JSON ra cout
int main() {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(NULL);

    std::string input, line;
    while (std::getline(std::cin, line)) {
        input += line;
    }

    if (input.empty()) return 0;

    // Tìm kiếm nước đi đầu tiên trong mảng "legalMoves"
    size_t movesPos = input.find("\\"legalMoves\\"");
    if (movesPos != std::string::npos) {
        size_t fromPos = input.find("\\"from\\"", movesPos);
        size_t toPos = input.find("\\"to\\"", fromPos);
        if (fromPos != std::string::npos && toPos != std::string::npos) {
            size_t openBracketFrom = input.find('[', fromPos);
            size_t closeBracketFrom = input.find(']', openBracketFrom);
            size_t openBracketTo = input.find('[', toPos);
            size_t closeBracketTo = input.find(']', openBracketTo);

            std::string fromCoord = input.substr(openBracketFrom, closeBracketFrom - openBracketFrom + 1);
            std::string toCoord = input.substr(openBracketTo, closeBracketTo - openBracketTo + 1);

            std::cout << "{\\"from\\":" << fromCoord << ",\\"to\\":" << toCoord << "}" << std::endl;
            return 0;
        }
    }

    std::cout << "{\\"from\\":[0,0],\\"to\\":[0,0]}" << std::endl;
    return 0;
}`
};

export default {
  SAMPLE_BOTS,
  STARTER_TEMPLATES
};
