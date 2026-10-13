/**
 * ui.js
 * 
 * CLIENT APPLICATION CHO ĐẤU TRƯỜNG BOT OẰN TÙ TÌ 9X9 ĐA NGƯỜI CHƠI
 * 
 * Tính năng chính:
 * 1. Nộp / Cập nhật Code Bot:
 *    - Gửi API POST /api/bot/submit
 *    - Lưu thông tin người chơi & chọn phòng (PUBLIC hoặc Custom RoomId)
 *    - Nạp code mẫu: Random, Hunter, Rusher
 *    - Hiển thị Live Queue Status: "Đang chờ xếp trận (Batch)", "Đang thi đấu...", "Đã cập nhật kết quả"
 * 
 * 2. Bảng Xếp Hạng Trực Tiếp (Live Leaderboard):
 *    - Tự động Polling định kỳ mỗi 2 giây từ GET /api/leaderboard?roomId=...
 *    - Nút "Xem Replay" trên từng hàng bot hoặc trong danh sách trận gần đây
 * 
 * 3. Bàn cờ 9x9 & Visualizer Replay 60fps (Chống chớp nháy):
 *    - Khởi tạo 81 ô một lần duy nhất, diff-based update.
 *    - Cờ Red tại [0,4], cờ Blue tại [8,4].
 *    - Điều khiển Replay: Play/Pause, Next/Prev step, thanh trượt speed và turn slider.
 *    - Thông báo nước đi, quân bị ăn, người chiến thắng rõ ràng.
 */

import {
  initBoard,
  PLAYER,
  PIECE_TYPE,
  MAX_TURNS,
  countPieces,
  getLegalMoves,
  isMoveLegal,
  applyMove,
  getGameStateForBot
} from './boardEngine.js';
import { SAMPLE_BOTS, STARTER_TEMPLATES } from './sampleBots.js';

