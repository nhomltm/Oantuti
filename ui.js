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
  playerId: localStorage.getItem('rps_submitted_bot_id') || `player_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
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

// State riêng cho Tab 4: Phòng Thử Nghiệm Bot (Test Bot Sandbox)
const ManualArenaState = {
  sandboxMode: 'manual_vs_bot', // 'manual_vs_bot' | 'bot_vs_bot'
  gameState: null,              // Trạng thái bàn cờ thực chiến từ initBoard()
  humanPlayer: PLAYER.RED,      // Mode 1: Phe Người Chơi | Mode 2: Phe của "Bot Của Bạn"
  botPlayer: PLAYER.BLUE,       // Mode 1: Phe "Bot Của Bạn" | Mode 2: Phe của "Bot Mẫu"
  sampleOpponentKey: 'hunter',  // 'hunter' | 'striker' | 'random' (Dùng cho Mode 2)
  selectedCell: null,           // Tọa độ [r, c] quân cờ đang được Người chơi chọn
  legalMovesForSelected: [],    // Danh sách các nước đi hợp lệ của quân đang chọn
  lastMove: null,               // Nước đi gần nhất { from: [r,c], to: [r,c] }
  isBotThinking: false,         // Khóa bàn cờ khi Bot đang suy nghĩ
  botThinkTimer: null,          // Timer tạo nhịp đi tự nhiên cho Bot ở Mode 1
  isSimRunning: false,          // Trạng thái đang chạy tự động ở Mode 2 (Bot vs Bot)
  simTimer: null,               // Interval timer cho Mode 2 (Bot vs Bot)
  simSpeedMs: 500,              // Tốc độ giữa các turn ở Mode 2 (500ms - 2000ms)
  cellElements: []              // Mảng 81 ô DOM [r][c] của bàn cờ #manualBoardGrid
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
// HỆ THỐNG XÁC THỰC & PHÂN QUYỀN (AUTH STATE & HANDLERS)
// ============================================================================

const AuthState = {
  token: localStorage.getItem('rps_auth_token') || null,
  user: JSON.parse(localStorage.getItem('rps_auth_user') || 'null')
};

const TournamentClientState = {
  tournaments: [],             // Danh sách giải đấu từ /api/tournaments
  selectedTournamentId: null,  // ID giải đấu đang chọn xem/nộp bài
  selectedStageIndex: 1,       // Vòng đấu đang xem trên Tab 3 Leaderboard
  allAdminTournaments: [],     // Danh sách tất cả giải + phòng riêng (Admin)
  // Fields chi tiết của giải đang chọn
  id: 'tournament_global_primary',
  name: 'RPS ARENA GRAND PRIX 2026',
  type: 'GLOBAL',
  isOpenForRegistration: true,
  isRegistrationOpenNow: true,
  registrationStart: null,
  registrationEnd: null,
  tournamentStart: null,
  status: 'REGISTRATION',
  stages: [],
  currentStageIndex: 1,
  prizes: [],
  isPrizeAnnounced: false,
  tournamentProgress: null,
  totalEligibleBots: 0,
  countdownTimer: null
};

// Khởi tạo Auth khi tải trang
async function initAuth() {
  if (AuthState.token) {
    try {
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${AuthState.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.user) {
          AuthState.user = data.user;
          localStorage.setItem('rps_auth_user', JSON.stringify(data.user));
        } else {
          clearAuth();
        }
      } else {
        clearAuth();
      }
    } catch (e) {
      console.warn('[Auth] Không thể xác thực token với server:', e.message);
    }
  }
  updateAuthUI();
}

function clearAuth() {
  AuthState.token = null;
  AuthState.user = null;
  localStorage.removeItem('rps_auth_token');
  localStorage.removeItem('rps_auth_user');
}

function updateAuthUI() {
  const btnOpenAuth = document.getElementById('btnOpenAuthModal');
  const loggedInBar = document.getElementById('loggedInUserBar');
  const navUsername = document.getElementById('navUsername');
  const navUserRole = document.getElementById('navUserRole');
  const tabAdmin = document.getElementById('tab-admin');
  const authorInput = document.getElementById('input-author') || document.getElementById('bot-author');
  const anonCheck = document.getElementById('anonymousCheckbox');
  const submitAuthBanner = document.getElementById('submitAuthRequiredBanner');
  const submitBtn = document.getElementById('btn-submit-bot') || document.getElementById('submitBotBtn');

  if (AuthState.user) {
    if (btnOpenAuth) btnOpenAuth.style.display = 'none';
    if (loggedInBar) loggedInBar.style.display = 'flex';
    if (navUsername) navUsername.innerText = AuthState.user.username;
    if (navUserRole) {
      navUserRole.innerText = AuthState.user.role === 'admin' ? 'Admin ⭐' : 'User';
      navUserRole.className = AuthState.user.role === 'admin' ? 'badge badge-warning' : 'badge badge-primary';
    }

    // Hiển thị Tab Admin nếu là admin
    if (tabAdmin) {
      tabAdmin.style.display = AuthState.user.role === 'admin' ? 'flex' : 'none';
    }

    // Ẩn banner yêu cầu đăng nhập trên form nộp bot & mở khóa nút Submit
    if (submitAuthBanner) {
      submitAuthBanner.style.display = 'none';
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('disabled');
    }

    if (anonCheck) {
      anonCheck.disabled = false;
    }

    // Tự động điền và khóa ô tác giả theo tài khoản đăng nhập / chế độ ẩn danh
    if (authorInput) {
      authorInput.readOnly = true;
      authorInput.disabled = false;
      if (anonCheck && anonCheck.checked) {
        authorInput.value = 'Ẩn danh (Private Player)';
        authorInput.style.opacity = '0.65';
        authorInput.style.fontStyle = 'italic';
      } else {
        authorInput.value = AuthState.user.username;
        authorInput.style.opacity = '1';
        authorInput.style.fontStyle = 'normal';
      }
    }
  } else {
    if (btnOpenAuth) btnOpenAuth.style.display = 'inline-flex';
    if (loggedInBar) loggedInBar.style.display = 'none';
    if (tabAdmin) tabAdmin.style.display = 'none';

    // Hiện banner yêu cầu đăng nhập trên form nộp bot & khóa nút Submit
    if (submitAuthBanner) {
      submitAuthBanner.style.display = 'flex';
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('disabled');
    }

    if (anonCheck) {
      anonCheck.disabled = true;
    }

    if (authorInput) {
      authorInput.readOnly = true;
      authorInput.disabled = true;
      authorInput.value = 'Chưa đăng nhập (Vui lòng đăng nhập)';
      authorInput.style.opacity = '0.5';
      authorInput.style.fontStyle = 'italic';
    }

    // Nếu đang đứng ở view-admin thì chuyển về view-guide
    const adminView = document.getElementById('view-admin');
    if (adminView && adminView.classList.contains('active')) {
      switchTab('view-guide');
    }
  }
}

function setAuthAlert(msg, type = 'error') {
  const el = document.getElementById('authAlert');
  if (!el) return;
  if (!msg) {
    el.style.display = 'none';
    el.innerText = '';
    return;
  }
  el.className = `auth-alert ${type === 'success' ? 'alert-success' : 'alert-error'}`;
  el.innerText = msg;
  el.style.display = 'block';
}

function openAuthModal(initialTab = 'login') {
  const modal = document.getElementById('authModal');
  if (!modal) return;
  setAuthAlert('');
  switchAuthTab(initialTab);
  modal.showModal();
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.close();
}

function switchAuthTab(tab) {
  const btnLogin = document.getElementById('tabAuthLogin');
  const btnReg = document.getElementById('tabAuthRegister');
  const loginForm = document.getElementById('loginForm');
  const regForm = document.getElementById('registerForm');

  if (tab === 'register') {
    if (btnLogin) btnLogin.classList.remove('active');
    if (btnReg) btnReg.classList.add('active');
    if (loginForm) loginForm.style.display = 'none';
    if (regForm) regForm.style.display = 'flex';
  } else {
    if (btnLogin) btnLogin.classList.add('active');
    if (btnReg) btnReg.classList.remove('active');
    if (loginForm) loginForm.style.display = 'flex';
    if (regForm) regForm.style.display = 'none';
  }
  setAuthAlert('');
}

async function handleLogin() {
  const userEl = document.getElementById('loginUsername');
  const passEl = document.getElementById('loginPassword');
  const username = userEl ? userEl.value.trim() : '';
  const password = passEl ? passEl.value : '';

  if (!username || !password) {
    setAuthAlert('Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.');
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      setAuthAlert(data.error || 'Đăng nhập không thành công.');
      return;
    }

    AuthState.token = data.token;
    AuthState.user = data.user;
    localStorage.setItem('rps_auth_token', data.token);
    localStorage.setItem('rps_auth_user', JSON.stringify(data.user));

    updateAuthUI();
    closeAuthModal();

    if (data.user.role === 'admin') {
      alert(`Xin chào Quản trị viên: ${data.user.username}! Bạn đã có quyền quản lý giải đấu.`);
    }
  } catch (err) {
    setAuthAlert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function handleRegister() {
  const userEl = document.getElementById('regUsername');
  const passEl = document.getElementById('regPassword');
  const confirmEl = document.getElementById('regConfirmPassword');

  const username = userEl ? userEl.value.trim() : '';
  const password = passEl ? passEl.value : '';
  const confirm = confirmEl ? confirmEl.value : '';

  if (!username || !password) {
    setAuthAlert('Vui lòng điền đầy đủ các trường.');
    return;
  }
  if (password !== confirm) {
    setAuthAlert('Mật khẩu xác nhận không trùng khớp.');
    return;
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      setAuthAlert(data.error || 'Đăng ký không thành công.');
      return;
    }

    AuthState.token = data.token;
    AuthState.user = data.user;
    localStorage.setItem('rps_auth_token', data.token);
    localStorage.setItem('rps_auth_user', JSON.stringify(data.user));

    updateAuthUI();
    closeAuthModal();
    alert(`Chào mừng ${data.user.username}! Tài khoản của bạn đã được tạo thành công.`);
  } catch (err) {
    setAuthAlert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function handleLogout() {
  if (AuthState.token) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AuthState.token}` }
      });
    } catch (e) {}
  }
  clearAuth();
  updateAuthUI();
}

// ============================================================================
// HỆ THỐNG GIẢI ĐẤU (TOURNAMENT STATUS, COUNTDOWN & ADMIN DASHBOARD)
// ============================================================================

