/**
 * ui.js
 * 
 * QUẢN LÝ GIAO DIỆN & ĐIỀU KHIỂN REPLAY CHO RPS ARENA 9X9
 * 
 * Các nguyên lý thiết kế:
 * 1. Hiệu năng Replay (Chống chớp nháy):
 *    - Khởi tạo 81 ô cờ DOM duy nhất 1 lần khi load trang.
 *    - Hàm `renderBoard(boardState, lastMove)`: Chỉ cập nhật class & textContent của các ô bị thay đổi,
 *      tuyệt đối KHÔNG innerHTML lại toàn bộ table/grid để đạt chuẩn 60fps.
 *    - Highlight nhẹ ô `from` và `to` của nước đi vừa thực hiện.
 * 
 * 2. Kết nối trực tiếp với:
 *    - boardEngine.js (Bàn cờ, Cờ, Luật chơi)
 *    - botRunner.js (Mẫu Bot, Sandbox runner)
 *    - tournamentEngine.js (Giải đấu, Phòng riêng, Đấu trường chung)
 */

import { initBoard, PLAYER, PIECE_TYPE, countPieces } from './boardEngine.js';
import { 
  RandomBot, 
  HunterBot, 
  GuardianAndStrikerBot,
  RANDOM_BOT_CODE, 
  HUNTER_BOT_CODE, 
  GUARDIAN_AND_STRIKER_BOT_CODE 
} from './botRunner.js';
import { runTournament, PrivateRoom, PublicArena } from './tournamentEngine.js';

// ============================================================================
// STATE QUẢN LÝ ỨNG DỤNG
// ============================================================================
const AppState = {
  currentMatch: null,         // Object match đang được Replay
  allMatches: [],             // Danh sách tất cả các trận trong giải đấu
  currentTurnIndex: 0,        // Turn hiện tại đang hiển thị
  isPlaying: false,           // Trạng thái tự động chạy Replay
  playbackTimer: null,        // Timer interval của playback
  speedMs: 400,               // Tốc độ replay (ms/turn)
  theme: 'dark',              // 'dark' | 'light'
  cellElements: [],           // Mảng tham chiếu 81 ô DOM [r][c]
  cellDataCache: []           // Cache trạng thái ô cờ để diff render (60fps)
};

