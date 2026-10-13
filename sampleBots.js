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
  const moves = gameState && gameState.legalMoves;
  if (!moves || moves.length === 0) return null;
  const idx = Math.floor(Math.random() * moves.length);
  return moves[idx];
}

return makeMove(gameState);`,

  hunter: `/**
 * [Sample] Hunter Bot (Thợ Săn)
 * Chiến thuật: Ưu tiên tìm và ăn quân đối phương theo luật Oẳn Tù Tì, kết hợp tiến về cờ địch
 */
function makeMove(gameState) {
  const { legalMoves, myColor, enemyFlag } = gameState || {};
  const board = (gameState && (gameState.board || gameState.grid)) || [];
  if (!legalMoves || legalMoves.length === 0) return null;

  const targetFlag = enemyFlag || (myColor === 'RED' ? [8, 4] : [0, 4]);

  // 1. Nếu có thể chạm thẳng cờ đối phương -> Đi ngay để thắng
  const winMove = legalMoves.find(m => m.to[0] === targetFlag[0] && m.to[1] === targetFlag[1]);
  if (winMove) return winMove;

  // 2. Lọc các nước đi vào ô có quân đối phương (ăn quân)
  const captureMoves = legalMoves.filter(
    m => board[m.to[0]] && board[m.to[0]][m.to[1]] !== null
  );

  if (captureMoves.length > 0) {
    const idx = Math.floor(Math.random() * captureMoves.length);
    return captureMoves[idx];
  }

  // 3. Nếu không có quân để ăn, đi ngẫu nhiên
  const randIdx = Math.floor(Math.random() * legalMoves.length);
  return legalMoves[randIdx];
}

return makeMove(gameState);`,

  striker: `function makeMove(gameState) {
  const { legalMoves, myColor, enemyFlag } = gameState;
  
  // 1. Kiểm tra an toàn: nếu không có nước đi hợp lệ
  if (!legalMoves || legalMoves.length === 0) return null;

  // 2. Xác định cờ đối phương an toàn (có fallback nếu enemyFlag bị thiếu)
  const targetFlag = enemyFlag || (myColor === 'RED' ? [8, 4] : [0, 4]);

  // Hàm tính khoảng cách Manhattan an toàn
  const getDist = (posA, posB) => {
    if (!posA || !posB) return 999;
    return Math.abs(posA[0] - posB[0]) + Math.abs(posA[1] - posB[1]);
  };

  // 3. Ưu tiên 1: Nếu có nước đi chạm thẳng vào cờ đối phương -> Đi ngay để thắng
  const winMove = legalMoves.find(m => m.to[0] === targetFlag[0] && m.to[1] === targetFlag[1]);
  if (winMove) return winMove;

  // 4. Ưu tiên 2: Tìm nước đi giúp áp sát cờ đối phương nhất
  let bestMove = legalMoves[0];
  let minDistance = 999;

  for (const move of legalMoves) {
    const d = getDist(move.to, targetFlag);
    if (d < minDistance) {
      minDistance = d;
      bestMove = move;
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