async function fetchTournamentStatus() {
  await fetchTournamentsList();
}

async function fetchTournamentsList() {
  try {
    const res = await fetch('/api/tournaments');
    if (!res.ok) return;
    const json = await res.json();
    if (!json.success || !Array.isArray(json.tournaments)) return;

    TournamentClientState.tournaments = json.tournaments;

    // Nếu chưa chọn giải hoặc giải đã chọn không còn tồn tại -> chọn giải đầu tiên (hoặc primaryId)
    if (!TournamentClientState.selectedTournamentId || 
        !TournamentClientState.tournaments.some(t => t.id === TournamentClientState.selectedTournamentId)) {
      TournamentClientState.selectedTournamentId = json.primaryId || (json.tournaments[0]?.id) || 'tournament_global_primary';
    }

    syncSelectedTournamentDetails();
    populateTournamentDropdowns();
    updateTournamentUI();
  } catch (err) {
    console.error('[Tournament] Lỗi khi tải danh sách giải đấu:', err);
  }
}

function syncSelectedTournamentDetails() {
  const selectedTour = TournamentClientState.tournaments.find(t => t.id === TournamentClientState.selectedTournamentId)
    || TournamentClientState.tournaments[0];
  if (selectedTour) {
    Object.assign(TournamentClientState, selectedTour);
    const stages = selectedTour.stages || [];
    if (!stages.some(s => s.index === TournamentClientState.selectedStageIndex)) {
      TournamentClientState.selectedStageIndex = selectedTour.currentStageIndex || 1;
    }
  }
}

function populateTournamentDropdowns() {
  const tours = TournamentClientState.tournaments || [];
  const selectedId = TournamentClientState.selectedTournamentId;

  // Dropdown Tab 1: #guideTournamentSelect
  const guideSel = document.getElementById('guideTournamentSelect');
  if (guideSel) {
    guideSel.innerHTML = tours.map(t => `
      <option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>
        ${t.name} (${t.status === 'RUNNING' ? '⚔️ Đang đấu' : t.status === 'COMPLETED' ? '🎉 Đã kết thúc' : '🟢 Đang mở'})
      </option>
    `).join('');
  }

  // Dropdown Tab 2: #submitTournamentSelect
  const submitSel = document.getElementById('submitTournamentSelect');
  if (submitSel) {
    submitSel.innerHTML = tours.map(t => `
      <option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>
        ${t.name} (Vòng ${t.currentStageIndex || 1}/${t.stages?.length || 1})
      </option>
    `).join('');
  }

  // Dropdown Tab 3: #lbTournamentSelect
  const lbSel = document.getElementById('lbTournamentSelect');
  if (lbSel) {
    lbSel.innerHTML = tours.map(t => `
      <option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>
        ${t.name}
      </option>
    `).join('');
  }

  // Dropdown Stage Tab 3: #lbStageSelect
  populateLeaderboardStagesDropdown();
}

function populateLeaderboardStagesDropdown() {
  const selectedTour = TournamentClientState.tournaments.find(t => t.id === TournamentClientState.selectedTournamentId);
  const lbStageSel = document.getElementById('lbStageSelect');
  if (!lbStageSel) return;

  const stages = selectedTour?.stages || [{ index: 1, name: 'Vòng Bảng', status: 'RUNNING' }];
  lbStageSel.innerHTML = stages.map(s => `
    <option value="${s.index}" ${s.index === TournamentClientState.selectedStageIndex ? 'selected' : ''}>
      Vòng ${s.index}: ${s.name} (${s.status === 'COMPLETED' ? 'Hoàn thành' : s.status === 'RUNNING' ? 'Đang chạy' : 'Chưa đấu'})
    </option>
  `).join('');
}

function updateTournamentUI() {
  const ts = TournamentClientState;
  const currentTour = ts.tournaments.find(t => t.id === ts.selectedTournamentId) || ts;
  const currentStage = currentTour.stages?.find(s => s.index === currentTour.currentStageIndex) || currentTour.stages?.[0];

  // 1. Cập nhật Countdown Card ở Tab 1
  const badgeEl = document.getElementById('tournamentStatusBadge');
  const stageBadgeEl = document.getElementById('tournamentStageBadge');
  const contextTextEl = document.getElementById('countdownContextText');
  const announceBadge = document.getElementById('prizesAnnounceBadge');

  if (badgeEl) {
    if (currentTour.status === 'RUNNING') {
      badgeEl.innerText = '⚔️ Đang Thi Đấu';
      badgeEl.className = 'badge badge-warning';
    } else if (currentTour.status === 'COMPLETED') {
      badgeEl.innerText = '🎉 Đã Hoàn Thành';
      badgeEl.className = 'badge badge-success';
    } else if (currentTour.status === 'PAUSED') {
      badgeEl.innerText = '⏸ Tạm Dừng';
      badgeEl.className = 'badge badge-secondary';
    } else if (currentTour.isRegistrationOpenNow) {
      badgeEl.innerText = '🟢 Đang Mở Nộp Bài';
      badgeEl.className = 'badge badge-primary';
    } else {
      badgeEl.innerText = '🔴 Đã Khóa Nộp Bài';
      badgeEl.className = 'badge badge-danger';
    }
  }

  if (stageBadgeEl) {
    const totalStages = currentTour.stages?.length || 1;
    stageBadgeEl.innerText = `Vòng ${currentTour.currentStageIndex || 1} / ${totalStages}: ${currentStage?.name || 'Vòng Đấu'}`;
  }

  if (contextTextEl) {
    if (currentTour.status === 'RUNNING') {
      contextTextEl.innerText = `Giải đấu đang thi đấu các cặp trận Round-Robin vòng ${currentTour.currentStageIndex || 1} (${currentStage?.name || ''})!`;
    } else if (currentTour.status === 'COMPLETED') {
      contextTextEl.innerText = 'Giải đấu đã kết thúc và vinh danh những nhà vô địch!';
    } else if (currentTour.isRegistrationOpenNow) {
      contextTextEl.innerText = 'Hạn chót nộp bot: ' + (currentTour.registrationEnd ? new Date(currentTour.registrationEnd).toLocaleString('vi-VN') : 'Sắp tới');
    } else {
      contextTextEl.innerText = 'Cổng nộp bot hiện đã đóng hoặc chưa tới thời gian mở.';
    }
  }

  if (announceBadge) {
    announceBadge.innerText = currentTour.isPrizeAnnounced ? 'Đã Công Bố Giải Thưởng' : 'Đang Cập Nhật';
    announceBadge.className = currentTour.isPrizeAnnounced ? 'badge badge-success' : 'badge badge-secondary';
  }

  renderOfficialPrizes(currentTour.prizes, currentTour.isPrizeAnnounced);

  // 2. Cập nhật Tab 2: Nộp bot & Banner Khóa
  const lockBanner = document.getElementById('submissionLockBanner');
  const submitBtn = document.getElementById('btn-submit-bot') || document.getElementById('submitBotBtn');
  const regNoticeEl = document.getElementById('regTimeNotice');
  const regNoticeText = document.getElementById('regTimeNoticeText');

  const isUserAdmin = AuthState.user && AuthState.user.role === 'admin';
  const isSubmissionBlocked = !currentTour.isRegistrationOpenNow && !isUserAdmin;

  if (lockBanner) {
    lockBanner.style.display = isSubmissionBlocked ? 'flex' : 'none';
  }
  if (submitBtn) {
    if (isSubmissionBlocked) {
      submitBtn.disabled = true;
      submitBtn.title = 'Cổng nộp bot hiện đang đóng!';
    } else {
      submitBtn.disabled = false;
      submitBtn.title = '';
    }
  }

  if (regNoticeText) {
    const startStr = currentTour.registrationStart ? new Date(currentTour.registrationStart).toLocaleString('vi-VN') : 'Không giới hạn';
    const endStr = currentTour.registrationEnd ? new Date(currentTour.registrationEnd).toLocaleString('vi-VN') : 'Không giới hạn';
    const statusStr = currentTour.isRegistrationOpenNow ? '🟢 ĐANG MỞ' : '🔴 ĐÃ ĐÓNG';
    regNoticeText.innerHTML = `<strong>Thời gian nộp bot (${currentTour.name || 'Giải đấu'}):</strong> Từ <code>${startStr}</code> đến <code>${endStr}</code> &bull; Trạng thái: <strong>${statusStr}</strong>`;
  }

  // 3. Cập nhật Admin Dashboard (nếu đang là Admin)
  if (AuthState.user && AuthState.user.role === 'admin') {
    renderAdminDashboardData();
  }
}

function renderOfficialPrizes(prizesList, isAnnounced) {
  const container = document.getElementById('officialPrizesGrid');
  if (!container) return;

  const prizes = prizesList || TournamentClientState.prizes || [];
  const announced = isAnnounced !== undefined ? isAnnounced : TournamentClientState.isPrizeAnnounced;

  if (!announced || prizes.length === 0) {
    container.innerHTML = `<div class="log-empty">Ban Tổ Chức đang hoàn thiện cơ cấu giải thưởng chính thức.</div>`;
    return;
  }

  container.innerHTML = prizes.map(p => `
    <div class="official-prize-card">
      <span class="prize-badge-icon">${p.badge || '🏆'}</span>
      <div class="prize-info">
        <span class="prize-title">${p.title}</span>
        <span class="prize-reward">${p.reward || 'Chưa công bố'}</span>
      </div>
    </div>
  `).join('');
}

function startCountdownTimer() {
  if (TournamentClientState.countdownTimer) {
    clearInterval(TournamentClientState.countdownTimer);
  }

  function update() {
    const ts = TournamentClientState;
    const currentTour = ts.tournaments?.find(t => t.id === ts.selectedTournamentId) || ts;
    const now = Date.now();
    let targetTime = null;

    if (currentTour.status === 'RUNNING' || currentTour.status === 'COMPLETED') {
      setCountdownBoxes(0, 0, 0, 0);
      return;
    }

    const regEnd = currentTour.registrationEnd ? new Date(currentTour.registrationEnd).getTime() : null;
    const tourStart = currentTour.tournamentStart ? new Date(currentTour.tournamentStart).getTime() : null;

    if (currentTour.isRegistrationOpenNow && regEnd && regEnd > now) {
      targetTime = regEnd;
    } else if (tourStart && tourStart > now) {
      targetTime = tourStart;
    }

    if (!targetTime || targetTime <= now) {
      setCountdownBoxes(0, 0, 0, 0);
      return;
    }

    const diff = targetTime - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((diff / (1000 * 60)) % 60);
    const seconds = Math.floor((diff / 1000) % 60);

    setCountdownBoxes(days, hours, minutes, seconds);
  }

  function setCountdownBoxes(d, h, m, s) {
    const pad = (n) => String(n).padStart(2, '0');
    const cdDays = document.getElementById('cdDays');
    const cdHours = document.getElementById('cdHours');
    const cdMinutes = document.getElementById('cdMinutes');
    const cdSeconds = document.getElementById('cdSeconds');

    if (cdDays) cdDays.innerText = pad(d);
    if (cdHours) cdHours.innerText = pad(h);
    if (cdMinutes) cdMinutes.innerText = pad(m);
    if (cdSeconds) cdSeconds.innerText = pad(s);
  }

  update();
  TournamentClientState.countdownTimer = setInterval(update, 1000);
}