// ============================================================================
// STATE QUẢN LÝ ỨNG DỤNG CLIENT
// ============================================================================
const AppState = {
  currentRoomId: 'PUBLIC',
  playerId: `player_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
  currentMatch: null,         // Object match đang được Replay
  currentTurnIndex: 0,        // Turn hiện tại đang hiển thị
  isPlaying: false,           // Trạng thái tự động chạy Replay
  playbackTimer: null,        // Timer interval của playback
  speedMs: 400,               // Tốc độ replay (ms/turn)
  theme: 'dark',              // 'dark' | 'light'
  cellElements: [],           // Mảng tham chiếu 81 ô DOM [r][c]
  cellDataCache: [],          // Cache trạng thái ô cờ để diff render (60fps)
  pollingInterval: null,      // Polling timer cập nhật Leaderboard
  lastQueueStatus: ''         // Trạng thái hàng đợi
};

// State riêng cho Tab 4: Chơi Bằng Tay (Luyện Tập / Test Bot)
const ManualArenaState = {
  gameState: null,            // Trạng thái bàn cờ thực chiến từ initBoard()
  humanPlayer: PLAYER.RED,    // Phe của Người chơi (PLAYER.RED | PLAYER.BLUE)
  botPlayer: PLAYER.BLUE,     // Phe của Bot đối thủ
  selectedCell: null,         // Tọa độ [r, c] quân cờ đang được Người chơi chọn
  legalMovesForSelected: [],  // Danh sách các nước đi hợp lệ của quân đang chọn
  lastMove: null,             // Nước đi gần nhất { from: [r,c], to: [r,c] }
  isBotThinking: false,       // Khóa bàn cờ khi Bot đang suy nghĩ
  botThinkTimer: null,        // Timer tạo nhịp đi tự nhiên cho Bot
  opponentMode: 'custom',     // 'custom' | 'striker' | 'hunter' | 'random'
  cellElements: []            // Mảng 81 ô DOM [r][c] của bàn cờ #manualBoardGrid
};

// Biểu tượng quân cờ
const PIECE_ICONS = {
  [PIECE_TYPE.ROCK]: '✊',      // Búa
  [PIECE_TYPE.PAPER]: '✋',     // Bao
  [PIECE_TYPE.SCISSORS]: '✌️'   // Kéo
};

const PIECE_LABELS = {
  [PIECE_TYPE.ROCK]: 'BÚA (R)',
  [PIECE_TYPE.PAPER]: 'BAO (P)',
  [PIECE_TYPE.SCISSORS]: 'KÉO (S)'
};

// ============================================================================
// KHỞI TẠO BÀN CỜ 81 Ô (MỘT LẦN DUY NHẤT - TỐI ƯU HIỆU NĂNG)
// ============================================================================
function initBoardDOM() {
  const gridContainer = document.getElementById('boardGrid');
  gridContainer.innerHTML = '';
  AppState.cellElements = [];
  AppState.cellDataCache = [];

  for (let r = 0; r < 9; r++) {
    const rowElements = [];
    const rowCache = [];

    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;

      // Cờ Red [0,4], Cờ Blue [8,4]
      if (r === 0 && c === 4) {
        cell.classList.add('flag-red');
        const flagMarker = document.createElement('span');
        flagMarker.className = 'flag-marker';
        flagMarker.innerText = '🚩';
        cell.appendChild(flagMarker);
      } else if (r === 8 && c === 4) {
        cell.classList.add('flag-blue');
        const flagMarker = document.createElement('span');
        flagMarker.className = 'flag-marker';
        flagMarker.innerText = '🏳️';
        cell.appendChild(flagMarker);
      }

      gridContainer.appendChild(cell);
      rowElements.push(cell);
      rowCache.push({ owner: null, type: null, isFrom: false, isTo: false });
    }
    AppState.cellElements.push(rowElements);
    AppState.cellDataCache.push(rowCache);
  }
}

// ============================================================================
// RENDER BOARD HIỆU NĂNG CAO (CHỐNG CHỚP NHÁY 60FPS)
// ============================================================================
function renderBoard(grid, lastMove = null) {
  if (!grid) return;

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cellData = grid[r][c];
      const cellEl = AppState.cellElements[r][c];
      const cached = AppState.cellDataCache[r][c];

      const isFrom = lastMove && lastMove.from[0] === r && lastMove.from[1] === c;
      const isTo = lastMove && lastMove.to[0] === r && lastMove.to[1] === c;

      const owner = cellData ? cellData.owner : null;
      const type = cellData ? cellData.type : null;

      const isStateChanged = cached.owner !== owner || cached.type !== type;
      const isHighlightChanged = cached.isFrom !== isFrom || cached.isTo !== isTo;

      if (!isStateChanged && !isHighlightChanged) {
        continue;
      }

      // Highlight nước đi vừa qua
      if (isHighlightChanged) {
        if (isFrom) cellEl.classList.add('move-from');
        else cellEl.classList.remove('move-from');

        if (isTo) cellEl.classList.add('move-to');
        else cellEl.classList.remove('move-to');

        cached.isFrom = isFrom;
        cached.isTo = isTo;
      }

      // Cập nhật quân cờ
      if (isStateChanged) {
        cached.owner = owner;
        cached.type = type;

        const oldPiece = cellEl.querySelector('.piece');
        if (oldPiece) {
          cellEl.removeChild(oldPiece);
        }

        if (cellData) {
          const pieceDiv = document.createElement('div');
          pieceDiv.className = `piece ${cellData.owner === PLAYER.RED ? 'piece-red' : 'piece-blue'}`;
          
          const iconSpan = document.createElement('span');
          iconSpan.className = 'piece-icon';
          iconSpan.innerText = PIECE_ICONS[cellData.type] || '?';

          const labelSpan = document.createElement('span');
          labelSpan.className = 'piece-label';
          labelSpan.innerText = cellData.type;

          pieceDiv.appendChild(iconSpan);
          pieceDiv.appendChild(labelSpan);
          pieceDiv.title = `${cellData.owner}: ${PIECE_LABELS[cellData.type]}`;

          cellEl.appendChild(pieceDiv);
        }
      }
    }
  }
}

// ============================================================================
// ĐIỀU KHIỂN & CẬP NHẬT REPLAY VISUALIZER
// ============================================================================
function updateReplayUI() {
  const match = AppState.currentMatch;
  if (!match) return;

  const totalTurns = match.turns ? match.turns.length : 0;
  const turnIndex = AppState.currentTurnIndex;

  const slider = document.getElementById('turnSlider');
  slider.max = totalTurns;
  slider.value = turnIndex;

  document.getElementById('lblPrevTurn').innerText = '0';
  document.getElementById('lblMaxTurn').innerText = totalTurns.toString();
  document.getElementById('turnIndicator').innerText = `Turn ${turnIndex} / ${totalTurns}`;

  let currentBoard = match.initialBoard || initBoard().grid;
  let lastMove = null;
  let announcerText = `Trận đấu: ${match.botRed.name} (🔴 RED) vs ${match.botBlue.name} (🔵 BLUE)`;

  if (turnIndex > 0 && turnIndex <= totalTurns) {
    const currentStep = match.turns[turnIndex - 1];
    currentBoard = currentStep.boardState;
    lastMove = currentStep.move;

    const playerColor = currentStep.player === PLAYER.RED ? '🔴 RED' : '🔵 BLUE';
    const moveCoord = `[${currentStep.move.from}] ➔ [${currentStep.move.to}]`;
    const captureNotice = currentStep.captured 
      ? ` ⚡ ĂN QUÂN ${currentStep.captured.type} (${currentStep.captured.owner})!` 
      : '';
    const errNotice = currentStep.isError ? ` ⚠️ (Lỗi: ${currentStep.errorMsg})` : '';

    announcerText = `Nước ${turnIndex}: ${playerColor} đi ${moveCoord}${captureNotice}${errNotice}`;
  }

  if (turnIndex === totalTurns && totalTurns > 0) {
    let winMsg = '';
    if (match.winner === 'DRAW') {
      winMsg = '🤝 KẾT QUẢ: HÒA CỜ!';
    } else {
      const winnerName = match.winner === PLAYER.RED ? match.botRed.name : match.botBlue.name;
      winMsg = `🏆 ${match.winner} THẮNG (${winnerName})! Lý do: ${match.endReason}`;
    }
    announcerText += ` | ${winMsg}`;
  }

  document.getElementById('moveAnnouncer').innerText = announcerText;

  const counts = countPieces(currentBoard);
  document.getElementById('piecesRed').innerText = `Quân: ${counts[PLAYER.RED]}`;
  document.getElementById('piecesBlue').innerText = `Quân: ${counts[PLAYER.BLUE]}`;

  renderBoard(currentBoard, lastMove);
}

function playReplay() {
  if (!AppState.currentMatch) return;
  if (AppState.isPlaying) return;

  if (AppState.currentTurnIndex >= AppState.currentMatch.turns.length) {
    AppState.currentTurnIndex = 0;
  }

  AppState.isPlaying = true;
  document.getElementById('playIcon').innerText = '⏸';
  document.getElementById('btnPlayPause').classList.add('playing');

  AppState.playbackTimer = setInterval(() => {
    if (AppState.currentTurnIndex < AppState.currentMatch.turns.length) {
      AppState.currentTurnIndex++;
      updateReplayUI();
    } else {
      pauseReplay();
    }
  }, AppState.speedMs);
}

function pauseReplay() {
  AppState.isPlaying = false;
  if (AppState.playbackTimer) {
    clearInterval(AppState.playbackTimer);
    AppState.playbackTimer = null;
  }
  document.getElementById('playIcon').innerText = '▶';
  document.getElementById('btnPlayPause').classList.remove('playing');
}

function togglePlayPause() {
  if (AppState.isPlaying) pauseReplay();
  else playReplay();
}

function seekToTurn(turn) {
  pauseReplay();
  const max = AppState.currentMatch ? AppState.currentMatch.turns.length : 0;
  AppState.currentTurnIndex = Math.max(0, Math.min(turn, max));
  updateReplayUI();
}

// Tải chi tiết trận đấu từ API và nạp vào Replay Visualizer
async function loadAndPlayMatch(matchId) {
  try {
    const res = await fetch(`/api/matches/${matchId}`);
    const data = await res.json();
    if (!data.success || !data.match) {
      alert('Không tìm thấy thông tin trận đấu này.');
      return;
    }

    pauseReplay();
    AppState.currentMatch = data.match;
    AppState.currentTurnIndex = 0;

    document.getElementById('nameRed').innerText = data.match.botRed.name;
    document.getElementById('nameBlue').innerText = data.match.botBlue.name;

    updateReplayUI();
    playReplay();
  } catch (err) {
    console.error('Lỗi khi tải trận đấu:', err);
  }
}

// ============================================================================
// KẾT NỐI API SERVER & CẬP NHẬT TRỰC TIẾP (LIVE LEADERBOARD & QUEUE)
// ============================================================================

// Cập nhật trạng thái hàng đợi Batch trên giao diện
function updateQueueCard(isBatchRunning, queueLength) {
  const card = document.getElementById('queueStatusCard');
  const title = document.getElementById('queueStatusTitle');
  const desc = document.getElementById('queueStatusDesc');
  const statusLabel = document.getElementById('statusLabel');

  card.classList.remove('running', 'queued');

  if (isBatchRunning) {
    card.classList.add('running');
    title.innerText = 'Đang Thi Đấu (Batch Running)...';
    desc.innerText = `Đang mô phỏng các cặp đấu trong batch... (Hàng đợi còn: ${queueLength} bot)`;
    statusLabel.innerText = 'Đang thi đấu...';
  } else if (queueLength > 0) {
    card.classList.add('queued');
    title.innerText = 'Đang Chờ Xếp Trận (Batch)';
    desc.innerText = `Có ${queueLength} bot trong hàng đợi chờ chạy batch kế tiếp...`;
    statusLabel.innerText = 'Chờ xếp trận';
  } else {
    title.innerText = 'Đã Cập Nhật Kết Quả';
    desc.innerText = 'Hàng đợi trống. Các trận đấu của đợt này đã hoàn tất!';
    statusLabel.innerText = 'Sẵn sàng';
  }
}

// Lấy Bảng xếp hạng và các trận đấu gần đây từ server
async function fetchLeaderboard() {
  try {
    const res = await fetch(`/api/leaderboard?roomId=${AppState.currentRoomId}`);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.success) return;

    updateQueueCard(data.isBatchRunning, data.queueLength);
    renderLeaderboardTable(data.leaderboard, data.recentMatches);
    renderRecentMatchesList(data.recentMatches);
  } catch (err) {
    console.error('Lỗi khi fetch leaderboard:', err);
  }
}

// Render Bảng điểm Leaderboard
function renderLeaderboardTable(leaderboard, recentMatches = []) {
  const tbody = document.getElementById('leaderboardTbody');
  tbody.innerHTML = '';

  if (!leaderboard || leaderboard.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Chưa có bot nào trong phòng này</td></tr>`;
    return;
  }

  leaderboard.forEach((item, index) => {
    const tr = document.createElement('tr');
    
    let rankBadge = `<span class="rank-badge">${index + 1}</span>`;
    if (index === 0) rankBadge = `<span class="rank-badge rank-1">🥇</span>`;
    else if (index === 1) rankBadge = `<span class="rank-badge rank-2">🥈</span>`;
    else if (index === 2) rankBadge = `<span class="rank-badge rank-3">🥉</span>`;

    const botId = item.botId || item.id || item.playerId;
    const displayBotName = item.botName || item.name || item.playerName || 'Unnamed Bot';
    const displayAuthor = item.author || item.playerName || 'Anonymous';

    // Xác định matchId để xem Replay:
    // 1. Ưu tiên lấy `item.lastMatchId` đã được server lưu cho cả Red và Blue
    // 2. Nếu thiếu `lastMatchId`, tìm trận gần nhất có chứa `botId` trong `recentMatches`
    // 3. Nếu vẫn thiếu nhưng hệ thống có lịch sử trận đấu, lấy trận mẫu gần nhất
    const matchedInHistory = Array.isArray(recentMatches)
      ? recentMatches.find(
          m =>
            m?.botRed?.id === botId ||
            m?.botBlue?.id === botId ||
            m?.botRed?.botId === botId ||
            m?.botBlue?.botId === botId
        )
      : null;

    const replayMatchId =
      item.lastMatchId ||
      (matchedInHistory ? matchedInHistory.id : null) ||
      (Array.isArray(recentMatches) && recentMatches.length > 0 ? recentMatches[0].id : null);

    tr.innerHTML = `
      <td>${rankBadge}</td>
      <td><strong>${displayBotName}</strong></td>
      <td>${displayAuthor}</td>
      <td><strong style="color: var(--accent-gold);">${item.score}</strong></td>
      <td>${item.wins}/${item.draws}/${item.losses}</td>
      <td class="${item.errors > 0 ? 'error-badge' : ''}">${item.errors}</td>
      <td>
        ${replayMatchId ? `<button class="btn btn-xs btn-outline btn-watch-match" data-match-id="${replayMatchId}">Xem Replay ▶</button>` : `<span style="color:var(--text-muted)">-</span>`}
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Gắn sự kiện xem trận đấu
  tbody.querySelectorAll('.btn-watch-match').forEach(btn => {
    btn.addEventListener('click', () => {
      loadAndPlayMatch(btn.dataset.matchId);
    });
  });
}

// Render Danh sách các trận gần đây
function renderRecentMatchesList(matches) {
  const container = document.getElementById('matchesList');
  container.innerHTML = '';

  if (!matches || matches.length === 0) {
    container.innerHTML = `<div class="empty-state">Chưa có trận đấu nào được lưu.</div>`;
    return;
  }

  matches.forEach((m, idx) => {
    const item = document.createElement('div');
    item.className = 'match-item';
    item.dataset.matchId = m.id;

    let resultTag = '🤝 HÒA';
    if (m.winner === PLAYER.RED) resultTag = `🔴 ${m.botRed.name} Thắng`;
    else if (m.winner === PLAYER.BLUE) resultTag = `🔵 ${m.botBlue.name} Thắng`;

    item.innerHTML = `
      <div class="match-item-info">
        <div class="match-item-title">#${idx + 1}: ${m.botRed.name} vs ${m.botBlue.name}</div>
        <div class="match-item-meta">${resultTag} • ${m.totalTurns} Turns</div>
      </div>
      <button class="btn btn-sm btn-outline">Xem ▶</button>
    `;

    item.addEventListener('click', () => {
      loadAndPlayMatch(m.id);
    });

    container.appendChild(item);
  });
}

// Nộp / Cập nhật code bot lên Server
async function handleSubmitBot() {
  const nameEl = document.getElementById('bot-name') || document.getElementById('botNameInput');
  const authorEl = document.getElementById('bot-author') || document.getElementById('playerNameInput');
  const codeEl = document.getElementById('bot-code') || document.getElementById('botCodeEditor');
  const langEl = document.getElementById('languageSelect');

  const botName = nameEl ? nameEl.value.trim() : 'CyberWarrior';
  const playerName = authorEl ? authorEl.value.trim() : 'Player';
  const language = langEl ? langEl.value : 'javascript';
  const botCode = codeEl ? codeEl.value.trim() : '';

  if (!botCode) {
    alert('Vui lòng không để trống mã nguồn bot!');
    return;
  }

  const submitBtn = document.getElementById('submitBotBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Đang gửi lên server...';
  }

  try {
    const res = await fetch('/api/bot/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId: AppState.playerId,
        botName: botName || 'CyberWarrior',
        playerName: playerName || 'Player',
        author: playerName || 'Player',
        language: language,
        botCode: botCode,
        roomId: AppState.currentRoomId
      })
    });

    const data = await res.json();
    if (data.success) {
      updateQueueCard(false, data.data.queuePosition);
      fetchLeaderboard();
      console.log('✅ [UI] Nộp bot thành công:', data.data);
    } else {
      alert('Lỗi nộp bot: ' + data.error);
    }
  } catch (err) {
    alert('Không thể kết nối đến server: ' + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span class="icon">🚀</span> Nộp / Cập Nhật Code Bot';
    }
  }
}

// Tạo phòng riêng mới
async function handleCreateRoom() {
  const roomName = prompt('Nhập tên phòng riêng của bạn:', 'Đấu Trường Anh Hào');
  if (!roomName) return;

  try {
    const res = await fetch(`/api/room/create?name=${encodeURIComponent(roomName)}`);
    const data = await res.json();
    if (data.success) {
      const newId = data.data.roomId;
      alert(`Đã tạo phòng thành công!\nMã phòng: ${newId}\nHãy gửi mã này cho bạn bè.`);
      
      AppState.currentRoomId = newId;
      document.getElementById('roomBadge').innerText = `Phòng: ${newId}`;
      document.getElementById('roomTypeSelect').value = 'CUSTOM';
      document.getElementById('customRoomGroup').style.display = 'flex';
      document.getElementById('customRoomInput').value = newId;

      fetchLeaderboard();
    }
  } catch (err) {
    alert('Lỗi khi tạo phòng: ' + err.message);
  }
}

// Nạp code theo ngôn ngữ lập trình
function loadLanguageTemplate(lang) {
  const editor = document.getElementById('bot-code') || document.getElementById('botCodeEditor');
  if (!editor) return;

  if (lang === 'python') {
    editor.value = STARTER_TEMPLATES.python;
  } else if (lang === 'cpp') {
    editor.value = STARTER_TEMPLATES.cpp;
  } else {
    editor.value = STARTER_TEMPLATES.javascript;
  }
  console.log(`ℹ️ [UI] Đã nạp Starter Template cho ngôn ngữ: ${lang}`);
}

/**
 * Hàm nạp Bot Mẫu chuẩn (Random, Hunter, Striker/Guardian)
 * Tự động điền code, tên bot, tác giả và chuyển ngôn ngữ về JavaScript
 * @param {string} botKey ('random' | 'hunter' | 'striker')
 */
export function loadSampleBot(botKey) {
  const key = (botKey || 'random').toLowerCase();
  const codeEl = document.getElementById('bot-code') || document.getElementById('botCodeEditor');
  const nameEl = document.getElementById('bot-name') || document.getElementById('botNameInput');
  const authorEl = document.getElementById('bot-author') || document.getElementById('playerNameInput');
  const langSelect = document.getElementById('languageSelect');

  if (!codeEl) {
    console.error('❌ [UI] Không tìm thấy ô nhập code (#bot-code hoặc #botCodeEditor)!');
    return;
  }

  // 1. Chuyển dropdown ngôn ngữ về JavaScript
  if (langSelect) {
    langSelect.value = 'javascript';
  }

  // 2. Điền code, tên và tác giả tương ứng từ SAMPLE_BOTS thuần túy
  let botData = null;

  if (key === 'hunter') {
    botData = {
      name: '[Sample] Hunter Bot',
      author: 'System Hunter',
      code: SAMPLE_BOTS.hunter
    };
  } else if (key === 'striker' || key === 'guardian') {
    botData = {
      name: '[Sample] Striker Bot',
      author: 'System Guardian',
      code: SAMPLE_BOTS.striker
    };
  } else {
    // Mặc định Random
    botData = {
      name: '[Sample] Random Bot',
      author: 'System Rookie',
      code: SAMPLE_BOTS.random
    };
  }

  codeEl.value = botData.code;
  if (nameEl) nameEl.value = botData.name;
  if (authorEl) authorEl.value = botData.author;

  console.log(`🎯 [UI] Nạp thành công Bot Mẫu: ${botData.name} (${key}) vào khung soạn thảo!`);
}

// ============================================================================
// TAB 4: CHƠI BẰNG TAY - LUYỆN TẬP / TEST BOT (#view-manual)
// ============================================================================

/**
 * Khởi tạo 81 ô DOM cho bàn cờ tương tác #manualBoardGrid
 */
function initManualBoardDOM() {
  const gridContainer = document.getElementById('manualBoardGrid');
  if (!gridContainer) return;

  gridContainer.innerHTML = '';
  ManualArenaState.cellElements = [];

  for (let r = 0; r < 9; r++) {
    const rowElements = [];
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;

      if (r === 0 && c === 4) {
        cell.classList.add('flag-red');
        const flagMarker = document.createElement('span');
        flagMarker.className = 'flag-marker';
        flagMarker.innerText = '🚩';
        cell.appendChild(flagMarker);
      } else if (r === 8 && c === 4) {
        cell.classList.add('flag-blue');
        const flagMarker = document.createElement('span');
        flagMarker.className = 'flag-marker';
        flagMarker.innerText = '🏳️';
        cell.appendChild(flagMarker);
      }

      cell.addEventListener('click', () => handleManualCellClick(r, c));

      gridContainer.appendChild(cell);
      rowElements.push(cell);
    }
    ManualArenaState.cellElements.push(rowElements);
  }
}

// Mảng lưu trữ toàn bộ lịch sử nước đi của ván đấu thực chiến hiện tại
let matchMoveHistory = [];

/**
 * Render bảng log chính (#manualMoveHistory):
 * Chỉ cắt lấy tối đa 4 phần tử cuối cùng (`matchMoveHistory.slice(-4)`)
 * để giữ giao diện gọn gàng, không phải cuộn trang.
 */
function renderMoveHistory() {
  const logContainer = document.getElementById('manualMoveHistory');
  const viewAllBtn = document.getElementById('btn-view-all-logs');

  if (viewAllBtn) {
    viewAllBtn.innerText = matchMoveHistory.length > 0
      ? `📜 Xem Toàn Bộ Lịch Sử (${matchMoveHistory.length})`
      : '📜 Xem Toàn Bộ Lịch Sử';
  }

  if (!logContainer) return;
  logContainer.innerHTML = '';

  if (matchMoveHistory.length === 0) {
    logContainer.innerHTML = `<div class="log-empty">Chưa có nước đi nào. Hãy click chọn quân cờ bên trái để bắt đầu!</div>`;
    return;
  }

  // Chỉ lấy 4 nước đi gần nhất
  const recentFourMoves = matchMoveHistory.slice(-4);
  for (const item of recentFourMoves) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${item.typeClass}`;
    entry.innerText = item.text;
    logContainer.appendChild(entry);
  }

  // Nếu Modal toàn bộ lịch sử đang mở, cập nhật luôn nội dung trong Modal
  const modal = document.getElementById('fullHistoryModal');
  if (modal && modal.open) {
    renderFullHistoryModal();
  }
}

