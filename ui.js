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

import { initBoard, PLAYER, PIECE_TYPE, countPieces } from './boardEngine.js';
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

    // Tìm trận gần nhất có bot này tham gia để gắn nút xem replay
    const botMatch = recentMatches.find(m => m.botRed.id === item.botId || m.botBlue.id === item.botId);

    tr.innerHTML = `
      <td>${rankBadge}</td>
      <td><strong>${item.botName}</strong></td>
      <td>${item.author}</td>
      <td><strong style="color: var(--accent-gold);">${item.score}</strong></td>
      <td>${item.wins}/${item.draws}/${item.losses}</td>
      <td class="${item.errors > 0 ? 'error-badge' : ''}">${item.errors}</td>
      <td>
        ${botMatch ? `<button class="btn btn-xs btn-outline btn-watch-match" data-match-id="${botMatch.id}">Xem Replay ▶</button>` : `<span style="color:var(--text-muted)">-</span>`}
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
// KHỞI ĐỘNG ỨNG DỤNG & GẮN SỰ KIỆN DOM
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 [UI] DOMContentLoaded: Bắt đầu khởi tạo giao diện...');

  // 1. Dựng bàn cờ 81 ô 1 lần duy nhất
  initBoardDOM();
  renderBoard(initBoard().grid);

  // 2. Nạp code mẫu ban đầu
  loadSampleBot('striker');

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

  // 7. Tabs Bảng điểm & Trận gần đây
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

  // 8. Đổi Theme Sáng / Tối
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

  // 9. Bắt đầu polling Live Leaderboard mỗi 2 giây
  fetchLeaderboard();
  AppState.pollingInterval = setInterval(fetchLeaderboard, 2000);
});