// Icon biểu diễn quân cờ
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
// KHỞI TẠO BÀN CỜ 81 Ô (MỘT LẦN DUY NHẤT)
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

      // Đánh dấu ô cờ đặc biệt: RED [0,4], BLUE [8,4]
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

      // Kiểm tra có thay đổi so với cache không (Diffing)
      const isStateChanged = cached.owner !== owner || cached.type !== type;
      const isHighlightChanged = cached.isFrom !== isFrom || cached.isTo !== isTo;

      if (!isStateChanged && !isHighlightChanged) {
        continue; // Bỏ qua nếu ô không hề thay đổi
      }

      // 1. Cập nhật Highlights
      if (isHighlightChanged) {
        if (isFrom) cellEl.classList.add('move-from');
        else cellEl.classList.remove('move-from');

        if (isTo) cellEl.classList.add('move-to');
        else cellEl.classList.remove('move-to');

        cached.isFrom = isFrom;
        cached.isTo = isTo;
      }

      // 2. Cập nhật Quân cờ (Piece element)
      if (isStateChanged) {
        cached.owner = owner;
        cached.type = type;

        // Xóa quân cũ nếu có
        const oldPiece = cellEl.querySelector('.piece');
        if (oldPiece) {
          cellEl.removeChild(oldPiece);
        }

        // Tạo quân mới nếu ô có quân
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
// CẬP NHẬT GIAO DIỆN KHUNG REPLAY & THỐNG KÊ
// ============================================================================
function updateReplayUI() {
  const match = AppState.currentMatch;
  if (!match) return;

  const totalTurns = match.turns.length;
  const turnIndex = AppState.currentTurnIndex;

  // Cập nhật Slider & Labels
  const slider = document.getElementById('turnSlider');
  slider.max = totalTurns;
  slider.value = turnIndex;

  document.getElementById('lblPrevTurn').innerText = '0';
  document.getElementById('lblMaxTurn').innerText = totalTurns.toString();
  document.getElementById('turnIndicator').innerText = `Turn ${turnIndex} / ${totalTurns}`;

  // Lấy board state tại turn hiện tại
  let currentBoard = match.initialBoard;
  let lastMove = null;
  let announcerText = `Trận đấu bắt đầu: ${match.botRed.name} (RED) vs ${match.botBlue.name} (BLUE)`;

  if (turnIndex > 0 && turnIndex <= totalTurns) {
    const currentStep = match.turns[turnIndex - 1];
    currentBoard = currentStep.boardState;
    lastMove = currentStep.move;

    const playerColor = currentStep.player === PLAYER.RED ? '🔴 RED' : '🔵 BLUE';
    const moveCoord = `[${currentStep.move.from}] ➔ [${currentStep.move.to}]`;
    const captureNotice = currentStep.captured 
      ? ` ⚡ ĂN QUÂN ${currentStep.captured.type} (${currentStep.captured.owner})!` 
      : '';
    const errNotice = currentStep.isError ? ` ⚠️ (Fallback: ${currentStep.errorMsg})` : '';

    announcerText = `Nước ${turnIndex}: ${playerColor} đi ${moveCoord}${captureNotice}${errNotice}`;
  }

  // Kết thúc trận
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

  // Cập nhật số quân hiện tại
  const counts = countPieces(currentBoard);
  document.getElementById('piecesRed').innerText = `Quân: ${counts[PLAYER.RED]}`;
  document.getElementById('piecesBlue').innerText = `Quân: ${counts[PLAYER.BLUE]}`;

  // Render bàn cờ
  renderBoard(currentBoard, lastMove);
}

// ============================================================================
// ĐIỀU KHIỂN PLAYBACK (PLAY / PAUSE / STEP)
// ============================================================================
function playReplay() {
  if (!AppState.currentMatch) return;
  if (AppState.isPlaying) return;

  // Nếu đang ở cuối trận, quay lại từ đầu
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

// ============================================================================
// CHỌN & XEM TRẬN ĐẤU (SET CURRENT MATCH)
// ============================================================================
function selectMatch(match) {
  pauseReplay();
  AppState.currentMatch = match;
  AppState.currentTurnIndex = 0;

  // Cập nhật Banner tên bot
  document.getElementById('nameRed').innerText = match.botRed.name;
  document.getElementById('nameBlue').innerText = match.botBlue.name;

  // Đổi active item trong danh sách trận đấu
  document.querySelectorAll('.match-item').forEach(el => {
    if (el.dataset.matchId === match.id) el.classList.add('active');
    else el.classList.remove('active');
  });

  updateReplayUI();
}

// ============================================================================
// CẬP NHẬT BẢNG XẾP HẠNG & DANH SÁCH TRẬN ĐẤU
// ============================================================================
function updateLeaderboardUI(leaderboard) {
  const tbody = document.getElementById('leaderboardTbody');
  tbody.innerHTML = '';

  if (!leaderboard || leaderboard.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">Chưa có kết quả</td></tr>`;
    return;
  }

  leaderboard.forEach((item, index) => {
    const tr = document.createElement('tr');
    
    let rankBadge = `<span class="rank-badge">${index + 1}</span>`;
    if (index === 0) rankBadge = `<span class="rank-badge rank-1">🥇</span>`;
    else if (index === 1) rankBadge = `<span class="rank-badge rank-2">🥈</span>`;
    else if (index === 2) rankBadge = `<span class="rank-badge rank-3">🥉</span>`;

    tr.innerHTML = `
      <td>${rankBadge}</td>
      <td><strong>${item.botName}</strong></td>
      <td>${item.author}</td>
      <td><strong style="color: var(--accent-gold);">${item.score}</strong></td>
      <td>${item.wins}/${item.draws}/${item.losses}</td>
      <td class="${item.errors > 0 ? 'error-badge' : ''}">${item.errors}</td>
    `;
    tbody.appendChild(tr);
  });
}

function updateMatchesListUI(matches) {
  const container = document.getElementById('matchesList');
  container.innerHTML = '';

  document.getElementById('matchCountBadge').innerText = `${matches.length} Trận`;

  if (!matches || matches.length === 0) {
    container.innerHTML = `<div class="empty-state">Chưa có trận đấu nào.</div>`;
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
      selectMatch(m);
    });

    container.appendChild(item);
  });
}