// ============================================================================
// ADMIN TOURNAMENT ENGINE (DASHBOARD, MULTI-STAGE CONTROLS & CREATOR)
// ============================================================================

async function fetchAdminAllTournaments() {
  if (!AuthState.token || AuthState.user?.role !== 'admin') return;

  try {
    const res = await fetch('/api/admin/tournaments/all', {
      headers: { 'Authorization': `Bearer ${AuthState.token}` }
    });
    if (!res.ok) return;
    const json = await res.json();
    if (!json.success || !Array.isArray(json.tournaments)) return;

    TournamentClientState.allAdminTournaments = json.tournaments;
    renderAdminTournamentsTable();
    renderAdminDashboardData();
  } catch (err) {
    console.error('[Admin] Lỗi khi tải danh sách giải đấu admin:', err);
  }
}

function renderAdminTournamentsTable() {
  const tbody = document.getElementById('adminTournamentsTableBody');
  if (!tbody) return;

  const list = TournamentClientState.allAdminTournaments || [];
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">Chưa có giải đấu hoặc phòng nào trong hệ thống.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(t => {
    const currentStage = t.stages?.find(s => s.index === t.currentStageIndex) || t.stages?.[0];
    const totalStages = t.stages?.length || 1;
    const isLastStage = (t.currentStageIndex || 1) >= totalStages;
    const topNText = currentStage?.topNToAdvance && !isLastStage ? `<br/><small class="text-muted">Top ${currentStage.topNToAdvance} thăng hạng</small>` : '';

    let statusBadge = '<span class="badge badge-primary">Mở Nộp</span>';
    if (t.status === 'RUNNING') statusBadge = '<span class="badge badge-warning">⚔️ Đang Đấu</span>';
    else if (t.status === 'COMPLETED') statusBadge = '<span class="badge badge-success">🎉 Hoàn Thành</span>';
    else if (t.status === 'PAUSED') statusBadge = '<span class="badge badge-secondary">⏸ Tạm Dừng</span>';

    const regBadge = t.isOpenForRegistration
      ? '<span class="badge badge-success">🔓 Đang Mở</span>'
      : '<span class="badge badge-danger">🔒 Đã Khóa</span>';

    const typeBadge = `<span class="tour-type-badge ${t.type === 'GLOBAL' ? 'type-global' : 'type-private'}">${t.type || 'GLOBAL'}</span>`;

    return `
      <tr data-tour-id="${t.id}">
        <td>
          <strong>${t.name}</strong>
          <br/><small class="text-muted">ID: <code>${t.id}</code></small>
        </td>
        <td>${typeBadge}</td>
        <td>
          <strong>Vòng ${t.currentStageIndex || 1}/${totalStages}:</strong> ${currentStage?.name || 'Vòng Đấu'}
          ${topNText}
        </td>
        <td style="text-align: center;"><strong>${t.bots?.length || 0}</strong></td>
        <td style="text-align: center;"><strong>${t.matchesCount || 0}</strong></td>
        <td>${statusBadge}</td>
        <td>${regBadge}</td>
        <td>
          <div class="admin-table-actions">
            <button type="button" class="btn btn-xs btn-primary btn-tour-run" data-tour-id="${t.id}" data-stage="${t.currentStageIndex || 1}" ${t.status === 'RUNNING' ? 'disabled' : ''} title="Kích hoạt chạy vòng đấu này">
              ▶ Chạy Vòng ${t.currentStageIndex || 1}
            </button>
            ${!isLastStage ? `
              <button type="button" class="btn btn-xs btn-warning btn-tour-advance" data-tour-id="${t.id}" title="Lọc Top N và chuyển sang vòng tiếp theo">
                ⚖️ Chốt & Lọc Top N
              </button>
            ` : `
              <button type="button" class="btn btn-xs btn-success btn-tour-finish" data-tour-id="${t.id}" ${t.status === 'COMPLETED' ? 'disabled' : ''} title="Kết thúc giải và vinh danh trao giải">
                🎉 Trao Giải
              </button>
            `}
            <button type="button" class="btn btn-xs btn-outline btn-tour-pause" data-tour-id="${t.id}">
              ${t.status === 'PAUSED' ? '▶ Tiếp Tục' : '⏸ Tạm Dừng'}
            </button>
            <button type="button" class="btn btn-xs btn-outline btn-tour-reg" data-tour-id="${t.id}">
              ${t.isOpenForRegistration ? '🔒 Khóa Nộp' : '🔓 Mở Nộp'}
            </button>
            <button type="button" class="btn btn-xs btn-danger btn-tour-delete" data-tour-id="${t.id}" title="Xóa giải đấu">
              🗑️
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Gắn sự kiện cho các nút hành động trong bảng
  tbody.querySelectorAll('.btn-tour-run').forEach(btn => {
    btn.addEventListener('click', () => handleAdminRunStage(btn.dataset.tourId, Number(btn.dataset.stage)));
  });
  tbody.querySelectorAll('.btn-tour-advance').forEach(btn => {
    btn.addEventListener('click', () => handleAdminAdvanceStage(btn.dataset.tourId));
  });
  tbody.querySelectorAll('.btn-tour-finish').forEach(btn => {
    btn.addEventListener('click', () => handleAdminFinishTournament(btn.dataset.tourId));
  });
  tbody.querySelectorAll('.btn-tour-pause').forEach(btn => {
    btn.addEventListener('click', () => handleAdminTogglePause(btn.dataset.tourId));
  });
  tbody.querySelectorAll('.btn-tour-reg').forEach(btn => {
    btn.addEventListener('click', () => handleAdminToggleReg(btn.dataset.tourId));
  });
  tbody.querySelectorAll('.btn-tour-delete').forEach(btn => {
    btn.addEventListener('click', () => handleAdminDeleteTournament(btn.dataset.tourId));
  });
}

async function handleAdminRunStage(tourId, stageIndex) {
  if (!AuthState.token || AuthState.user?.role !== 'admin') return;
  if (!confirm(`Bạn có chắc chắn muốn KÍCH HOẠT CHẠY VÒNG ${stageIndex} cho giải đấu này? Hệ thống sẽ đấu vòng tròn Round-Robin theo từng batch 10 trận.`)) return;

  try {
    const res = await fetch(`/api/admin/tournaments/${tourId}/start-stage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AuthState.token}`
      },
      body: JSON.stringify({ stageIndex })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(`🚀 ${data.message}`);
      if (data.progress) updateAdminProgressUI(data.progress);
      fetchAdminAllTournaments();
      fetchTournamentsList();
      fetchLeaderboard();
    } else {
      alert('Lỗi: ' + (data.error || 'Không thể bắt đầu vòng đấu.'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function handleAdminAdvanceStage(tourId) {
  if (!AuthState.token || AuthState.user?.role !== 'admin') return;
  if (!confirm('Bạn có chắc chắn muốn CHỐT KẾT QUẢ VÀ LỌC TOP N bot để thăng hạng vào vòng tiếp theo?')) return;

  try {
    const res = await fetch(`/api/admin/tournaments/${tourId}/advance-stage`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AuthState.token}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(`🎉 ${data.message}\nSố bot thăng hạng: ${data.advancedBots?.length || 0}`);
      fetchAdminAllTournaments();
      fetchTournamentsList();
      fetchLeaderboard();
    } else {
      alert('Lỗi: ' + (data.error || 'Không thể thăng hạng vòng tiếp theo.'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function handleAdminFinishTournament(tourId) {
  if (!AuthState.token || AuthState.user?.role !== 'admin') return;
  if (!confirm('Xác nhận KẾT THÚC GIẢI ĐẤU và công bố cơ cấu trao giải cho các nhà vô địch?')) return;

  try {
    const res = await fetch(`/api/admin/tournaments/${tourId}/finish`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AuthState.token}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(`🏆 ${data.message}`);
      fetchAdminAllTournaments();
      fetchTournamentsList();
      fetchLeaderboard();
    } else {
      alert('Lỗi: ' + (data.error || 'Không thể kết thúc giải đấu.'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function handleAdminTogglePause(tourId) {
  if (!AuthState.token || AuthState.user?.role !== 'admin') return;

  try {
    const res = await fetch(`/api/admin/tournaments/${tourId}/toggle-pause`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AuthState.token}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(data.message);
      fetchAdminAllTournaments();
      fetchTournamentsList();
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function handleAdminToggleReg(tourId) {
  if (!AuthState.token || AuthState.user?.role !== 'admin') return;

  try {
    const res = await fetch(`/api/admin/tournaments/${tourId}/toggle-registration`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AuthState.token}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(data.message);
      fetchAdminAllTournaments();
      fetchTournamentsList();
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

async function handleAdminDeleteTournament(tourId) {
  if (!AuthState.token || AuthState.user?.role !== 'admin') return;
  if (!confirm(`Bạn có chắc chắn muốn XÓA vĩnh viễn giải/phòng [${tourId}]? Hành động này không thể hoàn tác.`)) return;

  try {
    const res = await fetch(`/api/admin/tournaments/${tourId}/delete`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AuthState.token}` }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(`🗑️ ${data.message}`);
      fetchAdminAllTournaments();
      fetchTournamentsList();
      fetchLeaderboard();
    } else {
      alert('Lỗi: ' + (data.error || 'Không thể xóa giải đấu.'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

// Cập nhật các thẻ tóm tắt trên Admin Dashboard
function renderAdminDashboardData() {
  const ts = TournamentClientState;
  const currentTour = ts.tournaments?.find(t => t.id === ts.selectedTournamentId) || ts;

  const statBots = document.getElementById('adminStatTotalBots');
  const statStatus = document.getElementById('adminStatTourStatus');
  const statReg = document.getElementById('adminStatRegDoor');

  if (statBots) statBots.innerText = `${currentTour.bots?.length || currentTour.totalEligibleBots || 0} bot`;
  if (statStatus) statStatus.innerText = currentTour.status || 'REGISTRATION';
  if (statReg) {
    statReg.innerText = currentTour.isOpenForRegistration ? 'ĐANG MỞ' : 'ĐÃ KHÓA';
    statReg.style.color = currentTour.isOpenForRegistration ? '#4ade80' : '#f87171';
  }

  fetchAdminAutoQueueStatus();
}

async function fetchAdminAutoQueueStatus() {
  try {
    const res = await fetch('/api/admin/auto-queue');
    if (!res.ok) return;
    const json = await res.json();
    if (json.success) {
      updateAutoQueueUI(json.isAutoQueueEnabled);
    }
  } catch (e) {
    console.warn('[Admin] Lỗi lấy trạng thái Auto-Queue:', e);
  }
}

function updateAutoQueueUI(isEnabled) {
  const statEl = document.getElementById('adminStatAutoQueue');
  if (statEl) {
    statEl.innerText = isEnabled ? 'BẬT (ON)' : 'TẮT (OFF)';
    statEl.style.color = isEnabled ? '#10b981' : '#ef4444';
  }
}

async function handleAdminToggleAutoQueue() {
  if (!AuthState.token || AuthState.user?.role !== 'admin') {
    alert('Vui lòng đăng nhập tài khoản Quản trị viên (Admin)!');
    return;
  }
  try {
    const res = await fetch('/api/admin/auto-queue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AuthState.token}`
      }
    });
    const json = await res.json();
    if (json.success) {
      updateAutoQueueUI(json.isAutoQueueEnabled);
      alert(json.message);
    } else {
      alert(json.error || 'Lỗi khi cập nhật Auto-Queue');
    }
  } catch (err) {
    console.error('Lỗi toggle auto-queue:', err);
    alert('Không thể kết nối đến máy chủ.');
  }
}

async function handleAdminTriggerAutoQueue() {
  if (!AuthState.token || AuthState.user?.role !== 'admin') {
    alert('Vui lòng đăng nhập tài khoản Quản trị viên (Admin)!');
    return;
  }
  if (!confirm('Hệ thống sẽ quét toàn bộ các cặp bot chưa từng đối đầu nhau và đẩy vào hàng chờ thi đấu (Single Round-Robin C_n^2). Bạn có muốn tiếp tục?')) return;
  try {
    const res = await fetch('/api/admin/auto-queue/trigger', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AuthState.token}`
      },
      body: JSON.stringify({
        roomId: TournamentClientState.selectedRoomId || 'PUBLIC',
        tournamentId: TournamentClientState.selectedTournamentId || null
      })
    });
    const json = await res.json();
    if (json.success) {
      alert(json.message);
      fetchLeaderboard();
    } else {
      alert(json.error || 'Lỗi khi kích hoạt ghép đấu');
    }
  } catch (err) {
    console.error('Lỗi trigger unplayed matches:', err);
  }
}

function updateAdminProgressUI(progress) {
  const badge = document.getElementById('adminLiveProgressBadge') || document.getElementById('adminProgressBadge');
  const fill = document.getElementById('adminProgressBarFill');
  const percent = document.getElementById('adminProgressPercent');
  const text = document.getElementById('adminProgressText');
  const tourName = document.getElementById('adminExecTourName');
  const stageName = document.getElementById('adminExecStageName');
  const matchesText = document.getElementById('adminExecMatchesText');

  if (!progress) return;

  if (fill) fill.style.width = `${progress.percentage || 0}%`;
  if (percent) percent.innerText = `${progress.percentage || 0}%`;
  if (text) text.innerText = progress.statusText || 'Hệ thống sẵn sàng';

  if (tourName) tourName.innerText = progress.tournamentName || 'Giải Toàn Cầu';
  if (stageName) stageName.innerText = `Vòng ${progress.stageIndex || 1}: ${progress.stageName || ''}`;
  if (matchesText) matchesText.innerText = `${progress.completedMatches || 0} / ${progress.totalMatches || 0} trận`;

  if (badge) {
    if (progress.isRunning) {
      badge.innerText = 'Đang Thi Đấu...';
      badge.className = 'badge badge-warning';
    } else if (progress.percentage === 100) {
      badge.innerText = 'Hoàn Thành!';
      badge.className = 'badge badge-success';
    } else {
      badge.innerText = 'Sẵn Sàng';
      badge.className = 'badge badge-primary';
    }
  }
}

// ============================================================================
// KHỞI TẠO CẤU HÌNH VÒNG ĐẤU VÀ GIẢI THƯỞNG CHO CREATOR
// ============================================================================

function renderStagesConfig(count) {
  const container = document.getElementById('newTourStagesContainer');
  if (!container) return;

  const n = Math.min(5, Math.max(1, Number(count) || 1));
  const presets = {
    1: [{ name: 'Vòng Tròn Tính Điểm', topN: 0 }],
    2: [{ name: 'Vòng Bảng', topN: 8 }, { name: 'Chung Kết', topN: 0 }],
    3: [{ name: 'Vòng Bảng', topN: 16 }, { name: 'Bán Kết', topN: 4 }, { name: 'Chung Kết', topN: 0 }],
    4: [{ name: 'Vòng 1', topN: 32 }, { name: 'Tứ Kết', topN: 8 }, { name: 'Bán Kết', topN: 4 }, { name: 'Chung Kết', topN: 0 }],
    5: [{ name: 'Giai Đoạn 1', topN: 64 }, { name: 'Giai Đoạn 2', topN: 32 }, { name: 'Giai Đoạn 3', topN: 16 }, { name: 'Bán Kết', topN: 4 }, { name: 'Chung Kết', topN: 0 }]
  };

  const stageList = presets[n] || presets[3];

  container.innerHTML = stageList.map((s, idx) => {
    const stageNum = idx + 1;
    const isFinal = stageNum === n;

    return `
      <div class="stage-config-row" data-stage-idx="${stageNum}">
        <span class="stage-num-badge">Vòng ${stageNum}</span>
        <div class="stage-inputs">
          <input type="text" class="form-control stage-name-input" value="${s.name}" placeholder="Tên vòng..." required />
          ${isFinal ? `
            <span class="badge badge-success stage-final-badge">🏆 Vòng Chung Kết</span>
          ` : `
            <div class="topn-input-group">
              <label>Top N:</label>
              <input type="number" class="form-control stage-topn-input" value="${s.topN || 8}" min="1" max="128" />
            </div>
          `}
        </div>
      </div>
    `;
  }).join('');
}

function renderDefaultNewTourPrizes() {
  const tbody = document.getElementById('newTourPrizesTableBody');
  if (!tbody) return;

  const defaults = [
    { rank: 1, badge: '🥇', title: 'Quán Quân Grand Prix', reward: 'Cúp Vô Địch + 5.000.000 VNĐ' },
    { rank: 2, badge: '🥈', title: 'Á Quân Grand Prix', reward: 'Huy Chương Bạc + 2.000.000 VNĐ' },
    { rank: 3, badge: '🥉', title: 'Quý Quân Grand Prix', reward: 'Huy Chương Đồng + 1.000.000 VNĐ' }
  ];

  tbody.innerHTML = '';
  defaults.forEach(p => addNewTourPrizeRow(p));
}

function addNewTourPrizeRow(data = {}) {
  const tbody = document.getElementById('newTourPrizesTableBody');
  if (!tbody) return;

  const count = tbody.querySelectorAll('tr').length + 1;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="number" class="form-control prize-rank" value="${data.rank || count}" min="1" /></td>
    <td><input type="text" class="form-control prize-badge" value="${data.badge || '✨'}" style="text-align: center;" /></td>
    <td><input type="text" class="form-control prize-title" value="${data.title || `Giải Khuyến Khích ${count}`}" /></td>
    <td><input type="text" class="form-control prize-reward" value="${data.reward || ''}" placeholder="Cúp, hiện vật, tiền mặt..." /></td>
    <td style="text-align: center;">
      <button type="button" class="btn btn-xs btn-outline btn-del-prize" title="Xóa mức giải">🗑️</button>
    </td>
  `;
  tbody.appendChild(tr);

  tr.querySelector('.btn-del-prize')?.addEventListener('click', () => tr.remove());
}

async function handleCreateTournamentSubmit(e) {
  if (e) e.preventDefault();
  if (!AuthState.token || AuthState.user?.role !== 'admin') {
    alert('Vui lòng đăng nhập với quyền Admin.');
    return;
  }

  const name = document.getElementById('newTourName')?.value.trim();
  const description = document.getElementById('newTourDesc')?.value.trim();
  const regStart = document.getElementById('newTourRegStart')?.value;
  const regEnd = document.getElementById('newTourRegEnd')?.value;
  const stagesCount = Number(document.getElementById('newTourStagesCount')?.value) || 3;

  if (!name) {
    alert('Vui lòng nhập tên giải đấu!');
    return;
  }

  // Thu thập cấu hình các vòng
  const stageRows = document.querySelectorAll('#newTourStagesContainer .stage-config-row');
  const stages = [];
  stageRows.forEach((row, idx) => {
    const sIdx = idx + 1;
    const sName = row.querySelector('.stage-name-input')?.value.trim() || `Vòng ${sIdx}`;
    const topN = row.querySelector('.stage-topn-input') ? Number(row.querySelector('.stage-topn-input').value) || 0 : 0;
    stages.push({
      index: sIdx,
      name: sName,
      status: sIdx === 1 ? 'RUNNING' : 'PENDING',
      topNToAdvance: topN
    });
  });

  // Thu thập cấu hình giải thưởng
  const prizeRows = document.querySelectorAll('#newTourPrizesTableBody tr');
  const prizes = [];
  prizeRows.forEach((row, idx) => {
    const rank = Number(row.querySelector('.prize-rank')?.value) || (idx + 1);
    const badge = row.querySelector('.prize-badge')?.value || '🏆';
    const title = row.querySelector('.prize-title')?.value || `Hạng ${rank}`;
    const reward = row.querySelector('.prize-reward')?.value || '';
    prizes.push({ id: `prize_${idx + 1}`, rank, badge, title, reward });
  });

  try {
    const res = await fetch('/api/admin/tournaments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AuthState.token}`
      },
      body: JSON.stringify({
        name,
        description,
        registrationStart: regStart ? new Date(regStart).toISOString() : null,
        registrationEnd: regEnd ? new Date(regEnd).toISOString() : null,
        stagesCount,
        stages,
        prizes,
        type: 'GLOBAL'
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(`✨ Đã tạo giải đấu "${name}" thành công!`);
      document.getElementById('createTournamentForm')?.reset();
      renderStagesConfig(3);
      renderDefaultNewTourPrizes();
      fetchAdminAllTournaments();
      fetchTournamentsList();
    } else {
      alert('Lỗi: ' + (data.error || 'Không thể tạo giải đấu.'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ: ' + err.message);
  }
}

function setupSSE() {
  try {
    const eventSource = new EventSource('/api/stream');
    eventSource.addEventListener('leaderboard_updated', () => {
      fetchLeaderboard();
    });
    eventSource.addEventListener('tournament_updated', () => {
      fetchTournamentsList();
      fetchLeaderboard();
      if (AuthState.user?.role === 'admin') {
        fetchAdminAllTournaments();
      }
    });
    eventSource.addEventListener('tournament_started', (e) => {
      try {
        const prog = JSON.parse(e.data);
        updateAdminProgressUI(prog);
      } catch (err) {}
      fetchTournamentsList();
    });
    eventSource.addEventListener('tournament_progress', (e) => {
      try {
        const prog = JSON.parse(e.data);
        updateAdminProgressUI(prog);
      } catch (err) {}
    });
    eventSource.addEventListener('tournament_completed', (e) => {
      try {
        const prog = JSON.parse(e.data);
        updateAdminProgressUI(prog);
      } catch (err) {}
      fetchTournamentsList();
      fetchLeaderboard();
      if (AuthState.user?.role === 'admin') {
        fetchAdminAllTournaments();
      }
    });
    eventSource.addEventListener('auto_queue_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        updateAutoQueueUI(data.isAutoQueueEnabled);
      } catch (err) {}
    });
  } catch (e) {
    console.warn('[SSE] Không thể mở kết nối SSE:', e.message);
  }
}

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

  if (card) {
    card.classList.remove('running', 'queued');

    if (isBatchRunning) {
      card.classList.add('running');
      if (title) title.innerText = 'Đang Thi Đấu (Batch Running)...';
      if (desc) desc.innerText = `Đang mô phỏng các cặp đấu trong batch... (Hàng đợi còn: ${queueLength} bot)`;
      if (statusLabel) statusLabel.innerText = 'Đang thi đấu...';
    } else if (queueLength > 0) {
      card.classList.add('queued');
      if (title) title.innerText = 'Đang Chờ Xếp Trận (Batch)';
      if (desc) desc.innerText = `Có ${queueLength} bot trong hàng đợi chờ chạy batch kế tiếp...`;
      if (statusLabel) statusLabel.innerText = 'Chờ xếp trận';
    } else {
      if (title) title.innerText = 'Đã Cập Nhật Kết Quả';
      if (desc) desc.innerText = 'Hàng đợi trống. Các trận đấu của đợt này đã hoàn tất!';
      if (statusLabel) statusLabel.innerText = 'Sẵn sàng';
    }
  }
}

// Lấy Bảng xếp hạng và các trận đấu gần đây từ server
async function fetchLeaderboard() {
  try {
    const tourId = TournamentClientState.selectedTournamentId || '';
    const stageIdx = TournamentClientState.selectedStageIndex || 1;
    const res = await fetch(`/api/leaderboard?roomId=${encodeURIComponent(AppState.currentRoomId)}&tournamentId=${encodeURIComponent(tourId)}&stageIndex=${encodeURIComponent(stageIdx)}`);
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
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!leaderboard || leaderboard.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Chưa có bot nào tham gia</td></tr>`;
    return;
  }

  const currentTour = TournamentClientState.tournaments?.find(t => t.id === TournamentClientState.selectedTournamentId) || TournamentClientState;
  const tourPrizes = currentTour.prizes || [];
  const isPrizesAnnounced = currentTour.isPrizeAnnounced;

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

    let prizeTag = '';
    if (isPrizesAnnounced && Array.isArray(tourPrizes)) {
      const prize = tourPrizes.find(p => Number(p.rank) === (index + 1));
      if (prize) {
        let rankClass = 'lb-prize-rank-other';
        if (index === 0) rankClass = 'lb-prize-rank-1';
        else if (index === 1) rankClass = 'lb-prize-rank-2';
        else if (index === 2) rankClass = 'lb-prize-rank-3';
        prizeTag = `<span class="lb-prize-badge ${rankClass}" title="${prize.reward}">${prize.badge || '🏆'} ${prize.title}</span>`;
      }
    }

    tr.innerHTML = `
      <td>${rankBadge}</td>
      <td><strong>${displayBotName}</strong> ${prizeTag}</td>
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
  if (!AuthState.user || !AuthState.token) {
    alert('⚠️ Vui lòng Đăng Nhập hoặc Đăng Ký tài khoản để nộp bot thi đấu!');
    openAuthModal('login');
    return;
  }

  const nameEl = document.getElementById('input-bot-name') || document.getElementById('bot-name') || document.getElementById('botNameInput');
  const codeEl = document.getElementById('bot-code') || document.getElementById('botCodeEditor');
  const langEl = document.getElementById('languageSelect');
  const anonCheck = document.getElementById('anonymousCheckbox');

  const botName = nameEl ? nameEl.value.trim() : 'CyberWarrior';
  const language = langEl ? langEl.value : 'javascript';
  const botCode = codeEl ? codeEl.value.trim() : '';
  const isAnonymous = !!anonCheck?.checked;

  if (!botCode) {
    alert('Vui lòng không để trống mã nguồn bot!');
    return;
  }

  const submitBtn = document.getElementById('btn-submit-bot') || document.getElementById('submitBotBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Đang gửi lên server...';
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AuthState.token}`
    };

    const submitSel = document.getElementById('submitTournamentSelect');
    const selectedTourId = submitSel?.value || TournamentClientState.selectedTournamentId || 'tournament_global_primary';

    const res = await fetch('/api/bot/submit', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        botName: botName || 'CyberWarrior',
        language: language,
        botCode: botCode,
        isAnonymous: isAnonymous,
        roomId: AppState.currentRoomId,
        tournamentId: selectedTourId
      })
    });

    const data = await res.json();
    if (res.status === 401) {
      alert('⚠️ ' + (data.message || data.error || 'Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại!'));
      openAuthModal('login');
      return;
    }
    if (res.status === 403) {
      alert('⚠️ ' + (data.error || 'Cổng nộp bot hiện đang đóng!'));
      return;
    }
    if (data.success) {
      if (data.data?.id) {
        AppState.playerId = data.data.id;
      }
      updateQueueCard(false, data.data.queuePosition);
      fetchLeaderboard();
      console.log('✅ [UI] Nộp/cập nhật bot thành công:', data.data);
      alert('🎉 ' + (data.message || (data.isUpdate ? 'Cập nhật code bot thành công!' : 'Nộp bot thành công!')));
    } else {
      alert('Lỗi nộp bot: ' + (data.error || data.message || 'Không thể lưu bot.'));
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
  const nameEl = document.getElementById('input-bot-name') || document.getElementById('bot-name') || document.getElementById('botNameInput');
  const authorEl = document.getElementById('input-author') || document.getElementById('bot-author') || document.getElementById('playerNameInput');
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
// TAB 4: PHÒNG THỬ NGHIỆM BOT - TEST BOT SANDBOX (#view-sandbox)
// ============================================================================

// Tên hiển thị các Bot Mẫu hệ thống cho Chế độ 2 (Bot vs Bot Simulation)
const SAMPLE_OPPONENT_LABELS = {
  hunter: '[Sample] Hunter Bot',
  striker: '[Sample] Flag Rusher Bot',
  random: '[Sample] Random Bot'
};

/**
 * Lấy tên hiển thị của phe (RED hoặc BLUE) tùy theo Chế độ hiện tại:
 * - Chế độ 1 (manual_vs_bot): "Người Chơi" vs "Bot Của Bạn"
 * - Chế độ 2 (bot_vs_bot):    "Bot Của Bạn" vs "[Sample] Hunter Bot / Flag Rusher Bot / Random Bot"
 */
function getSandboxRoleName(color) {
  const isPrimarySide = color === ManualArenaState.humanPlayer;
  if (ManualArenaState.sandboxMode === 'bot_vs_bot') {
    if (isPrimarySide) return 'Bot Của Bạn';
    return SAMPLE_OPPONENT_LABELS[ManualArenaState.sampleOpponentKey] || '[Sample] Hunter Bot';
  }
  return isPrimarySide ? 'Người Chơi' : 'Bot Của Bạn';
}

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

// Mảng lưu trữ toàn bộ lịch sử nước đi của ván đấu thử nghiệm hiện tại
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
    logContainer.innerHTML = `<div class="log-empty">Chưa có nước đi nào. Hãy bắt đầu thử nghiệm!</div>`;
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
 * Cập nhật nút Play / Pause của Chế độ 2 (Bot vs Bot Simulation)
 */
function updateSimPlayButtonUI() {
  const iconEl = document.getElementById('simPlayIcon');
  const labelEl = document.getElementById('simPlayLabel');
  if (!iconEl || !labelEl) return;

  if (ManualArenaState.isSimRunning) {
    iconEl.innerText = '⏸';
    labelEl.innerText = 'Tạm Dừng (Pause)';
  } else {
    iconEl.innerText = '▶';
    labelEl.innerText = 'Bắt Đầu Tự Động Chạy';
  }
}

/**
 * Hủy toàn bộ timer / interval đang chạy của cả 2 chế độ để tránh xung đột lượt đi
 */
function stopAllSandboxTimers() {
  if (ManualArenaState.botThinkTimer) {
    clearTimeout(ManualArenaState.botThinkTimer);
    ManualArenaState.botThinkTimer = null;
  }
  if (ManualArenaState.simTimer) {
    clearInterval(ManualArenaState.simTimer);
    ManualArenaState.simTimer = null;
  }
  ManualArenaState.isBotThinking = false;
  ManualArenaState.isSimRunning = false;
  updateSimPlayButtonUI();
}

/**
 * Render bàn cờ tương tác 9x9 cùng các trạng thái highlight chọn quân & nước đi hợp lệ
 */
function renderManualBoard() {
  const state = ManualArenaState.gameState;
  if (!state || ManualArenaState.cellElements.length === 0) return;

  const { grid, turn, turnCount, winner, flags } = state;
  const isBotVsBot = ManualArenaState.sandboxMode === 'bot_vs_bot';
  const isHumanTurn = !isBotVsBot && !winner && !ManualArenaState.isBotThinking && turn === ManualArenaState.humanPlayer;

  const gridContainer = document.getElementById('manualBoardGrid');
  if (gridContainer) {
    if (isBotVsBot) {
      gridContainer.classList.add('bot-vs-bot-locked');
    } else {
      gridContainer.classList.remove('bot-vs-bot-locked');
    }
  }

  // Cập nhật thông tin 2 phe trên Banner tùy theo chế độ
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
    roleRedEl.innerText = `RED: ${getSandboxRoleName(PLAYER.RED)}`;
  }
  if (roleBlueEl) {
    roleBlueEl.innerText = `BLUE: ${getSandboxRoleName(PLAYER.BLUE)}`;
  }
  if (turnIndEl) {
    turnIndEl.innerText = `Turn ${turnCount} / ${MAX_TURNS}`;
  }
  if (swapBtnEl) {
    const sideLabel = ManualArenaState.humanPlayer === PLAYER.RED ? '🔴 RED' : '🔵 BLUE';
    const targetEntity = isBotVsBot ? 'Bot Của Bạn' : 'Bạn';
    swapBtnEl.innerHTML = `<span class="icon">🔀</span> Đổi phe (${targetEntity}: ${sideLabel})`;
  }
  if (turnBadgeEl) {
    if (winner) {
      if (winner === 'DRAW') {
        turnBadgeEl.innerText = '🤝 Kết thúc: HÒA';
      } else {
        turnBadgeEl.innerText = `🏆 Thắng: ${winner} (${getSandboxRoleName(winner)})`;
      }
    } else if (ManualArenaState.isBotThinking) {
      turnBadgeEl.innerText = `🤖 ${getSandboxRoleName(turn)} (${turn}) đang đi...`;
    } else {
      const icon = turn === PLAYER.RED ? '🔴 RED' : '🔵 BLUE';
      const who = getSandboxRoleName(turn);
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

      // Đánh dấu quân cờ của người chơi có thể click (Chỉ ở Chế độ 1: Manual vs Bot)
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
 * Xử lý khi trận đấu kết thúc (Hỗ trợ cả Chế độ 1 & Chế độ 2)
 */
function handleManualGameOver(winner, reasonText = '') {
  stopAllSandboxTimers();
  ManualArenaState.selectedCell = null;
  ManualArenaState.legalMovesForSelected = [];
  renderManualBoard();

  if (winner === 'DRAW') {
    const msg = `🤝 TRẬN ĐẤU KẾT THÚC HÒA! ${reasonText}`;
    setManualStatusBanner(msg);
    appendManualLog(msg, 'log-warn');
    return;
  }

  const winnerRole = getSandboxRoleName(winner);
  if (winner === ManualArenaState.humanPlayer) {
    const msg = `🏆 CHIẾN THẮNG! ${winnerRole.toUpperCase()} (${winner}) GIÀNH PHẦN THẮNG! ${reasonText}`;
    setManualStatusBanner(msg, 'win-banner');
    appendManualLog(msg, 'log-win');
  } else {
    const msg = `💥 KẾT THÚC! ${winnerRole.toUpperCase()} (${winner}) GIÀNH CHIẾN THẮNG! ${reasonText}`;
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
 * Chuẩn hóa đối tượng gameState đầy đủ cho hàm makeMove(gameState)
 */
function buildNormalizedBotState(currentState, myColor) {
  const myFlag = myColor === PLAYER.RED ? [0, 4] : [8, 4];
  const enemyFlag = myColor === PLAYER.RED ? [8, 4] : [0, 4];
  const rawStateCopy = getGameStateForBot(currentState, myColor);

  return {
    ...rawStateCopy,
    board: rawStateCopy.board || rawStateCopy.grid,
    myColor,
    myFlag: rawStateCopy.myFlag || myFlag,
    enemyFlag: rawStateCopy.enemyFlag || enemyFlag,
    legalMoves: rawStateCopy.legalMoves || getLegalMoves(currentState, myColor),
    turn: currentState.turnCount
  };
}

/**
 * Thực thi an toàn chuỗi code JavaScript có chứa `makeMove(gameState)` phía Client
 */
function executeBotCodeString(codeToRun, botGameState) {
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
 * Lấy code của "Bot Của Bạn" đang nằm trong khung #manual-test-code
 */
function getUserBotCodeFromEditor() {
  const testCodeEl = document.getElementById('manual-test-code');
  return testCodeEl && testCodeEl.value.trim() ? testCodeEl.value : SAMPLE_BOTS.striker;
}

/**
 * Kích hoạt lượt đi của "Bot Của Bạn" trong Chế độ 1 (Chơi Bằng Tay vs Bot)
 */
function triggerManualBotTurn() {
  if (ManualArenaState.sandboxMode !== 'manual_vs_bot') return;

  const state = ManualArenaState.gameState;
  if (!state || state.winner || state.turn !== ManualArenaState.botPlayer) return;

  ManualArenaState.isBotThinking = true;
  setManualStatusBanner(`🤖 Bot Của Bạn (${ManualArenaState.botPlayer}) đang tính toán nước đi...`);
  renderManualBoard();

  if (ManualArenaState.botThinkTimer) {
    clearTimeout(ManualArenaState.botThinkTimer);
  }

  ManualArenaState.botThinkTimer = setTimeout(() => {
    const currentState = ManualArenaState.gameState;
    if (!currentState || currentState.winner || ManualArenaState.sandboxMode !== 'manual_vs_bot') return;

    const myColor = ManualArenaState.botPlayer;
    const botStateCopy = buildNormalizedBotState(currentState, myColor);
    const legalMoves = botStateCopy.legalMoves || [];

    if (legalMoves.length === 0) {
      handleManualGameOver(ManualArenaState.humanPlayer, '(Bot Của Bạn hết nước đi hợp lệ)');
      return;
    }

    const userCode = getUserBotCodeFromEditor();
    const { move: botCandidateMove, error } = executeBotCodeString(userCode, botStateCopy);
    let finalBotMove = botCandidateMove;

    if (error || !isMoveLegal(currentState, finalBotMove, myColor)) {
      finalBotMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
      const reason = error ? `Lỗi: ${error}` : `Nước đi không hợp lệ: ${JSON.stringify(botCandidateMove)}`;
      appendManualLog(
        `⚠️ Bot Của Bạn (${myColor}) gặp sự cố (${reason}) -> Hệ thống chọn nước hợp lệ ngẫu nhiên.`,
        'log-warn'
      );
    }

    const humanFlag = currentState.flags[ManualArenaState.humanPlayer];
    const { newState, winner, captured } = applyMove(currentState, finalBotMove, myColor);

    ManualArenaState.gameState = newState;
    ManualArenaState.lastMove = finalBotMove;
    ManualArenaState.isBotThinking = false;

    const actionDesc = describeManualMoveAction(finalBotMove, captured, humanFlag);
    appendManualLog(
      `Turn ${newState.turnCount}: Bot Của Bạn (${myColor}) [${finalBotMove.from[0]},${finalBotMove.from[1]}] -> [${finalBotMove.to[0]},${finalBotMove.to[1]}] (${actionDesc})`,
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
      `🤖 Bot Của Bạn vừa đi [${finalBotMove.from}] ➔ [${finalBotMove.to}] (${actionDesc}). Đến lượt Người Chơi (${ManualArenaState.humanPlayer})!`
    );
  }, 240);
}

// ============================================================================
// CHẾ ĐỘ 2: BOT MẪU VS BOT CỦA BẠN (BOT VS BOT SIMULATION)
// ============================================================================

/**
 * Thực thi đúng 1 nước đi (1 Turn) trong Chế độ 2 (Bot Mẫu vs Bot Của Bạn)
 */
function stepBotVsBotTurn() {
  if (ManualArenaState.sandboxMode !== 'bot_vs_bot') return;

  const currentState = ManualArenaState.gameState;
  if (!currentState) return;

  if (currentState.winner) {
    pauseBotVsBotSimulation();
    setManualStatusBanner('⚠️ Ván đấu đã kết thúc. Bấm "Bắt đầu lại (Reset)" để chạy ván mới!');
    return;
  }

  const actingColor = currentState.turn;
  const opponentColor = actingColor === PLAYER.RED ? PLAYER.BLUE : PLAYER.RED;
  const isUserBotTurn = actingColor === ManualArenaState.humanPlayer;
  const actorName = getSandboxRoleName(actingColor);

  const botStateCopy = buildNormalizedBotState(currentState, actingColor);
  const legalMoves = botStateCopy.legalMoves || [];

  if (legalMoves.length === 0) {
    handleManualGameOver(opponentColor, `(${actorName} hết nước đi hợp lệ)`);
    return;
  }

  const codeToRun = isUserBotTurn
    ? getUserBotCodeFromEditor()
    : (SAMPLE_BOTS[ManualArenaState.sampleOpponentKey] || SAMPLE_BOTS.hunter);

  const { move: candidateMove, error } = executeBotCodeString(codeToRun, botStateCopy);
  let finalMove = candidateMove;

  if (error || !isMoveLegal(currentState, finalMove, actingColor)) {
    finalMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
    const reason = error ? `Lỗi: ${error}` : `Nước đi không hợp lệ: ${JSON.stringify(candidateMove)}`;
    appendManualLog(
      `⚠️ ${actorName} (${actingColor}) gặp sự cố (${reason}) -> Hệ thống chọn nước hợp lệ ngẫu nhiên.`,
      'log-warn'
    );
  }

  const targetFlag = currentState.flags[opponentColor];
  const { newState, winner, captured } = applyMove(currentState, finalMove, actingColor);

  ManualArenaState.gameState = newState;
  ManualArenaState.lastMove = finalMove;

  const actionDesc = describeManualMoveAction(finalMove, captured, targetFlag);
  appendManualLog(
    `Turn ${newState.turnCount}: ${actorName} (${actingColor}) [${finalMove.from[0]},${finalMove.from[1]}] -> [${finalMove.to[0]},${finalMove.to[1]}] (${actionDesc})`,
    isUserBotTurn ? 'log-human' : 'log-bot'
  );

  renderManualBoard();

  if (winner) {
    const winReason = (finalMove.to[0] === targetFlag[0] && finalMove.to[1] === targetFlag[1])
      ? '(Chiếm cờ thành công!)'
      : '';
    handleManualGameOver(winner, winReason);
    return;
  }

  const nextActor = getSandboxRoleName(newState.turn);
  setManualStatusBanner(
    `🤖 Turn ${newState.turnCount}: ${actorName} (${actingColor}) đi [${finalMove.from}] ➔ [${finalMove.to}] (${actionDesc}) • Tiếp theo: ${nextActor} (${newState.turn})`
  );
}

/**
 * Bắt đầu tự động chạy mô phỏng Bot vs Bot
 */
function startBotVsBotSimulation() {
  if (ManualArenaState.sandboxMode !== 'bot_vs_bot') return;

  // Nếu ván đấu đã kết thúc mà người dùng bấm chạy lại, tự động reset bàn cờ mới
  if (!ManualArenaState.gameState || ManualArenaState.gameState.winner) {
    resetManualMatch();
  }

  if (ManualArenaState.simTimer) {
    clearInterval(ManualArenaState.simTimer);
  }

  ManualArenaState.isSimRunning = true;
  updateSimPlayButtonUI();
  renderManualBoard();

  // Thực thi ngay 1 bước đầu tiên rồi tiếp tục theo chu kỳ simSpeedMs
  stepBotVsBotTurn();

  if (ManualArenaState.gameState && !ManualArenaState.gameState.winner) {
    ManualArenaState.simTimer = setInterval(() => {
      if (!ManualArenaState.isSimRunning || ManualArenaState.sandboxMode !== 'bot_vs_bot') {
        pauseBotVsBotSimulation();
        return;
      }
      stepBotVsBotTurn();
    }, ManualArenaState.simSpeedMs);
  }
}

/**
 * Tạm dừng mô phỏng Bot vs Bot
 */
function pauseBotVsBotSimulation() {
  if (ManualArenaState.simTimer) {
    clearInterval(ManualArenaState.simTimer);
    ManualArenaState.simTimer = null;
  }
  ManualArenaState.isSimRunning = false;
  updateSimPlayButtonUI();
  renderManualBoard();
}

/**
 * Đảo trạng thái Chạy Tự Động / Tạm Dừng ở Chế độ 2
 */
function toggleBotVsBotSimulation() {
  if (ManualArenaState.isSimRunning) {
    pauseBotVsBotSimulation();
    setManualStatusBanner('⏸ Đã tạm dừng mô phỏng. Bấm [▶ Bắt Đầu Tự Động Chạy] để tiếp tục hoặc [⏭ Từng Nước Đi]!');
  } else {
    startBotVsBotSimulation();
  }
}

/**
 * Chuyển đổi giữa Chế độ 1 (Chơi Bằng Tay vs Bot) và Chế độ 2 (Bot Mẫu vs Bot Của Bạn)
 */
function setSandboxMode(mode) {
  if (mode !== 'manual_vs_bot' && mode !== 'bot_vs_bot') return;

  ManualArenaState.sandboxMode = mode;
  const isBotVsBot = mode === 'bot_vs_bot';

  const btnMode1 = document.getElementById('modeBtnManualVsBot');
  const btnMode2 = document.getElementById('modeBtnBotVsBot');
  const botVsBotControls = document.getElementById('botVsBotControls');
  const botVsBotOppGroup = document.getElementById('botVsBotOpponentGroup');

  if (btnMode1) btnMode1.classList.toggle('active', !isBotVsBot);
  if (btnMode2) btnMode2.classList.toggle('active', isBotVsBot);
  if (botVsBotControls) botVsBotControls.style.display = isBotVsBot ? 'flex' : 'none';
  if (botVsBotOppGroup) botVsBotOppGroup.style.display = isBotVsBot ? 'flex' : 'none';

  resetManualMatch();
}

/**
 * Xử lý sự kiện khi Người chơi click vào ô (r, c) trên bàn cờ thực chiến
 */
function handleManualCellClick(r, c) {
  // Vô hiệu hóa thao tác click quân cờ bằng tay khi ở Chế độ 2 (Bot vs Bot)
  if (ManualArenaState.sandboxMode === 'bot_vs_bot') {
    setManualStatusBanner(
      '🤖 Đang ở Chế độ 2 (Bot Mẫu vs Bot Của Bạn). Hãy dùng nút [▶ Bắt Đầu Tự Động Chạy] hoặc [⏭ Từng Nước Đi] bên dưới!'
    );
    return;
  }

  const state = ManualArenaState.gameState;
  if (!state) return;

  if (state.winner) {
    setManualStatusBanner('⚠️ Ván đấu đã kết thúc. Bấm "Bắt đầu lại (Reset)" để chơi ván mới!');
    return;
  }

  if (ManualArenaState.isBotThinking || state.turn !== ManualArenaState.humanPlayer) {
    setManualStatusBanner('⏳ Đang là lượt của Bot Của Bạn, vui lòng chờ...');
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
      `Turn ${newState.turnCount}: Người Chơi (${ManualArenaState.humanPlayer}) [${chosenLegalMove.from[0]},${chosenLegalMove.from[1]}] -> [${chosenLegalMove.to[0]},${chosenLegalMove.to[1]}] (${actionDesc})`,
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

    // Chuyển lượt sang cho Bot Của Bạn
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
 * Khởi động / Reset ván đấu trong Phòng Thử Nghiệm Bot (Hủy mọi timer đang chạy)
 */
function resetManualMatch() {
  stopAllSandboxTimers();

  ManualArenaState.gameState = initBoard();
  ManualArenaState.selectedCell = null;
  ManualArenaState.legalMovesForSelected = [];
  ManualArenaState.lastMove = null;

  // Xóa mảng lịch sử cũ khi bắt đầu ván mới
  matchMoveHistory = [];
  renderMoveHistory();

  const redRole = getSandboxRoleName(PLAYER.RED);
  const blueRole = getSandboxRoleName(PLAYER.BLUE);

  appendManualLog(
    `🧪 Bắt đầu ván mới! RED: ${redRole} vs BLUE: ${blueRole}`,
    'log-human'
  );

  renderManualBoard();

  if (ManualArenaState.sandboxMode === 'bot_vs_bot') {
    setManualStatusBanner(
      `🤖 Sẵn sàng mô phỏng: RED (${redRole}) vs BLUE (${blueRole}). Bấm [▶ Bắt Đầu Tự Động Chạy] hoặc [⏭ Từng Nước Đi]!`
    );
    return;
  }

  // Chế độ 1 (Manual vs Bot): RED luôn đi trước. Nếu người chơi cầm BLUE, Bot (RED) sẽ đi nước đầu tiên
  if (ManualArenaState.humanPlayer === PLAYER.BLUE) {
    triggerManualBotTurn();
  } else {
    setManualStatusBanner(
      '👉 Bạn cầm quân 🔴 RED (đi trước). Hãy click chọn 1 quân cờ của bạn để xem nước đi hợp lệ!'
    );
  }
}

/**
 * Đổi phe (RED <-> BLUE) và bắt đầu ván mới
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
 * Nạp code vào khung #manual-test-code
 */
function loadCodeIntoManualBench(botKey) {
  const testEditor = document.getElementById('manual-test-code');
  const modeBadge = document.getElementById('manualBotModeBadge');
  if (!testEditor) return;

  if (botKey === 'sync') {
    const submitEditor = document.getElementById('bot-code');
    testEditor.value = submitEditor && submitEditor.value.trim()
      ? submitEditor.value
      : SAMPLE_BOTS.striker;
    if (modeBadge) modeBadge.innerText = 'Bot Của Bạn (Synced)';
  } else if (botKey === 'random') {
    testEditor.value = SAMPLE_BOTS.random;
    if (modeBadge) modeBadge.innerText = 'Bot Của Bạn (Mẫu Random)';
  } else if (botKey === 'hunter') {
    testEditor.value = SAMPLE_BOTS.hunter;
    if (modeBadge) modeBadge.innerText = 'Bot Của Bạn (Mẫu Hunter)';
  } else if (botKey === 'striker') {
    testEditor.value = SAMPLE_BOTS.striker;
    if (modeBadge) modeBadge.innerText = 'Bot Của Bạn (Mẫu Striker)';
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

  // 2b. Khởi tạo Phòng Thử Nghiệm Bot (Tab 4: #view-sandbox)
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
  const submitBtn = document.getElementById('btn-submit-bot') || document.getElementById('submitBotBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', handleSubmitBot);
  }

  // Nút mở Login từ banner yêu cầu đăng nhập ở Form nộp bot
  const btnOpenLoginFromSubmit = document.getElementById('btnOpenLoginFromSubmit');
  if (btnOpenLoginFromSubmit) {
    btnOpenLoginFromSubmit.addEventListener('click', () => openAuthModal('login'));
  }

  // Toggle Checkbox Ẩn danh
  const anonCheck = document.getElementById('anonymousCheckbox');
  if (anonCheck) {
    anonCheck.addEventListener('change', () => {
      const authorInput = document.getElementById('input-author') || document.getElementById('bot-author');
      if (!authorInput) return;
      if (!AuthState.user) {
        authorInput.value = 'Chưa đăng nhập (Vui lòng đăng nhập)';
        return;
      }
      if (anonCheck.checked) {
        authorInput.value = 'Ẩn danh (Private Player)';
        authorInput.style.opacity = '0.65';
        authorInput.style.fontStyle = 'italic';
      } else {
        authorInput.value = AuthState.user.username;
        authorInput.style.opacity = '1';
        authorInput.style.fontStyle = 'normal';
      }
    });
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

  // 7b. Sự kiện cho Tab 4: Phòng Thử Nghiệm Bot (Test Bot Sandbox)
  const modeBtnManualVsBot = document.getElementById('modeBtnManualVsBot');
  const modeBtnBotVsBot = document.getElementById('modeBtnBotVsBot');

  if (modeBtnManualVsBot) {
    modeBtnManualVsBot.addEventListener('click', () => setSandboxMode('manual_vs_bot'));
  }
  if (modeBtnBotVsBot) {
    modeBtnBotVsBot.addEventListener('click', () => setSandboxMode('bot_vs_bot'));
  }

  const sandboxOpponentSelect = document.getElementById('sandboxOpponentSelect');
  if (sandboxOpponentSelect) {
    sandboxOpponentSelect.addEventListener('change', (e) => {
      ManualArenaState.sampleOpponentKey = e.target.value;
      resetManualMatch();
    });
  }

  const btnSimPlayPause = document.getElementById('btnSimPlayPause');
  if (btnSimPlayPause) {
    btnSimPlayPause.addEventListener('click', () => toggleBotVsBotSimulation());
  }

  const btnSimStepNext = document.getElementById('btnSimStepNext');
  if (btnSimStepNext) {
    btnSimStepNext.addEventListener('click', () => {
      pauseBotVsBotSimulation();
      stepBotVsBotTurn();
    });
  }

  const simSpeedRange = document.getElementById('simSpeedRange');
  const simSpeedLabel = document.getElementById('simSpeedLabel');
  if (simSpeedRange) {
    simSpeedRange.addEventListener('input', (e) => {
      const ms = parseInt(e.target.value, 10) || 500;
      ManualArenaState.simSpeedMs = ms;
      if (simSpeedLabel) {
        simSpeedLabel.innerText = `${(ms / 1000).toFixed(1)}s / turn`;
      }
      // Nếu đang tự động chạy thì cập nhật lại interval ngay lập tức
      if (ManualArenaState.isSimRunning) {
        if (ManualArenaState.simTimer) clearInterval(ManualArenaState.simTimer);
        ManualArenaState.simTimer = setInterval(() => {
          if (!ManualArenaState.isSimRunning || ManualArenaState.sandboxMode !== 'bot_vs_bot') {
            pauseBotVsBotSimulation();
            return;
          }
          stepBotVsBotTurn();
        }, ManualArenaState.simSpeedMs);
      }
    });
  }

  const btnManualReset = document.getElementById('btnManualReset');
  if (btnManualReset) {
    btnManualReset.addEventListener('click', () => resetManualMatch());
  }

  const btnManualSwapSide = document.getElementById('btnManualSwapSide');
  if (btnManualSwapSide) {
    btnManualSwapSide.addEventListener('click', () => swapManualSide());
  }

  const btnManualApplyPlay = document.getElementById('btnManualApplyPlay');
  if (btnManualApplyPlay) {
    btnManualApplyPlay.addEventListener('click', () => {
      if (sandboxOpponentSelect) {
        ManualArenaState.sampleOpponentKey = sandboxOpponentSelect.value;
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

  // 8. ĐIỀU HƯỚNG CÁC VIEWS (TAB/VIEW ARCHITECTURE)
  function switchTab(viewId) {
    // Kiểm tra quyền truy cập nếu là Tab Quản Trị
    if (viewId === 'view-admin') {
      if (!AuthState.user || AuthState.user.role !== 'admin') {
        alert('⚠️ Bạn không có quyền truy cập trang Quản Trị Giải Đấu! Vui lòng đăng nhập với tài khoản Admin.');
        switchTab('view-guide');
        return;
      }
      renderAdminDashboardData();
      fetchAdminAllTournaments();
    }

    // Tạm dừng mô phỏng Bot vs Bot nếu rời khỏi tab Sandbox
    if (viewId !== 'view-sandbox' && ManualArenaState.isSimRunning) {
      pauseBotVsBotSimulation();
    }

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

    // Nếu chuyển sang tab Phòng Thử Nghiệm Bot và ô code test đang trống thì đồng bộ từ Tab Nộp Code
    if (viewId === 'view-sandbox') {
      const testEditor = document.getElementById('manual-test-code');
      if (testEditor && !testEditor.value.trim()) {
        loadCodeIntoManualBench('sync');
      }
      renderManualBoard();
    }

    // Nếu chuyển sang tab Nộp Code Bot, cập nhật giao diện Auth & Banner
    if (viewId === 'view-submit') {
      updateAuthUI();
    }

    console.log(`🧭 [Navigation] Chuyển sang View: ${viewId}`);
  }

  // Gắn sự kiện cho các nút trên Navbar
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

  const btnCtaSandbox = document.getElementById('btn-cta-sandbox') || document.getElementById('btn-cta-manual');
  if (btnCtaSandbox) {
    btnCtaSandbox.addEventListener('click', () => switchTab('view-sandbox'));
  }

  const btnCtaLeaderboard = document.getElementById('btn-cta-leaderboard');
  if (btnCtaLeaderboard) {
    btnCtaLeaderboard.addEventListener('click', () => switchTab('view-leaderboard'));
  }

  // 9. Đổi Theme Sáng / Tối (Hỗ trợ toàn bộ class theme tương phản cao)
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
  if (themeToggleBtn && themeIcon) {
    themeToggleBtn.addEventListener('click', () => {
      if (AppState.theme === 'dark') {
        document.body.classList.remove('theme-dark');
        document.body.classList.add('theme-light', 'light-theme', 'light-mode');
        AppState.theme = 'light';
        themeIcon.innerText = '🌙';
      } else {
        document.body.classList.remove('theme-light', 'light-theme', 'light-mode');
        document.body.classList.add('theme-dark');
        AppState.theme = 'dark';
        themeIcon.innerText = '☀️';
      }
    });
  }

  // 10. Gắn sự kiện Auth Modal (Đăng nhập / Đăng ký / Đăng xuất)
  const btnOpenAuth = document.getElementById('btnOpenAuthModal');
  const btnCloseAuth = document.getElementById('btnCloseAuthModal');
  const authModal = document.getElementById('authModal');
  const tabAuthLogin = document.getElementById('tabAuthLogin');
  const tabAuthRegister = document.getElementById('tabAuthRegister');
  const btnLoginSubmit = document.getElementById('btnLoginSubmit');
  const btnRegisterSubmit = document.getElementById('btnRegisterSubmit');
  const btnLogout = document.getElementById('btnLogout');

  if (btnOpenAuth) btnOpenAuth.addEventListener('click', openAuthModal);
  if (btnCloseAuth) btnCloseAuth.addEventListener('click', closeAuthModal);
  if (tabAuthLogin) tabAuthLogin.addEventListener('click', () => switchAuthTab('login'));
  if (tabAuthRegister) tabAuthRegister.addEventListener('click', () => switchAuthTab('register'));
  if (btnLoginSubmit) btnLoginSubmit.addEventListener('click', handleLogin);
  if (btnRegisterSubmit) btnRegisterSubmit.addEventListener('click', handleRegister);
  if (btnLogout) btnLogout.addEventListener('click', handleLogout);

  const loginPass = document.getElementById('loginPassword');
  if (loginPass) {
    loginPass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLogin();
    });
  }
  const regPass = document.getElementById('registerPassword');
  if (regPass) {
    regPass.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleRegister();
    });
  }

  if (authModal && !('closedBy' in HTMLDialogElement.prototype)) {
    authModal.addEventListener('click', (event) => {
      if (event.target !== authModal) return;
      const rect = authModal.getBoundingClientRect();
      const isDialogContent = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (isDialogContent) return;
      closeAuthModal();
    });
  }

  // 11. Gắn sự kiện Dropdowns Chọn Giải Đấu & Vòng Đấu (Tab 1, Tab 2, Tab 3)
  const guideTourSel = document.getElementById('guideTournamentSelect');
  if (guideTourSel) {
    guideTourSel.addEventListener('change', () => {
      TournamentClientState.selectedTournamentId = guideTourSel.value;
      syncSelectedTournamentDetails();
      populateTournamentDropdowns();
      updateTournamentUI();
      fetchLeaderboard();
    });
  }

  const submitTourSel = document.getElementById('submitTournamentSelect');
  if (submitTourSel) {
    submitTourSel.addEventListener('change', () => {
      TournamentClientState.selectedTournamentId = submitTourSel.value;
      syncSelectedTournamentDetails();
      populateTournamentDropdowns();
      updateTournamentUI();
    });
  }

  const lbTourSel = document.getElementById('lbTournamentSelect');
  if (lbTourSel) {
    lbTourSel.addEventListener('change', () => {
      TournamentClientState.selectedTournamentId = lbTourSel.value;
      syncSelectedTournamentDetails();
      populateTournamentDropdowns();
      updateTournamentUI();
      fetchLeaderboard();
    });
  }

  const lbStageSel = document.getElementById('lbStageSelect');
  if (lbStageSel) {
    lbStageSel.addEventListener('change', () => {
      TournamentClientState.selectedStageIndex = Number(lbStageSel.value) || 1;
      fetchLeaderboard();
    });
  }

  // 12. Gắn sự kiện Admin Multi-Stage Dashboard (#view-admin)
  const btnAdminRefreshTournaments = document.getElementById('btnAdminRefreshTournaments');
  if (btnAdminRefreshTournaments) {
    btnAdminRefreshTournaments.addEventListener('click', () => {
      fetchAdminAllTournaments();
      fetchTournamentsList();
    });
  }

  const newTourStagesCount = document.getElementById('newTourStagesCount');
  if (newTourStagesCount) {
    newTourStagesCount.addEventListener('change', () => {
      renderStagesConfig(newTourStagesCount.value);
    });
  }

  const btnAdminAddPrizeRowNewTour = document.getElementById('btnAdminAddPrizeRowNewTour');
  if (btnAdminAddPrizeRowNewTour) {
    btnAdminAddPrizeRowNewTour.addEventListener('click', () => addNewTourPrizeRow());
  }

  const createTournamentForm = document.getElementById('createTournamentForm');
  if (createTournamentForm) {
    createTournamentForm.addEventListener('submit', handleCreateTournamentSubmit);
  }

  const btnAdminToggleAutoQueue = document.getElementById('btnAdminToggleAutoQueue');
  if (btnAdminToggleAutoQueue) {
    btnAdminToggleAutoQueue.addEventListener('click', handleAdminToggleAutoQueue);
  }

  const btnAdminTriggerAutoQueue = document.getElementById('btnAdminTriggerAutoQueue');
  if (btnAdminTriggerAutoQueue) {
    btnAdminTriggerAutoQueue.addEventListener('click', handleAdminTriggerAutoQueue);
  }

  // Khởi tạo các cấu hình mặc định cho Form tạo giải đấu mới
  renderStagesConfig(3);
  renderDefaultNewTourPrizes();

  // 13. Khởi tạo xác thực, cấu hình giải đấu và SSE Stream thời gian thực
  initAuth();
  fetchTournamentStatus();
  fetchAdminAutoQueueStatus();
  startCountdownTimer();
  setupSSE();

  // 14. Bắt đầu polling Live Leaderboard mỗi 2 giây
  fetchLeaderboard();
  AppState.pollingInterval = setInterval(fetchLeaderboard, 2000);
});
