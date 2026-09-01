/**
 * ============================================================================
 *  REAL-TIME MULTIPLAYER TIC TAC TOE
 *  Node.js + Express + Socket.io + Firebase (Firestore)
 * ----------------------------------------------------------------------------
 *  server.js  -  Main server file
 *
 *  Responsibilities:
 *    1. Serve the static frontend from /public
 *    2. Manage the username based login system (max 2 players, X then O)
 *    3. Hold the authoritative game state and validate every move
 *    4. Broadcast state changes to all connected clients over Socket.io
 *    5. Persist finished games to a Firestore collection ("gameHistory")
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// Firebase Web SDK (modular v9+) -------------------------------------------
const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  limit,
  serverTimestamp,
} = require('firebase/firestore');

/* ============================================================================
 * SECTION 1 - CONFIGURATION
 * ========================================================================== */

const PORT = process.env.PORT || 3000;

/** Firestore collection that stores the history of every completed game. */
const HISTORY_COLLECTION = process.env.FIREBASE_COLLECTION || 'gameHistory';

/** How many milliseconds to wait after "game over" before auto-resetting. */
const AUTO_RESET_DELAY = Number(process.env.AUTO_RESET_DELAY || 6000);

/** Maximum number of players allowed in a single game. */
const MAX_PLAYERS = 2;

/** Username validation rules. */
const USERNAME_MIN = 2;
const USERNAME_MAX = 15;
const USERNAME_PATTERN = /^[A-Za-z0-9_ ]+$/;

/* ============================================================================
 * SECTION 2 - FIREBASE / FIRESTORE SETUP
 * --------------------------------------------------------------------------
 * The credentials live in the .env file (see .env.example). If they are not
 * supplied the server still runs perfectly - it simply skips persistence and
 * says so in the logs, so the game is never blocked by a database outage.
 * ========================================================================== */

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};

let db = null;         // Firestore instance (null when not configured)
let dbReady = false;   // true only when Firestore is usable

/**
 * Initialise the Firebase app + Firestore handle.
 * Any failure is logged and downgraded to "history disabled" instead of a crash.
 */
function initFirebase() {
  // Treat the untouched .env placeholders as "not configured yet".
  const isPlaceholder = (v) =>
    !v || /YOUR_|your-project-id|abcdef1234567890|000000000000/i.test(String(v));

  const missing = ['apiKey', 'projectId', 'appId'].filter((k) => isPlaceholder(firebaseConfig[k]));

  if (missing.length) {
    console.warn(
      `[firebase] Missing config: ${missing.join(', ')}. ` +
        'Game history will NOT be saved. Fill in your .env file to enable it.'
    );
    return;
  }

  try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    dbReady = true;
    console.log(`[firebase] Connected to project "${firebaseConfig.projectId}"`);
    console.log(`[firebase] History collection: "${HISTORY_COLLECTION}"`);
  } catch (err) {
    console.error('[firebase] Initialisation failed:', err.message);
    dbReady = false;
  }
}

/**
 * Save one finished game to Firestore.
 * @param {object} record - { playerX, playerO, winner, result, totalMoves, ... }
 * @returns {Promise<string|null>} the new document id, or null when skipped/failed
 */
async function saveGameHistory(record) {
  if (!dbReady) {
    console.warn('[firebase] Skipped saving history (database not configured).');
    return null;
  }

  try {
    const ref = await addDoc(collection(db, HISTORY_COLLECTION), {
      ...record,
      playedAt: serverTimestamp(), // server side ordering key
    });
    console.log(`[firebase] Saved game history -> ${ref.id}`);
    return ref.id;
  } catch (err) {
    console.error('[firebase] Failed to save game history:', err.message);
    return null;
  }
}

/**
 * Read the most recent games back out of Firestore.
 * @param {number} max - maximum number of records to return
 * @returns {Promise<Array>} newest first
 */
async function fetchGameHistory(max = 10) {
  if (!dbReady) return [];

  try {
    const q = query(
      collection(db, HISTORY_COLLECTION),
      orderBy('playedAt', 'desc'),
      limit(max)
    );
    const snapshot = await getDocs(q);

    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        playerX: data.playerX,
        playerO: data.playerO,
        winner: data.winner,
        result: data.result,
        totalMoves: data.totalMoves,
        date: data.date,
        time: data.time,
      };
    });
  } catch (err) {
    console.error('[firebase] Failed to fetch game history:', err.message);
    return [];
  }
}

initFirebase();

/* ============================================================================
 * SECTION 3 - EXPRESS + SOCKET.IO SERVER
 * ========================================================================== */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** REST endpoint used by the frontend to render the game history panel. */