// ============================================================================
// NỘP BOT VÀ KHỞI TRANH GIẢI ĐẤU
// ============================================================================
function handleRunTournament() {
  const botName = document.getElementById('botNameInput').value.trim() || 'MyBot';
  const author = document.getElementById('authorInput').value.trim() || 'Anonymous';
  const botCode = document.getElementById('botCodeEditor').value;
  const mode = document.getElementById('modeSelect').value;

  const statusLabel = document.querySelector('#arenaStatus .status-label');
  statusLabel.innerText = 'Đang thi đấu...';

  const userBot = {
    id: `user_bot_${Date.now()}`,
    name: botName,
    author: author,
    code: botCode
  };

  // Chuẩn bị danh sách đối thủ bot mẫu tiêu chuẩn
  const defaultBots = [
    { id: 'bot_guardian_ai', name: 'GrandGuardian AI', author: 'Champion', code: GUARDIAN_AND_STRIKER_BOT_CODE },
    { id: 'bot_hunter_ai', name: 'Predator Hunter', author: 'RPS Master', code: HUNTER_BOT_CODE },
    { id: 'bot_random_ai', name: 'Rookie Bot', author: 'Bot Academy', code: RANDOM_BOT_CODE }
  ];

  setTimeout(() => {
    try {
      let tournamentResult;

      if (mode === 'arena') {
        // Chế độ Public Arena
        const arena = new PublicArena();
        arena.submitBot(userBot);
        defaultBots.forEach(b => arena.submitBot(b));
        tournamentResult = arena.runSeason();
        AppState.allMatches = arena.matchHistory;
      } else {
        // Chế độ Phòng Riêng (Private Room)
        const room = new PrivateRoom('VIP_ARENA_1');
        room.addBot(userBot);
        defaultBots.forEach(b => room.addBot(b));
        tournamentResult = room.startTournament();
        AppState.allMatches = tournamentResult.matches;
      }

      // Cập nhật giao diện Bảng điểm & Trận đấu
      updateLeaderboardUI(tournamentResult.leaderboard);
      updateMatchesListUI(AppState.allMatches);

      // Tự động phát trận đấu đầu tiên có mặt bot của người chơi
      const userMatch = AppState.allMatches.find(
        m => m.botRed.id === userBot.id || m.botBlue.id === userBot.id
      ) || AppState.allMatches[0];

      if (userMatch) {
        selectMatch(userMatch);
      }

      statusLabel.innerText = 'Đã xong giải đấu';
    } catch (err) {
      console.error(err);
      alert('Có lỗi khi khởi tranh giải đấu: ' + err.message);
      statusLabel.innerText = 'Lỗi!';
    }
  }, 100);
}

// ============================================================================
// SỰ KIỆN NẠP CODE MẪU
// ============================================================================
function loadSampleBotCode(sampleKey) {
  const editor = document.getElementById('botCodeEditor');
  if (sampleKey === 'guardian') {
    editor.value = GUARDIAN_AND_STRIKER_BOT_CODE;
  } else if (sampleKey === 'hunter') {
    editor.value = HUNTER_BOT_CODE;
  } else {
    editor.value = RANDOM_BOT_CODE;
  }
}

// ============================================================================
// KHỞI CHẠY KHI TẢI TRANG (EVENT LISTENERS)
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  // 1. Tạo bàn cờ DOM
  initBoardDOM();
  renderBoard(initBoard().grid);

  // 2. Nạp code mẫu mặc định
  loadSampleBotCode('guardian');

  // 3. Nút Nạp code mẫu
  document.getElementById('loadSampleBtn').addEventListener('click', () => {
    const val = document.getElementById('sampleBotSelect').value;
    loadSampleBotCode(val);
  });

  // 4. Nút Nộp & Chạy Giải đấu
  document.getElementById('runTournamentBtn').addEventListener('click', handleRunTournament);

  // 5. Điều khiển Replay Controls
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

  // 6. Tabs Bảng điểm / Trận đấu
  const tabBtnLeaderboard = document.getElementById('tabBtnLeaderboard');
  const tabBtnMatches = document.getElementById('tabBtnMatches');
  const tabPaneLeaderboard = document.getElementById('tabPaneLeaderboard');
  const tabPaneMatches = document.getElementById('tabPaneMatches');

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

  // 7. Dark / Light Theme Toggle
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
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
});