/**
 * Render toàn bộ `matchMoveHistory` vào bên trong Modal (#fullHistoryModalList)
 */
function renderFullHistoryModal() {
  const modalList = document.getElementById('fullHistoryModalList');
  const countBadge = document.getElementById('historyModalCountBadge');

  if (countBadge) {
    countBadge.innerText = `${matchMoveHistory.length} mục`;
  }

  if (!modalList) return;
  modalList.innerHTML = '';

  if (matchMoveHistory.length === 0) {
    modalList.innerHTML = `<div class="log-empty">Chưa có dữ liệu lịch sử nước đi trong ván này.</div>`;
    return;
  }

  matchMoveHistory.forEach((item, idx) => {
    const entry = document.createElement('div');
    entry.className = `log-entry ${item.typeClass}`;
    entry.innerText = `#${idx + 1} • ${item.text}`;
    modalList.appendChild(entry);
  });

  modalList.scrollTop = modalList.scrollHeight;
}

/**
 * Ghi thêm 1 dòng vào mảng `matchMoveHistory` và cập nhật UI (4 dòng mới nhất)
 */
function appendManualLog(text, typeClass = 'log-human') {
  matchMoveHistory.push({
    text,
    typeClass,
    timestamp: Date.now()
  });
  renderMoveHistory();
}