app.get('/api/history', async (req, res) => {
  const max = Math.min(Number(req.query.limit) || 10, 50);
  try {
    const history = await fetchGameHistory(max);
    res.json({ ok: true, dbReady, count: history.length, history });
  } catch (err) {
    console.error('[api] /api/history failed:', err.message);
    res.status(500).json({ ok: false, error: 'Could not load game history.' });
  }
});

/** Simple health/status endpoint - handy while testing or when deployed. */
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    dbReady,
    database: 'Firebase Firestore',
    players: gameState.players.length,
    gameActive: gameState.isGameActive,
  });
});

/* ============================================================================
 * SECTION 4 - GAME STATE
 * ========================================================================== */

/** All 8 winning index combinations on a 3x3 board. */
const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

/**
 * The single authoritative game state. The client never decides anything -
 * it only renders what the server broadcasts.
 */
let gameState = createFreshState();
let autoResetTimer = null;

function createFreshState() {
  return {
    board: Array(9).fill(null), // 9 cells: null | 'X' | 'O'
    currentTurn: 'X',           // X always moves first
    players: [],                // [{ id, username, symbol }]
    isGameActive: false,        // true only while 2 players are playing
    isGameOver: false,
    winner: null,               // 'X' | 'O' | null
    winningLine: null,          // e.g. [0,4,8] for the strike-through animation
    totalMoves: 0,
    startedAt: null,
  };
}

/** Public snapshot sent to clients (never leak socket ids of other players). */
function publicState() {
  return {
    board: gameState.board,
    currentTurn: gameState.currentTurn,
    players: gameState.players.map((p) => ({ username: p.username, symbol: p.symbol })),
    playerCount: gameState.players.length,
    isGameActive: gameState.isGameActive,
    isGameOver: gameState.isGameOver,
    winner: gameState.winner,
    winningLine: gameState.winningLine,
    totalMoves: gameState.totalMoves,
  };
}

/** Broadcast the current player list to everybody. */
function broadcastPlayers() {
  io.emit('players-update', {
    players: gameState.players.map((p) => ({ username: p.username, symbol: p.symbol })),
    playerCount: gameState.players.length,
    maxPlayers: MAX_PLAYERS,
  });
}

function findPlayerBySocket(socketId) {
  return gameState.players.find((p) => p.id === socketId) || null;
}

/**
 * Check the board for a winner or a draw.
 * @returns {{winner: 'X'|'O'|null, line: number[]|null, isDraw: boolean}}
 */
function evaluateBoard(board) {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line, isDraw: false };
    }
  }

  const isDraw = board.every((cell) => cell !== null);
  return { winner: null, line: null, isDraw };
}

/**
 * Validate a username against the login rules.
 * @returns {string|null} an error message, or null when the name is valid
 */
