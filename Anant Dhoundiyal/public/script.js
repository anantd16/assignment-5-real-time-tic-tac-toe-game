/**
 * ============================================================================
 *  Real-Time Tic Tac Toe — script.js (client side)
 * ----------------------------------------------------------------------------
 *  The client is intentionally "dumb": it never decides who won or whose turn
 *  it is. It sends intent (login / move / reset) to the server and renders
 *  whatever the server broadcasts back. That keeps both browsers in sync.
 * ==========================================================================*/

'use strict';

(function () {
  /* ======================================================================
   * 1. SOCKET CONNECTION
   * ==================================================================== */
  const socket = io();

  /* ======================================================================
   * 2. DOM REFERENCES
   * ==================================================================== */
  const el = {
    // screens
    loginScreen: document.getElementById('loginScreen'),
    gameScreen: document.getElementById('gameScreen'),

    // login
    loginForm: document.getElementById('loginForm'),
    usernameInput: document.getElementById('usernameInput'),
    loginError: document.getElementById('loginError'),
    joinBtn: document.getElementById('joinBtn'),
    lobbyList: document.getElementById('lobbyList'),
    lobbyCount: document.getElementById('lobbyCount'),

    // game
    statusBar: document.getElementById('statusBar'),
    board: document.getElementById('board'),
    cells: Array.from(document.querySelectorAll('.cell')),
    resetBtn: document.getElementById('resetBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    youSymbol: document.getElementById('youSymbol'),
    youName: document.getElementById('youName'),

    // players panel
    cardX: document.getElementById('playerCardX'),
    cardO: document.getElementById('playerCardO'),
    nameX: document.getElementById('nameX'),
    nameO: document.getElementById('nameO'),
    statMoves: document.getElementById('statMoves'),
    statPlayers: document.getElementById('statPlayers'),

    // history
    historyList: document.getElementById('historyList'),
    refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
    dbBadge: document.getElementById('dbBadge'),

    // modal
    modalOverlay: document.getElementById('modalOverlay'),
    modalIcon: document.getElementById('modalIcon'),
    modalTitle: document.getElementById('modalTitle'),
    modalText: document.getElementById('modalText'),
    modalCountdown: document.getElementById('modalCountdown'),
    modalPlayAgain: document.getElementById('modalPlayAgain'),
    modalClose: document.getElementById('modalClose'),
    confetti: document.getElementById('confetti'),

    // misc
    connPill: document.getElementById('connectionStatus'),
    connText: document.getElementById('connectionText'),
    toastArea: document.getElementById('toastArea'),
  };

  /* ======================================================================
   * 3. LOCAL VIEW STATE
   * ==================================================================== */
  const me = { username: null, symbol: null, loggedIn: false };

  let view = {
    board: Array(9).fill(null),
    currentTurn: 'X',
    players: [],
    isGameActive: false,
    isGameOver: false,
    winningLine: null,
    totalMoves: 0,
  };

  let countdownTimer = null;

  /* ======================================================================
   * 4. SMALL HELPERS
   * ==================================================================== */

  /** Escape user supplied text before putting it into innerHTML. */
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** Pop a temporary notification in the top-right corner. */
  function toast(message, type = 'info', ms = 3200) {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    el.toastArea.appendChild(node);

    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 300);
    }, ms);
  }

  function showScreen(which) {
    el.loginScreen.classList.toggle('hidden', which !== 'login');
    el.gameScreen.classList.toggle('hidden', which !== 'game');
  }

  /* ======================================================================
   * 5. RENDERING
   * ==================================================================== */

  /** Paint the 3x3 grid from the server board array. */
  function renderBoard(justPlayedIndex = null) {
    el.cells.forEach((cell, i) => {
      const value = view.board[i];

      cell.textContent = value || '';
      cell.classList.remove('x', 'o', 'filled', 'win', 'pop');

      if (value) {
        cell.classList.add('filled', value.toLowerCase());
        if (i === justPlayedIndex) cell.classList.add('pop');
      }

      // A cell is clickable only when: I'm a player, game is live,
      // it's my turn, and the square is still empty.
      const myTurn = me.loggedIn && view.isGameActive && !view.isGameOver
        && view.currentTurn === me.symbol;
      cell.disabled = !myTurn || Boolean(value);
      cell.dataset.preview = myTurn && !value ? me.symbol : '';
      cell.classList.toggle('preview', Boolean(myTurn && !value));
    });

    // Highlight the three winning squares.
    if (view.winningLine) {
      view.winningLine.forEach((i) => el.cells[i].classList.add('win'));
    }

    el.statMoves.textContent = view.totalMoves;
  }

  /** Update the two player cards + the online counter. */
  function renderPlayers() {
    const px = view.players.find((p) => p.symbol === 'X');
    const po = view.players.find((p) => p.symbol === 'O');

    el.nameX.textContent = px ? px.username : 'Waiting…';
    el.nameO.textContent = po ? po.username : 'Waiting…';

    el.cardX.classList.toggle('empty', !px);
    el.cardO.classList.toggle('empty', !po);

    const live = view.isGameActive && !view.isGameOver;
    el.cardX.classList.toggle('active-turn', live && view.currentTurn === 'X');
    el.cardO.classList.toggle('active-turn', live && view.currentTurn === 'O');

    el.statPlayers.textContent = `${view.players.length}/2`;
  }

  /** Update the sentence above the board. */
  function renderStatus(customText = null, tone = null) {
    if (customText) {
      el.statusBar.textContent = customText;
      el.statusBar.className = `status-bar ${tone || ''}`;
      return;
    }

    if (!view.isGameActive && view.players.length < 2) {
      el.statusBar.textContent = 'Waiting for a second player to join…';
      el.statusBar.className = 'status-bar wait-turn';
      return;
    }

    if (view.isGameOver) {
      el.statusBar.textContent = 'Game over — resetting soon…';
      el.statusBar.className = 'status-bar alert';
      return;
    }

    if (view.currentTurn === me.symbol) {
      el.statusBar.textContent = "Your turn — make your move!";
      el.statusBar.className = 'status-bar your-turn';
    } else {
      const opponent = view.players.find((p) => p.symbol === view.currentTurn);
      el.statusBar.textContent = `Waiting for ${opponent ? opponent.username : view.currentTurn}…`;
      el.statusBar.className = 'status-bar wait-turn';
    }
  }

  /** Render the lobby list on the login screen. */
  function renderLobby(players, count) {
    el.lobbyCount.textContent = `${count} / 2`;

    if (!players.length) {
      el.lobbyList.innerHTML = '<li class="lobby-empty">Nobody here yet — be the first!</li>';
      return;
    }

    el.lobbyList.innerHTML = players
      .map((p) => `<li>👤 ${esc(p.username)}
          <span class="mini-badge ${p.symbol.toLowerCase()}">${p.symbol}</span></li>`)
      .join('');
  }

  /** Render the Firestore game-history panel. */
  function renderHistory(history, dbReady) {
    el.dbBadge.textContent = dbReady ? '🔥 Firestore' : '🔥 Firestore (off)';
    el.dbBadge.classList.toggle('db-off', !dbReady);

    if (!dbReady) {
      el.historyList.innerHTML =
        '<li class="history-empty">Firebase is not configured.<br>Add your keys to <b>.env</b> to save history.</li>';
      return;
    }

    if (!history || !history.length) {
      el.historyList.innerHTML = '<li class="history-empty">No games played yet.</li>';
      return;
    }

    el.historyList.innerHTML = history
      .map((g) => {
        const isDraw = g.result === 'draw';
        return `<li class="history-item">
            <div class="hi-top">
              <span class="hi-players">
                <span class="x">${esc(g.playerX)}</span>
                <span style="opacity:.5"> vs </span>
                <span class="o">${esc(g.playerO)}</span>
              </span>
              <span class="hi-result ${isDraw ? 'draw' : ''}">
                ${isDraw ? 'DRAW' : '🏆 ' + esc(g.winner)}
              </span>
            </div>
            <div class="hi-meta">
              <span>${esc(g.date || '')} ${esc(g.time || '')}</span>
              <span>${g.totalMoves ?? 0} moves</span>
            </div>
          </li>`;
      })
      .join('');
  }

  /** Redraw everything from the current view state. */
  function renderAll(justPlayedIndex = null) {
    renderBoard(justPlayedIndex);
    renderPlayers();
    renderStatus();
  }

  /* ======================================================================
   * 6. WINNER MODAL + CONFETTI
   * ==================================================================== */

  function launchConfetti() {
    const colors = ['#45e0ff', '#ff7ab8', '#7c5cff', '#38e0a4', '#ffc55c'];
    el.confetti.innerHTML = '';

    for (let i = 0; i < 70; i++) {
      const piece = document.createElement('i');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = `${2 + Math.random() * 2}s`;
      piece.style.animationDelay = `${Math.random() * 0.8}s`;
      el.confetti.appendChild(piece);
    }
  }

  function openModal({ icon, title, text, seconds, confetti }) {
    el.modalIcon.textContent = icon;
    el.modalTitle.textContent = title;
    el.modalText.textContent = text;
    el.modalOverlay.classList.remove('hidden');

    if (confetti) launchConfetti();
    else el.confetti.innerHTML = '';

    clearInterval(countdownTimer);
    if (seconds) {
      let left = seconds;
      el.modalCountdown.textContent = `Board resets in ${left}s — you'll be asked to log in again.`;
      countdownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(countdownTimer);
          el.modalCountdown.textContent = 'Resetting…';
        } else {
          el.modalCountdown.textContent =
            `Board resets in ${left}s — you'll be asked to log in again.`;
        }
      }, 1000);
    } else {
      el.modalCountdown.textContent = '';
    }
  }

  function closeModal() {
    el.modalOverlay.classList.add('hidden');
    el.confetti.innerHTML = '';
    clearInterval(countdownTimer);
  }

  /* ======================================================================
   * 7. USER ACTIONS  ->  SOCKET EMITS
   * ==================================================================== */

  // --- Login ---------------------------------------------------------
  el.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const username = el.usernameInput.value.trim();
    el.loginError.textContent = '';

    if (!username) {
      showLoginError('Please enter a username.');
      return;
    }
    if (username.length < 2) {
      showLoginError('Username must be at least 2 characters.');
      return;
    }

    el.joinBtn.disabled = true;
    el.joinBtn.querySelector('.btn-label').textContent = 'Joining…';
    socket.emit('user-login', { username });
  });

  function showLoginError(message) {
    el.loginError.textContent = message;
    el.usernameInput.classList.add('shake');
    setTimeout(() => el.usernameInput.classList.remove('shake'), 450);
  }

  function resetJoinButton() {
    el.joinBtn.disabled = false;
    el.joinBtn.querySelector('.btn-label').textContent = 'Join Game';
  }

  // --- Making a move --------------------------------------------------
  el.cells.forEach((cell) => {
    cell.addEventListener('click', () => {
      const index = Number(cell.dataset.index);

      if (!me.loggedIn) return toast('Log in first.', 'error');
      if (!view.isGameActive || view.isGameOver) return toast('The game is not running.', 'error');
      if (view.currentTurn !== me.symbol) return toast("It's not your turn.", 'error');
      if (view.board[index]) return toast('That square is taken.', 'error');

      socket.emit('make-move', { index, symbol: me.symbol });
    });
  });

  // --- Reset ----------------------------------------------------------
  el.resetBtn.addEventListener('click', () => socket.emit('reset-game'));
  el.modalPlayAgain.addEventListener('click', () => {
    closeModal();
    socket.emit('reset-game');
  });
  el.modalClose.addEventListener('click', closeModal);

  // --- Leave ----------------------------------------------------------
  el.leaveBtn.addEventListener('click', () => window.location.reload());

  // --- History refresh -------------------------------------------------
  el.refreshHistoryBtn.addEventListener('click', () => {
    socket.emit('request-history');
    toast('Refreshing history…', 'info', 1500);
  });

  /* ======================================================================
   * 8. SOCKET EVENTS  ->  UI UPDATES
   * ==================================================================== */

  socket.on('connect', () => {
    el.connPill.className = 'conn-pill online';
    el.connText.textContent = 'Connected';
  });

  socket.on('disconnect', () => {
    el.connPill.className = 'conn-pill offline';
    el.connText.textContent = 'Disconnected';
    renderStatus('Connection lost. Trying to reconnect…', 'alert');
  });

  socket.on('connect_error', () => {
    el.connPill.className = 'conn-pill offline';
    el.connText.textContent = 'Connection error';
  });

  /** Full snapshot sent right after connecting. */
  socket.on('state-sync', (state) => {
    view = { ...view, ...state };
    renderLobby(state.players, state.playerCount);
    if (me.loggedIn) renderAll();
  });

  /** Login accepted — switch to the game screen. */
  socket.on('login-success', (data) => {
    me.username = data.username;
    me.symbol = data.symbol;
    me.loggedIn = true;

    view = { ...view, ...data };

    el.youSymbol.textContent = data.symbol;
    el.youSymbol.className = `you-symbol ${data.symbol.toLowerCase()}`;
    el.youName.textContent = `· ${data.username}`;

    resetJoinButton();
    el.usernameInput.value = '';
    showScreen('game');
    renderAll();

    toast(`Welcome ${data.username}! You are "${data.symbol}".`, 'success');
  });

  /** Login rejected (name taken, game full, bad name…). */
  socket.on('login-error', (data) => {
    resetJoinButton();
    showLoginError(data.message);
    toast(data.message, 'error');
  });

  /** Player list changed. */
  socket.on('players-update', (data) => {
    view.players = data.players;
    renderLobby(data.players, data.playerCount);
    if (me.loggedIn) { renderPlayers(); renderStatus(); }
  });

  socket.on('waiting', (data) => renderStatus(data.message, 'wait-turn'));

  /** Both players are in — the match begins. */
  socket.on('game-start', (state) => {
    view = { ...view, ...state, isGameOver: false, winningLine: null };
    closeModal();
    renderAll();
    toast(state.message || 'Game started!', 'success');
  });

  /** Somebody played a square. */
  socket.on('move-made', (data) => {
    view.board = data.board;
    view.currentTurn = data.currentTurn;
    view.totalMoves = data.totalMoves;
    renderAll(data.index);
  });

  /** The server rejected our move. */
  socket.on('move-error', (data) => toast(data.message, 'error'));

  /** Somebody won, or it's a draw. */
  socket.on('game-over', (data) => {
    view.board = data.board;
    view.isGameOver = true;
    view.isGameActive = false;
    view.winningLine = data.winningLine;
    view.totalMoves = data.totalMoves;
    renderAll();

    const iWon = !data.isDraw && data.winner === me.symbol;

    openModal({
      icon: data.isDraw ? '🤝' : iWon ? '🏆' : '😢',
      title: data.isDraw ? "It's a Draw!" : iWon ? 'You Win!' : 'You Lost',
      text: data.message,
      seconds: data.resetInSeconds,
      confetti: iWon || data.isDraw === false,
    });
  });

  /** Board (or the whole session) was reset. */
  socket.on('game-reset', (data) => {
    closeModal();
    view = { ...view, ...data, isGameOver: false, winningLine: null };

    if (data.requiresLogin) {
      // Assignment rule: after a game ends everyone logs in again.
      me.loggedIn = false;
      me.symbol = null;
      me.username = null;
      showScreen('login');
      resetJoinButton();
      el.loginError.textContent = '';
      renderLobby(data.players || [], data.playerCount || 0);
      toast(data.message || 'Game reset. Log in again to play.', 'info', 4200);
    } else {
      renderAll();
      toast(data.message || 'Board reset.', 'info');
    }
  });

  /** A player disconnected. */
  socket.on('player-left', (data) => toast(data.message, 'error'));

  /** New/refreshed history from Firestore. */
  socket.on('history-update', (data) => renderHistory(data.history, data.dbReady));

  /* ======================================================================
   * 9. INITIAL RENDER
   * ==================================================================== */
  showScreen('login');
  renderAll();
  el.usernameInput.focus();
})();
