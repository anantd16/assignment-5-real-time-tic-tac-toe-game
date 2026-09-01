# 🎮 Real-Time Multiplayer Tic Tac Toe

A real-time, two-player Tic Tac Toe game built with **Node.js**, **Express**, and **Socket.io**, with completed games persisted to **Firebase Firestore**.

Both browsers stay perfectly in sync over WebSockets — every move, every win, and every reset is broadcast by the server, which holds the single authoritative copy of the game state.

---

## 📌 Database Used

> **Firebase (Firestore)** — Option 3 from the assignment.
> Package: `firebase` (Web modular SDK v11)
> Collection: `gameHistory`

---

## ✨ Features

| Feature | Status | Notes |
|---|---|---|
| User Login | ✅ | Username-based, validated. First user gets **X**, second gets **O** |
| 2-Player Limit | ✅ | A third user is rejected with a clear error message |
| Game Logic | ✅ | Full Tic Tac Toe rules, turn management, winner + draw detection |
| Real-time Sync | ✅ | All moves broadcast instantly to every connected client |
| Winner Declaration | ✅ | Animated modal + confetti + winning-line highlight |
| Game History | ✅ | Every finished game written to Firestore and shown in the UI |
| Game Reset | ✅ | Auto-reset after game over (users must log in again) + manual reset |
| Responsive UI | ✅ | Works on desktop, tablet and mobile |
| Error Handling | ✅ | Invalid moves, duplicate names, full lobby, disconnects, DB failures |

---

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.js, Socket.io
- **Database:** Firebase Firestore (`firebase` npm package)
- **Frontend:** HTML5, CSS3, Vanilla JavaScript (no framework)
- **Config:** dotenv

---

## 📁 Folder Structure

```
Assignment_5/
├── server.js            // Main server file (Express + Socket.io + Firestore)
├── package.json         // Dependencies and scripts
├── .env                 // Environment variables (Firebase keys) — not committed
├── .env.example         // Template for .env
├── .gitignore
├── public/
│   ├── index.html       // Main HTML file
│   ├── style.css        // CSS styles
│   └── script.js        // Client-side JS (Socket.io client)
└── README.md            // Project documentation
```

---

## 🚀 Setup Instructions

### 1. Install dependencies

```bash
npm install
```

### 2. Create a Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**.
2. In the left sidebar open **Build → Firestore Database → Create database**.
   Choose **Start in test mode** (fine for this assignment) and pick a region.
3. Go to **Project settings (⚙️) → General → Your apps → Web (`</>`)** and
   register a web app. Firebase will show you a `firebaseConfig` object.

### 3. Fill in your `.env`

Copy the values from that `firebaseConfig` object into `.env`:

```env
PORT=3000

FIREBASE_API_KEY=AIzaSy...................
FIREBASE_AUTH_DOMAIN=my-tictactoe.firebaseapp.com
FIREBASE_PROJECT_ID=my-tictactoe
FIREBASE_STORAGE_BUCKET=my-tictactoe.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789012
FIREBASE_APP_ID=1:123456789012:web:abc123def456

FIREBASE_COLLECTION=gameHistory
AUTO_RESET_DELAY=6000
```

> The app still runs without Firebase credentials — it just skips saving
> history and shows a "Firestore (off)" badge instead of crashing.

### 4. Firestore security rules (test mode)