/**
 * Render bàn cờ tương tác 9x9 cùng các trạng thái highlight chọn quân & nước đi hợp lệ
 */
function renderManualBoard() {
  const state = ManualArenaState.gameState;
  if (!state || ManualArenaState.cellElements.length === 0) return;

  const { grid, turn, turnCount, winner, flags } = state;
  const isHumanTurn = !winner && !ManualArenaState.isBotThinking && turn === ManualArenaState.humanPlayer;

  // Cập nhật thông tin 2 phe trên Banner
  const counts = countPieces(grid);
  const piecesRedEl = document.getElementById('manualPiecesRed');
  const piecesBlueEl = document.getElementById('manualPiecesBlue');
  const roleRedEl = document.getElementById('manualRoleRed');
  const roleBlueEl = document.getElementById('manualRoleBlue');
  const turnIndEl = document.getElementById('manualTurnIndicator');
  const turnBadgeEl = document.getElementById('manualTurnBadge');
  const swapBtnEl = document.getElementById('btnManualSwapSide');

  if (piecesRedEl) piecesRedEl.innerText = `Quân còn lại: ${counts[PLAYER.RED]}`;
  if (piecesBlueEl) piecesBlueEl.innerText = `Quân còn lại: ${counts[PLAYER.BLUE]}`;
  if (roleRedEl) {
    roleRedEl.innerText = ManualArenaState.humanPlayer === PLAYER.RED ? '👤 Người Chơi (Bạn)' : '🤖 Bot Đối Thủ';
  }
  if (roleBlueEl) {
    roleBlueEl.innerText = ManualArenaState.humanPlayer === PLAYER.BLUE ? '👤 Người Chơi (Bạn)' : '🤖 Bot Đối Thủ';
  }
  if (turnIndEl) {
    turnIndEl.innerText = `Turn ${turnCount} / ${MAX_TURNS}`;
  }
  if (swapBtnEl) {
    const sideLabel = ManualArenaState.humanPlayer === PLAYER.RED ? '🔴 RED' : '🔵 BLUE';
    swapBtnEl.innerHTML = `<span class="icon">🔀</span> Đổi phe (Đang cầm: ${sideLabel})`;
  }
  if (turnBadgeEl) {
    if (winner) {
      turnBadgeEl.innerText = winner === 'DRAW' ? '🤝 Kết thúc: HÒA' : `🏆 Thắng: ${winner}`;
    } else if (ManualArenaState.isBotThinking) {
      turnBadgeEl.innerText = `🤖 Bot (${ManualArenaState.botPlayer}) đang đi...`;
    } else {
      const icon = turn === PLAYER.RED ? '🔴 RED' : '🔵 BLUE';
      const who = turn === ManualArenaState.humanPlayer ? 'Người chơi' : 'Bot';
      turnBadgeEl.innerText = `Lượt: ${who} (${icon})`;
    }
  }

  const lastMove = ManualArenaState.lastMove;
  const selected = ManualArenaState.selectedCell;
  const legalTargets = ManualArenaState.legalMovesForSelected;
  const enemyFlag = flags[ManualArenaState.botPlayer];

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cellEl = ManualArenaState.cellElements[r][c];
      const cellData = grid[r][c];

      // Xóa các class trạng thái cũ
      cellEl.classList.remove(
        'move-from',
        'move-to',
        'clickable-piece',
        'cell-selected',
        'cell-legal-move',
        'cell-legal-capture'
      );

      // Highlight nước đi vừa thực hiện
      if (lastMove) {
        if (lastMove.from[0] === r && lastMove.from[1] === c) cellEl.classList.add('move-from');
        if (lastMove.to[0] === r && lastMove.to[1] === c) cellEl.classList.add('move-to');
      }

      // Đánh dấu quân cờ của người chơi có thể click
      if (isHumanTurn && cellData && cellData.owner === ManualArenaState.humanPlayer) {
        cellEl.classList.add('clickable-piece');
      }

      // Highlight ô quân cờ đang chọn
      if (selected && selected[0] === r && selected[1] === c) {
        cellEl.classList.add('cell-selected');
      }

      // Highlight các ô nước đi hợp lệ (màu xanh)
      const isLegalTarget = legalTargets.some(m => m.to[0] === r && m.to[1] === c);
      if (isLegalTarget) {
        const isEnemyFlagCell = enemyFlag[0] === r && enemyFlag[1] === c;
        if (cellData || isEnemyFlagCell) {
          cellEl.classList.add('cell-legal-capture');
        } else {
          cellEl.classList.add('cell-legal-move');
        }
      }

      // Render quân cờ bên trong ô
      const oldPiece = cellEl.querySelector('.piece');
      if (oldPiece) {
        cellEl.removeChild(oldPiece);
      }

      if (cellData) {
        const pieceDiv = document.createElement('div');
        pieceDiv.className = `piece ${cellData.owner === PLAYER.RED ? 'piece-red' : 'piece-blue'}`;

        const iconSpan = document.createElement('span');
        iconSpan.className = 'piece-icon';
        iconSpan.innerText = PIECE_ICONS[cellData.type] || '?';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'piece-label';
        labelSpan.innerText = cellData.type;

        pieceDiv.appendChild(iconSpan);
        pieceDiv.appendChild(labelSpan);
        pieceDiv.title = `${cellData.owner}: ${PIECE_LABELS[cellData.type]} [${r},${c}]`;

        cellEl.appendChild(pieceDiv);
      }
    }
  }
}