function validateUsername(raw) {
  if (typeof raw !== 'string') return 'Username must be text.';

  const name = raw.trim();
  if (!name) return 'Username cannot be empty.';
  if (name.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters.`;
  if (name.length > USERNAME_MAX) return `Username cannot be longer than ${USERNAME_MAX} characters.`;
  if (!USERNAME_PATTERN.test(name)) return 'Only letters, numbers, spaces and underscores are allowed.';

  const taken = gameState.players.some(
    (p) => p.username.toLowerCase() === name.toLowerCase()
  );
  if (taken) return 'That username is already taken. Pick another one.';

  return null;
}

/**
 * Clear the board but keep both players seated (used by the manual reset).
 */
function resetBoardOnly() {
  clearTimeout(autoResetTimer);
  autoResetTimer = null;

  gameState.board = Array(9).fill(null);
  gameState.currentTurn = 'X';
  gameState.isGameOver = false;
  gameState.winner = null;
  gameState.winningLine = null;
  gameState.totalMoves = 0;
  gameState.isGameActive = gameState.players.length === MAX_PLAYERS;
  gameState.startedAt = gameState.isGameActive ? Date.now() : null;
}

/**
 * Full reset: clears the board AND kicks both players back to the login screen,
 * as required by the assignment ("Auto-reset after game over. Users must login again").
 */
function fullReset(reason = 'Game reset. Please log in again to play.') {
  clearTimeout(autoResetTimer);
  autoResetTimer = null;

  gameState = createFreshState();

  io.emit('game-reset', {
    ...publicState(),
    requiresLogin: true,
    message: reason,
  });

  broadcastPlayers();
  console.log(`[game] Full reset -> ${reason}`);
}

/**
 * Handle the end of a game: announce it, persist it, then schedule the reset.
 */
async function finishGame({ winnerSymbol, line, isDraw }) {
  const playerX = gameState.players.find((p) => p.symbol === 'X');
  const playerO = gameState.players.find((p) => p.symbol === 'O');
  const winnerPlayer = winnerSymbol
    ? gameState.players.find((p) => p.symbol === winnerSymbol)
    : null;

  gameState.isGameOver = true;
  gameState.isGameActive = false;
  gameState.winner = winnerSymbol;
  gameState.winningLine = line;

  const now = new Date();

  // 1. Tell every client the game is over ---------------------------------
  io.emit('game-over', {
    board: gameState.board,
    winner: winnerSymbol,                              // 'X' | 'O' | null
    winnerName: winnerPlayer ? winnerPlayer.username : null,
    winningLine: line,
    isDraw,
    totalMoves: gameState.totalMoves,
    message: isDraw
      ? "It's a draw! Nobody wins this one."
      : `${winnerPlayer ? winnerPlayer.username : winnerSymbol} wins the game!`,
    resetInSeconds: Math.round(AUTO_RESET_DELAY / 1000),
  });

  console.log(
    `[game] Over -> ${isDraw ? 'DRAW' : `${winnerPlayer?.username} (${winnerSymbol}) wins`} ` +
      `in ${gameState.totalMoves} moves`
  );

  // 2. Persist the result in Firestore -------------------------------------
  const record = {
    playerX: playerX ? playerX.username : 'Unknown',
    playerO: playerO ? playerO.username : 'Unknown',
    winner: isDraw ? 'Draw' : (winnerPlayer ? winnerPlayer.username : 'Unknown'),
    winnerSymbol: isDraw ? null : winnerSymbol,
    result: isDraw ? 'draw' : 'win',
    totalMoves: gameState.totalMoves,
    date: now.toLocaleDateString('en-GB'),               // dd/mm/yyyy
    time: now.toLocaleTimeString('en-GB', { hour12: false }),
    durationSeconds: gameState.startedAt
      ? Math.round((Date.now() - gameState.startedAt) / 1000)
      : null,
  };

  await saveGameHistory(record);

  // 3. Push the refreshed history to every client --------------------------
  io.emit('history-update', { history: await fetchGameHistory(10), dbReady });

  // 4. Auto-reset back to the login screen ---------------------------------
  autoResetTimer = setTimeout(() => {
    fullReset('Game finished and the board was auto-reset. Log in again to play.');
  }, AUTO_RESET_DELAY);
}

/* ============================================================================
 * SECTION 5 - SOCKET.IO EVENT HANDLERS
 * ========================================================================== */

io.on('connection', (socket) => {
  console.log(`[socket] Connected: ${socket.id}`);

  // Send the newcomer the current situation so the UI can render immediately.
  socket.emit('state-sync', publicState());
  fetchGameHistory(10)
    .then((history) => socket.emit('history-update', { history, dbReady }))
    .catch(() => socket.emit('history-update', { history: [], dbReady }));

  /* --------------------------------------------------------------------
   * user-login - Client sends username
   * ------------------------------------------------------------------ */
  socket.on('user-login', (payload) => {
    try {
      const rawName = typeof payload === 'string' ? payload : payload?.username;

      // Already sitting at the table?
      if (findPlayerBySocket(socket.id)) {
        return socket.emit('login-error', { message: 'You are already logged in.' });
      }

      // Third user cannot join.
      if (gameState.players.length >= MAX_PLAYERS) {
        return socket.emit('login-error', {
          message: 'Game is full. Only 2 players are allowed - please try again later.',
        });
      }

      // Username rules.
      const error = validateUsername(rawName);
      if (error) {
        return socket.emit('login-error', { message: error });
      }

      // Seat the player: first one is X, second one is O.
      const username = rawName.trim();
      const symbol = gameState.players.length === 0 ? 'X' : 'O';
      const player = { id: socket.id, username, symbol };
      gameState.players.push(player);

      console.log(`[game] ${username} joined as "${symbol}" (${socket.id})`);

      socket.emit('login-success', {
        username,
        symbol,
        ...publicState(),
      });

      broadcastPlayers();

      // Two players seated -> kick the game off.
      if (gameState.players.length === MAX_PLAYERS) {
        resetBoardOnly();
        io.emit('game-start', {
          ...publicState(),
          message: 'Both players are in. X moves first - good luck!',
        });
        console.log('[game] Started');
      } else {
        socket.emit('waiting', { message: 'Waiting for a second player to join...' });
      }
    } catch (err) {
      console.error('[socket] user-login failed:', err.message);
      socket.emit('login-error', { message: 'Something went wrong while logging in.' });
    }
  });

  /* --------------------------------------------------------------------
   * make-move - Client sends { index, symbol }
   * ------------------------------------------------------------------ */
  socket.on('make-move', async (payload) => {
    try {
      const player = findPlayerBySocket(socket.id);

      if (!player) {
        return socket.emit('move-error', { message: 'You must log in before playing.' });
      }
      if (!gameState.isGameActive || gameState.isGameOver) {
        return socket.emit('move-error', { message: 'The game is not running right now.' });
      }
      if (gameState.currentTurn !== player.symbol) {
        return socket.emit('move-error', { message: "It's not your turn yet." });
      }

      const index = Number(payload?.index);
      if (!Number.isInteger(index) || index < 0 || index > 8) {
        return socket.emit('move-error', { message: 'That square does not exist.' });
      }
      if (gameState.board[index] !== null) {
        return socket.emit('move-error', { message: 'That square is already taken.' });
      }
      // Guard against a spoofed symbol in the payload.
      if (payload?.symbol && payload.symbol !== player.symbol) {
        return socket.emit('move-error', { message: 'You can only play your own symbol.' });
      }

      // Apply the move -----------------------------------------------------
      gameState.board[index] = player.symbol;
      gameState.totalMoves += 1;

      const { winner, line, isDraw } = evaluateBoard(gameState.board);
      const gameEnded = Boolean(winner) || isDraw;

      if (!gameEnded) {
        gameState.currentTurn = player.symbol === 'X' ? 'O' : 'X';
      }

      // Broadcast the move to everyone -------------------------------------
      io.emit('move-made', {
        index,
        symbol: player.symbol,
        username: player.username,
        board: gameState.board,
        currentTurn: gameState.currentTurn,
        totalMoves: gameState.totalMoves,
        gameEnded,
      });

      if (gameEnded) {
        await finishGame({ winnerSymbol: winner, line, isDraw });
      }
    } catch (err) {
      console.error('[socket] make-move failed:', err.message);
      socket.emit('move-error', { message: 'Your move could not be processed.' });
    }
  });

  /* --------------------------------------------------------------------
   * reset-game - Client requests a manual reset
   * ------------------------------------------------------------------ */
  socket.on('reset-game', () => {
    try {
      const player = findPlayerBySocket(socket.id);
      if (!player) {
        return socket.emit('move-error', { message: 'Only players in the game can reset it.' });
      }

      // If the game already ended, do the full reset (back to login).
      if (gameState.isGameOver) {
        return fullReset(`${player.username} reset the game. Please log in again.`);
      }

      // Otherwise just wipe the board and keep both players seated.
      resetBoardOnly();
      io.emit('game-reset', {
        ...publicState(),
        requiresLogin: false,
        message: `${player.username} reset the board. X starts again.`,
      });
      console.log(`[game] Board reset by ${player.username}`);
    } catch (err) {
      console.error('[socket] reset-game failed:', err.message);
    }
  });

  /* --------------------------------------------------------------------
   * request-history - Client asks for a refresh of the history panel
   * ------------------------------------------------------------------ */
  socket.on('request-history', async () => {
    try {
      socket.emit('history-update', { history: await fetchGameHistory(10), dbReady });
    } catch (err) {
      console.error('[socket] request-history failed:', err.message);
      socket.emit('history-update', { history: [], dbReady });
    }
  });

  /* --------------------------------------------------------------------
   * disconnect - Handle a user leaving
   * ------------------------------------------------------------------ */
  socket.on('disconnect', () => {
    console.log(`[socket] Disconnected: ${socket.id}`);

    const player = findPlayerBySocket(socket.id);
    if (!player) return; // a spectator / not-logged-in socket left, nothing to do

    gameState.players = gameState.players.filter((p) => p.id !== socket.id);
    console.log(`[game] ${player.username} (${player.symbol}) left the game`);

    io.emit('player-left', {
      username: player.username,
      symbol: player.symbol,
      message: `${player.username} left the game.`,
    });

    // A game in progress cannot continue with one player - reset it.
    if (gameState.isGameActive || gameState.isGameOver) {
      fullReset(`${player.username} disconnected. The game was reset - please log in again.`);
    } else {
      gameState.isGameActive = false;
      broadcastPlayers();
    }
  });
});

/* ============================================================================
 * SECTION 6 - START THE SERVER
 * ========================================================================== */

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use.`);
    console.error('[server] Stop the other process, or run with a different port:');
    console.error('[server]   PORT=3001 npm start');
    process.exit(1);
  }
  console.error('[server] Fatal error:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('======================================================');
  console.log('  Real-Time Tic Tac Toe');
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Database: Firebase Firestore (${dbReady ? 'connected' : 'not configured'})`);
  console.log('======================================================');
});

// Never let an unexpected error kill the whole server silently.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});