For local development, allow reads/writes on the history collection:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /gameHistory/{doc} {
      allow read, write: if true;
    }
  }
}
```

### 5. Start the server

```bash
npm start
# or with auto-restart while developing:
npm run dev
```

Open **<http://localhost:3000>** in two different browser windows
(use one normal window + one incognito window so they are separate sockets),
log in with two different usernames, and play.

> If port 3000 is already used on your machine, run `PORT=3001 npm start`.

---

## 🔌 Socket Events

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `user-login` | `{ username }` | Client sends username |
| `make-move` | `{ index, symbol }` | Client sends move (index `0–8`, symbol) |
| `reset-game` | — | Client requests reset |
| `request-history` | — | Client asks for a fresh copy of the history |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `login-success` | `{ username, symbol, ...state }` | Server confirms login with symbol |
| `login-error` | `{ message }` | Server sends error message |
| `players-update` | `{ players, playerCount }` | Server broadcasts player list |
| `game-start` | `{ board, currentTurn, players }` | Server starts game when 2 players join |
| `move-made` | `{ index, symbol, board, currentTurn }` | Server broadcasts move to all |
| `game-over` | `{ winner, winnerName, winningLine, isDraw }` | Server announces winner/draw |
| `game-reset` | `{ ...state, requiresLogin, message }` | Server confirms reset |
| `move-error` | `{ message }` | Invalid move feedback |
| `state-sync` | full state | Sent on connect so a new client can render |
| `player-left` | `{ username, symbol, message }` | A user disconnected |
| `history-update` | `{ history, dbReady }` | Latest games from Firestore |

`disconnect` is handled server-side: the leaving player is removed, everyone is
notified, and an in-progress game is reset so nobody is stuck.

---

## 🗄️ Firestore Document Shape

Collection: **`gameHistory`**

```json
{
  "playerX": "Aditya",
  "playerO": "Riya",
  "winner": "Aditya",
  "winnerSymbol": "X",
  "result": "win",
  "totalMoves": 5,
  "date": "27/08/2026",
  "time": "10:42:11",
  "durationSeconds": 34,
  "playedAt": "<Firestore server timestamp>"
}
```

A drawn game stores `"winner": "Draw"`, `"result": "draw"` and `"winnerSymbol": null`.

---

## 🌐 REST Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/history?limit=10` | Last N games from Firestore (newest first) |
| `GET` | `/api/status` | Server + database health, current player count |

---

## 🎯 How the Game Works

1. **Login** — the first user to submit a username becomes **X**, the second becomes **O**. A third user is refused ("Game is full").
2. **Start** — as soon as two players are seated the server emits `game-start`. **X** always moves first.
3. **Moves** — a click emits `make-move`. The **server** validates it (logged in? game live? your turn? square empty? index in range?) before applying it, then broadcasts `move-made` to both players.
4. **End** — the server checks all 8 winning lines after every move. On a win or a draw it emits `game-over`, saves the record to Firestore, and pushes the refreshed history to both clients.
5. **Reset** — six seconds after the game ends the server performs a full reset and both players are returned to the login screen (as required by the assignment). Either player can also press **Reset Game** at any time.
6. **Disconnect** — if a player closes their tab mid-game, the other player is told and the game resets cleanly.

---

## ✅ Error Handling

- Empty / too short / too long / invalid-character usernames
- Duplicate usernames
- Third player trying to join a full game
- Playing before logging in, out of turn, on a taken square, or with an invalid index
- Spoofed symbol in the `make-move` payload
- Player disconnecting mid-game
- Firebase not configured, or a Firestore read/write failing — the game keeps running and the UI shows the database as off
- Port already in use — the server prints a readable message instead of a stack trace

---

## 🧪 Testing Checklist

- [x] Two browsers, two usernames → X and O assigned in order
- [x] Third browser → rejected with "Game is full"
- [x] Moves appear instantly in both windows
- [x] Out-of-turn clicks rejected
- [x] Row / column / diagonal wins detected and highlighted
- [x] Draw detected on a full board
- [x] Result written to Firestore and shown in the history panel
- [x] Auto-reset returns both players to the login screen
- [x] Closing one tab resets the game for the other player
- [x] Layout works on a phone-sized screen

---

## 📦 Dependencies

```json
{
  "express": "^4.19.2",
  "socket.io": "^4.8.1",
  "firebase": "^11.2.0",
  "dotenv": "^16.4.5"
}
```

---

## 🚢 Optional Deployment (Render / Railway)

1. Push this folder to a GitHub repository.
2. Create a new **Web Service** on Render or Railway pointing at the repo.
3. Build command `npm install`, start command `npm start`.
4. Add every `FIREBASE_*` variable from your `.env` in the dashboard's
   environment-variables section.

Socket.io works over the platform's default HTTPS/WSS port with no extra config.