/**
 * Cập nhật thanh thông báo trạng thái trận đấu thực chiến (#manualStatusBanner)
 */
function setManualStatusBanner(message, bannerType = '') {
  const banner = document.getElementById('manualStatusBanner');
  if (!banner) return;
  banner.classList.remove('win-banner', 'loss-banner');
  if (bannerType) {
    banner.classList.add(bannerType);
  }
  banner.innerText = message;
}

/**
 * Xử lý khi trận đấu thực chiến kết thúc
 */
function handleManualGameOver(winner, reasonText = '') {
  ManualArenaState.isBotThinking = false;
  ManualArenaState.selectedCell = null;
  ManualArenaState.legalMovesForSelected = [];
  renderManualBoard();

  if (winner === 'DRAW') {
    const msg = `🤝 TRẬN ĐẤU KẾT THÚC HÒA! ${reasonText}`;
    setManualStatusBanner(msg);
    appendManualLog(msg, 'log-warn');
  } else if (winner === ManualArenaState.humanPlayer) {
    const msg = `🏆 CHÚC MỪNG! BẠN (${ManualArenaState.humanPlayer}) GIÀNH CHIẾN THẮNG! ${reasonText}`;
    setManualStatusBanner(msg, 'win-banner');
    appendManualLog(msg, 'log-win');
  } else {
    const msg = `💥 BOT ĐỐI THỦ (${ManualArenaState.botPlayer}) GIÀNH CHIẾN THẮNG! ${reasonText}`;
    setManualStatusBanner(msg, 'loss-banner');
    appendManualLog(msg, 'log-warn');
  }
}

/**
 * Mô tả hành động của nước đi để ghi vào Move History
 */
function describeManualMoveAction(move, captured, targetFlag) {
  if (move.to[0] === targetFlag[0] && move.to[1] === targetFlag[1]) {
    return '🚩 CƯỚP CỜ ĐỐI PHƯƠNG!';
  }
  if (captured) {
    const pName = captured.type === PIECE_TYPE.ROCK
      ? 'Búa ✊'
      : captured.type === PIECE_TYPE.PAPER
        ? 'Bao ✋'
        : 'Kéo ✌️';
    return `⚡ Ăn ${pName}`;
  }
  return 'Tiến công';
}

/**
 * Thực thi an toàn hàm `makeMove(gameState)` từ code Bot phía Client
 */
function runClientTestBot(botGameState) {
  let codeToRun = '';
  const mode = ManualArenaState.opponentMode;

  if (mode === 'striker') {
    codeToRun = SAMPLE_BOTS.striker;
  } else if (mode === 'hunter') {
    codeToRun = SAMPLE_BOTS.hunter;
  } else if (mode === 'random') {
    codeToRun = SAMPLE_BOTS.random;
  } else {
    const testCodeEl = document.getElementById('manual-test-code');
    codeToRun = testCodeEl ? testCodeEl.value : SAMPLE_BOTS.striker;
  }

  try {
    const fn = new Function(
      'gameState',
      `"use strict";\n${codeToRun}\n; if (typeof makeMove === 'function') { return makeMove(gameState); } return null;`
    );
    const resultMove = fn(botGameState);
    return { move: resultMove, error: null };
  } catch (err) {
    return { move: null, error: err.message };
  }
}

/**
 * Kích hoạt lượt đi của Bot đối thủ
 */
function triggerManualBotTurn() {
  const state = ManualArenaState.gameState;
  if (!state || state.winner || state.turn !== ManualArenaState.botPlayer) return;

  ManualArenaState.isBotThinking = true;
  setManualStatusBanner(`🤖 Bot (${ManualArenaState.botPlayer}) đang tính toán nước đi...`);
  renderManualBoard();

  if (ManualArenaState.botThinkTimer) {
    clearTimeout(ManualArenaState.botThinkTimer);
  }

  ManualArenaState.botThinkTimer = setTimeout(() => {
    const currentState = ManualArenaState.gameState;
    if (!currentState || currentState.winner) return;

    const myColor = ManualArenaState.botPlayer;
    const myFlag = myColor === PLAYER.RED ? [0, 4] : [8, 4];
    const enemyFlag = myColor === PLAYER.RED ? [8, 4] : [0, 4];
    const rawStateCopy = getGameStateForBot(currentState, myColor);

    // Chuẩn hóa đầy đủ các trường tiện ích cho hàm makeMove(gameState)
    const botStateCopy = {
      ...rawStateCopy,
      board: rawStateCopy.board || rawStateCopy.grid,
      myColor,
      myFlag: rawStateCopy.myFlag || myFlag,
      enemyFlag: rawStateCopy.enemyFlag || enemyFlag,
      legalMoves: rawStateCopy.legalMoves || getLegalMoves(currentState, myColor),
      turn: currentState.turnCount
    };

    const legalMoves = botStateCopy.legalMoves || [];

    if (legalMoves.length === 0) {
      handleManualGameOver(ManualArenaState.humanPlayer, '(Bot hết nước đi hợp lệ)');
      return;
    }

    const { move: botCandidateMove, error } = runClientTestBot(botStateCopy);
    let finalBotMove = botCandidateMove;

    if (error || !isMoveLegal(currentState, finalBotMove, ManualArenaState.botPlayer)) {
      finalBotMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
      const reason = error ? `Lỗi: ${error}` : `Nước đi không hợp lệ: ${JSON.stringify(botCandidateMove)}`;
      appendManualLog(
        `⚠️ Bot (${ManualArenaState.botPlayer}) gặp sự cố (${reason}) -> Hệ thống chọn nước hợp lệ ngẫu nhiên.`,
        'log-warn'
      );
    }

    const humanFlag = currentState.flags[ManualArenaState.humanPlayer];
    const { newState, winner, captured } = applyMove(currentState, finalBotMove, ManualArenaState.botPlayer);

    ManualArenaState.gameState = newState;
    ManualArenaState.lastMove = finalBotMove;
    ManualArenaState.isBotThinking = false;

    const actionDesc = describeManualMoveAction(finalBotMove, captured, humanFlag);
    appendManualLog(
      `Turn ${newState.turnCount}: Bot (${ManualArenaState.botPlayer}) [${finalBotMove.from[0]},${finalBotMove.from[1]}] -> [${finalBotMove.to[0]},${finalBotMove.to[1]}] (${actionDesc})`,
      'log-bot'
    );

    renderManualBoard();

    if (winner) {
      const winReason = (finalBotMove.to[0] === humanFlag[0] && finalBotMove.to[1] === humanFlag[1])
        ? '(Chiếm cờ thành công!)'
        : '';
      handleManualGameOver(winner, winReason);
      return;
    }

    setManualStatusBanner(
      `🤖 Bot vừa đi [${finalBotMove.from}] ➔ [${finalBotMove.to}] (${actionDesc}). Đến lượt bạn (${ManualArenaState.humanPlayer})!`
    );
  }, 240);
}

/**
 * Xử lý sự kiện khi Người chơi click vào ô (r, c) trên bàn cờ thực chiến
 */
function handleManualCellClick(r, c) {
  const state = ManualArenaState.gameState;
  if (!state) return;

  if (state.winner) {
    setManualStatusBanner('⚠️ Ván đấu đã kết thúc. Bấm "Bắt đầu lại (Reset Match)" để chơi ván mới!');
    return;
  }

  if (ManualArenaState.isBotThinking || state.turn !== ManualArenaState.humanPlayer) {
    setManualStatusBanner('⏳ Đang là lượt của Bot đối thủ, vui lòng chờ...');
    return;
  }

  // 1. Kiểm tra xem ô vừa click có phải là 1 ô đích hợp lệ (đang được highlight màu xanh) không
  const chosenLegalMove = ManualArenaState.legalMovesForSelected.find(
    m => m.to[0] === r && m.to[1] === c
  );

  if (chosenLegalMove) {
    // Thực hiện nước đi của Người chơi!
    const botFlag = state.flags[ManualArenaState.botPlayer];
    const { newState, winner, captured } = applyMove(state, chosenLegalMove, ManualArenaState.humanPlayer);

    ManualArenaState.gameState = newState;
    ManualArenaState.selectedCell = null;
    ManualArenaState.legalMovesForSelected = [];
    ManualArenaState.lastMove = chosenLegalMove;

    const actionDesc = describeManualMoveAction(chosenLegalMove, captured, botFlag);
    appendManualLog(
      `Turn ${newState.turnCount}: Người chơi (${ManualArenaState.humanPlayer}) [${chosenLegalMove.from[0]},${chosenLegalMove.from[1]}] -> [${chosenLegalMove.to[0]},${chosenLegalMove.to[1]}] (${actionDesc})`,
      'log-human'
    );

    renderManualBoard();

    if (winner) {
      const winReason = (chosenLegalMove.to[0] === botFlag[0] && chosenLegalMove.to[1] === botFlag[1])
        ? '(Cướp cờ đối phương!)'
        : '';
      handleManualGameOver(winner, winReason);
      return;
    }

    // Chuyển lượt sang cho Bot
    triggerManualBotTurn();
    return;
  }

  // 2. Nếu click vào quân cờ thuộc phe Người chơi -> Chọn quân cờ đó và highlight các nước đi hợp lệ
  const clickedPiece = state.grid[r][c];
  if (clickedPiece && clickedPiece.owner === ManualArenaState.humanPlayer) {
    // Nếu click lại đúng quân đang chọn thì bỏ chọn
    if (
      ManualArenaState.selectedCell &&
      ManualArenaState.selectedCell[0] === r &&
      ManualArenaState.selectedCell[1] === c
    ) {
      ManualArenaState.selectedCell = null;
      ManualArenaState.legalMovesForSelected = [];
      setManualStatusBanner('👉 Hãy click chọn 1 quân cờ của phe bạn để xem các nước đi hợp lệ (màu xanh)!');
      renderManualBoard();
      return;
    }

    ManualArenaState.selectedCell = [r, c];
    const allHumanLegalMoves = getLegalMoves(state, ManualArenaState.humanPlayer);
    ManualArenaState.legalMovesForSelected = allHumanLegalMoves.filter(
      m => m.from[0] === r && m.from[1] === c
    );

    const countMoves = ManualArenaState.legalMovesForSelected.length;
    if (countMoves > 0) {
      setManualStatusBanner(
        `✅ Đã chọn quân ${PIECE_LABELS[clickedPiece.type]} tại [${r},${c}] — Có ${countMoves} nước đi hợp lệ (ô màu xanh). Click vào ô màu xanh để đi!`
      );
    } else {
      setManualStatusBanner(
        `⚠️ Quân ${PIECE_LABELS[clickedPiece.type]} tại [${r},${c}] hiện đang bị cản, không có nước đi hợp lệ. Hãy chọn quân khác!`
      );
    }

    renderManualBoard();
    return;
  }

  // 3. Click vào ô trống không hợp lệ hoặc quân đối phương ngoài tầm ăn -> Bỏ chọn
  ManualArenaState.selectedCell = null;
  ManualArenaState.legalMovesForSelected = [];
  setManualStatusBanner('👉 Hãy click chọn 1 quân cờ thuộc phe của bạn để di chuyển!');
  renderManualBoard();
}

/**
 * Khởi động / Reset ván đấu luyện tập bằng tay
 */
function resetManualMatch() {
  if (ManualArenaState.botThinkTimer) {
    clearTimeout(ManualArenaState.botThinkTimer);
    ManualArenaState.botThinkTimer = null;
  }

  ManualArenaState.gameState = initBoard();
  ManualArenaState.selectedCell = null;
  ManualArenaState.legalMovesForSelected = [];
  ManualArenaState.lastMove = null;
  ManualArenaState.isBotThinking = false;

  // Xóa mảng lịch sử cũ khi bắt đầu ván mới
  matchMoveHistory = [];
  renderMoveHistory();

  const modeSelect = document.getElementById('manualOpponentSelect');
  const modeLabel = modeSelect
    ? modeSelect.options[modeSelect.selectedIndex]?.text || 'Custom Bot'
    : 'Custom Bot';

  appendManualLog(
    `🎮 Bắt đầu ván mới! Bạn cầm ${ManualArenaState.humanPlayer} vs Đối thủ: ${modeLabel}`,
    'log-human'
  );

  renderManualBoard();

  // Vì RED luôn đi trước theo luật chuẩn: nếu người chơi chọn cầm BLUE, Bot (RED) sẽ đi nước đầu tiên
  if (ManualArenaState.humanPlayer === PLAYER.BLUE) {
    triggerManualBotTurn();
  } else {
    setManualStatusBanner(
      '👉 Bạn cầm quân 🔴 RED (đi trước). Hãy click chọn 1 quân cờ của bạn để xem nước đi hợp lệ!'
    );
  }
}

/**
 * Đổi phe cho Người chơi (Cầm RED <-> Cầm BLUE) và bắt đầu ván mới
 */
function swapManualSide() {
  if (ManualArenaState.humanPlayer === PLAYER.RED) {
    ManualArenaState.humanPlayer = PLAYER.BLUE;
    ManualArenaState.botPlayer = PLAYER.RED;
  } else {
    ManualArenaState.humanPlayer = PLAYER.RED;
    ManualArenaState.botPlayer = PLAYER.BLUE;
  }
  resetManualMatch();
}

/**
 * Nạp code vào khung #manual-test-code và cập nhật chế độ đối thủ
 */
function loadCodeIntoManualBench(botKey) {
  const testEditor = document.getElementById('manual-test-code');
  const oppSelect = document.getElementById('manualOpponentSelect');
  const modeBadge = document.getElementById('manualBotModeBadge');
  if (!testEditor) return;

  if (botKey === 'sync') {
    const submitEditor = document.getElementById('bot-code');
    testEditor.value = submitEditor && submitEditor.value.trim()
      ? submitEditor.value
      : SAMPLE_BOTS.striker;
    ManualArenaState.opponentMode = 'custom';
    if (oppSelect) oppSelect.value = 'custom';
    if (modeBadge) modeBadge.innerText = 'Synced from Submit Tab';
  } else if (botKey === 'random') {
    testEditor.value = SAMPLE_BOTS.random;
    ManualArenaState.opponentMode = 'custom';
    if (oppSelect) oppSelect.value = 'custom';
    if (modeBadge) modeBadge.innerText = 'Sample: Random';
  } else if (botKey === 'hunter') {
    testEditor.value = SAMPLE_BOTS.hunter;
    ManualArenaState.opponentMode = 'custom';
    if (oppSelect) oppSelect.value = 'custom';
    if (modeBadge) modeBadge.innerText = 'Sample: Hunter';
  } else if (botKey === 'striker') {
    testEditor.value = SAMPLE_BOTS.striker;
    ManualArenaState.opponentMode = 'custom';
    if (oppSelect) oppSelect.value = 'custom';
    if (modeBadge) modeBadge.innerText = 'Sample: Striker';
  }
}

// ============================================================================
// KHỞI ĐỘNG ỨNG DỤNG & GẮN SỰ KIỆN DOM
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 [UI] DOMContentLoaded: Bắt đầu khởi tạo giao diện...');

  // 1. Dựng bàn cờ Replay 81 ô 1 lần duy nhất
  initBoardDOM();
  renderBoard(initBoard().grid);

  // 2. Nạp code mẫu ban đầu
  loadSampleBot('striker');

  // 2b. Khởi tạo Bàn cờ Thực Chiến (Tab 4: Chơi Bằng Tay)
  initManualBoardDOM();
  loadCodeIntoManualBench('sync');
  resetManualMatch();

  // 3. Sự kiện thay đổi dropdown Ngôn ngữ lập trình
  const langSelect = document.getElementById('languageSelect');
  if (langSelect) {
    langSelect.addEventListener('change', (e) => {
      loadLanguageTemplate(e.target.value);
    });
  }

  // 4. Sự kiện các nút nạp Bot Mẫu (Hỗ trợ cả ID mới lẫn ID cũ nếu có)
  const btnRandom = document.getElementById('btn-load-random') || document.getElementById('btnSampleRandom');
  const btnHunter = document.getElementById('btn-load-hunter') || document.getElementById('btnSampleHunter');
  const btnStriker = document.getElementById('btn-load-striker') || document.getElementById('btnSampleRusher');

  if (btnRandom) {
    btnRandom.addEventListener('click', () => loadSampleBot('random'));
  }
  if (btnHunter) {
    btnHunter.addEventListener('click', () => loadSampleBot('hunter'));
  }
  if (btnStriker) {
    btnStriker.addEventListener('click', () => loadSampleBot('striker'));
  }

  // 5. Nộp Bot
  const submitBtn = document.getElementById('submitBotBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', handleSubmitBot);
  }

  // 6. Chọn / Tạo phòng
  const roomSelect = document.getElementById('roomTypeSelect');
  const customRoomGroup = document.getElementById('customRoomGroup');
  const customRoomInput = document.getElementById('customRoomInput');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const refreshLbBtn = document.getElementById('refreshLbBtn');

  if (roomSelect) {
    roomSelect.addEventListener('change', () => {
      if (roomSelect.value === 'PUBLIC') {
        if (customRoomGroup) customRoomGroup.style.display = 'none';
        AppState.currentRoomId = 'PUBLIC';
        const badge = document.getElementById('roomBadge');
        if (badge) badge.innerText = 'Phòng: PUBLIC';
        fetchLeaderboard();
      } else {
        if (customRoomGroup) customRoomGroup.style.display = 'flex';
      }
    });
  }

  if (joinRoomBtn && customRoomInput) {
    joinRoomBtn.addEventListener('click', () => {
      const val = customRoomInput.value.trim().toUpperCase();
      if (val) {
        AppState.currentRoomId = val;
        const badge = document.getElementById('roomBadge');
        if (badge) badge.innerText = `Phòng: ${val}`;
        fetchLeaderboard();
      }
    });
  }

  if (createRoomBtn) {
    createRoomBtn.addEventListener('click', handleCreateRoom);
  }
  if (refreshLbBtn) {
    refreshLbBtn.addEventListener('click', fetchLeaderboard);
  }

  // 6. Điều khiển Replay Controls
  document.getElementById('btnPlayPause').addEventListener('click', togglePlayPause);
  document.getElementById('btnPrev').addEventListener('click', () => seekToTurn(AppState.currentTurnIndex - 1));
  document.getElementById('btnNext').addEventListener('click', () => seekToTurn(AppState.currentTurnIndex + 1));
  document.getElementById('btnFirst').addEventListener('click', () => seekToTurn(0));
  document.getElementById('btnLast').addEventListener('click', () => {
    if (AppState.currentMatch) seekToTurn(AppState.currentMatch.turns.length);
  });

  document.getElementById('turnSlider').addEventListener('input', (e) => {
    seekToTurn(parseInt(e.target.value, 10));
  });

  document.getElementById('speedSelect').addEventListener('change', (e) => {
    AppState.speedMs = parseInt(e.target.value, 10);
    if (AppState.isPlaying) {
      pauseReplay();
      playReplay();
    }
  });

  // 7. Tabs Bảng điểm & Trận gần đây (Sub-tabs trong Tab 3)
  const tabBtnLeaderboard = document.getElementById('tabBtnLeaderboard');
  const tabBtnMatches = document.getElementById('tabBtnMatches');
  const tabPaneLeaderboard = document.getElementById('tabPaneLeaderboard');
  const tabPaneMatches = document.getElementById('tabPaneMatches');

  if (tabBtnLeaderboard && tabBtnMatches && tabPaneLeaderboard && tabPaneMatches) {
    tabBtnLeaderboard.addEventListener('click', () => {
      tabBtnLeaderboard.classList.add('active');
      tabBtnMatches.classList.remove('active');
      tabPaneLeaderboard.classList.add('active');
      tabPaneMatches.classList.remove('active');
    });

    tabBtnMatches.addEventListener('click', () => {
      tabBtnMatches.classList.add('active');
      tabBtnLeaderboard.classList.remove('active');
      tabPaneMatches.classList.add('active');
      tabPaneLeaderboard.classList.remove('active');
    });
  }

  // 7b. Sự kiện cho Tab 4: Chơi Bằng Tay & Bot Test Bench
  const btnManualReset = document.getElementById('btnManualReset');
  if (btnManualReset) {
    btnManualReset.addEventListener('click', () => resetManualMatch());
  }

  const btnManualSwapSide = document.getElementById('btnManualSwapSide');
  if (btnManualSwapSide) {
    btnManualSwapSide.addEventListener('click', () => swapManualSide());
  }

  const manualOpponentSelect = document.getElementById('manualOpponentSelect');
  const manualBotModeBadge = document.getElementById('manualBotModeBadge');
  if (manualOpponentSelect) {
    manualOpponentSelect.addEventListener('change', (e) => {
      const mode = e.target.value;
      ManualArenaState.opponentMode = mode;
      const testEditor = document.getElementById('manual-test-code');
      if (mode === 'striker' && testEditor) {
        testEditor.value = SAMPLE_BOTS.striker;
        if (manualBotModeBadge) manualBotModeBadge.innerText = 'System: Striker';
      } else if (mode === 'hunter' && testEditor) {
        testEditor.value = SAMPLE_BOTS.hunter;
        if (manualBotModeBadge) manualBotModeBadge.innerText = 'System: Hunter';
      } else if (mode === 'random' && testEditor) {
        testEditor.value = SAMPLE_BOTS.random;
        if (manualBotModeBadge) manualBotModeBadge.innerText = 'System: Random';
      } else {
        if (manualBotModeBadge) manualBotModeBadge.innerText = 'Custom Code';
      }
    });
  }

  const btnManualApplyPlay = document.getElementById('btnManualApplyPlay');
  if (btnManualApplyPlay) {
    btnManualApplyPlay.addEventListener('click', () => {
      if (manualOpponentSelect) {
        ManualArenaState.opponentMode = manualOpponentSelect.value;
      }
      resetManualMatch();
    });
  }

  const btnManualSyncCode = document.getElementById('btnManualSyncCode');
  if (btnManualSyncCode) {
    btnManualSyncCode.addEventListener('click', () => loadCodeIntoManualBench('sync'));
  }

  const btnManualLoadRandom = document.getElementById('btnManualLoadRandom');
  if (btnManualLoadRandom) {
    btnManualLoadRandom.addEventListener('click', () => loadCodeIntoManualBench('random'));
  }

  const btnManualLoadHunter = document.getElementById('btnManualLoadHunter');
  if (btnManualLoadHunter) {
    btnManualLoadHunter.addEventListener('click', () => loadCodeIntoManualBench('hunter'));
  }

  const btnManualLoadStriker = document.getElementById('btnManualLoadStriker');
  if (btnManualLoadStriker) {
    btnManualLoadStriker.addEventListener('click', () => loadCodeIntoManualBench('striker'));
  }

  const btnClearManualLog = document.getElementById('btnClearManualLog');
  if (btnClearManualLog) {
    btnClearManualLog.addEventListener('click', () => {
      matchMoveHistory = [];
      renderMoveHistory();
      renderFullHistoryModal();
    });
  }

  // Mở / Đóng Modal Xem Toàn Bộ Lịch Sử (#fullHistoryModal)
  const btnViewAllLogs = document.getElementById('btn-view-all-logs');
  const fullHistoryModal = document.getElementById('fullHistoryModal');
  const btnCloseHistoryModal = document.getElementById('btnCloseHistoryModal');

  if (btnViewAllLogs && fullHistoryModal) {
    btnViewAllLogs.addEventListener('click', () => {
      renderFullHistoryModal();
      fullHistoryModal.showModal();
    });
  }

  if (btnCloseHistoryModal && fullHistoryModal) {
    btnCloseHistoryModal.addEventListener('click', () => {
      fullHistoryModal.close();
    });
  }

  // Fallback đóng Modal khi click ra ngoài vùng tối (backdrop) cho trình duyệt chưa hỗ trợ closedBy
  if (fullHistoryModal && !('closedBy' in HTMLDialogElement.prototype)) {
    fullHistoryModal.addEventListener('click', (event) => {
      if (event.target !== fullHistoryModal) return;
      const rect = fullHistoryModal.getBoundingClientRect();
      const isDialogContent = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (isDialogContent) return;
      fullHistoryModal.close();
    });
  }

  // 8. ĐIỀU HƯỚNG 4 VIEWS CHÍNH (TAB/VIEW ARCHITECTURE)
  function switchTab(viewId) {
    // Ẩn tất cả views
    document.querySelectorAll('.tab-view').forEach(view => {
      view.classList.remove('active');
    });

    // Bỏ active tất cả nav buttons
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });

    // Kích hoạt view được chọn
    const targetView = document.getElementById(viewId);
    if (targetView) {
      targetView.classList.add('active');
    }

    // Kích hoạt nav button tương ứng
    const targetNavBtn = document.querySelector(`.nav-tab-btn[data-target="${viewId}"]`);
    if (targetNavBtn) {
      targetNavBtn.classList.add('active');
    }

    // Nếu chuyển sang tab Chơi Bằng Tay và ô code test đang trống thì đồng bộ từ Tab Nộp Code
    if (viewId === 'view-manual') {
      const testEditor = document.getElementById('manual-test-code');
      if (testEditor && !testEditor.value.trim()) {
        loadCodeIntoManualBench('sync');
      }
      renderManualBoard();
    }

    console.log(`🧭 [Navigation] Chuyển sang View: ${viewId}`);
  }

  // Gắn sự kiện cho 4 nút trên Navbar
  document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetViewId = btn.dataset.target;
      switchTab(targetViewId);
    });
  });

  // Gắn sự kiện cho các nút Call-To-Action (CTA) ở Tab 1
  const btnCtaSubmit = document.getElementById('btn-cta-submit');
  if (btnCtaSubmit) {
    btnCtaSubmit.addEventListener('click', () => switchTab('view-submit'));
  }

  const btnCtaManual = document.getElementById('btn-cta-manual');
  if (btnCtaManual) {
    btnCtaManual.addEventListener('click', () => switchTab('view-manual'));
  }

  const btnCtaLeaderboard = document.getElementById('btn-cta-leaderboard');
  if (btnCtaLeaderboard) {
    btnCtaLeaderboard.addEventListener('click', () => switchTab('view-leaderboard'));
  }

  // 9. Đổi Theme Sáng / Tối
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
  if (themeToggleBtn && themeIcon) {
    themeToggleBtn.addEventListener('click', () => {
      if (AppState.theme === 'dark') {
        document.body.classList.remove('theme-dark');
        document.body.classList.add('theme-light');
        AppState.theme = 'light';
        themeIcon.innerText = '🌙';
      } else {
        document.body.classList.remove('theme-light');
        document.body.classList.add('theme-dark');
        AppState.theme = 'dark';
        themeIcon.innerText = '☀️';
      }
    });
  }

  // 10. Bắt đầu polling Live Leaderboard mỗi 2 giây
  fetchLeaderboard();
  AppState.pollingInterval = setInterval(fetchLeaderboard, 2000);
});
