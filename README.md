# Chatting App (Vercel + Render Ready)

A simple realtime chat app:
- Frontend: React + Vite + Socket.IO client (deploy to Vercel)
- Backend: Express + Socket.IO (deploy to Render)

## Project Structure

- `frontend/` - web client
- `backend/` - API + websocket server

## Local Setup

1. Install dependencies (already installed once if you used this workspace directly):

```bash
cd frontend
npm install
cd ../backend
npm install
```

2. Create env files:

- Copy `frontend/.env.example` to `frontend/.env`
- Copy `backend/.env.example` to `backend/.env`

3. Run backend:

```bash
cd backend
npm start
```

4. Run frontend:

```bash
cd frontend
npm run dev
```

Frontend default URL: `http://localhost:5173`
Backend default URL: `http://localhost:4000`

## Deploy Backend on Render

1. Push this repo to GitHub.
2. In Render, create a new Web Service from the repo.
3. Set:
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add env var:
   - `CLIENT_ORIGIN=https://your-vercel-domain.vercel.app`
5. Deploy and copy backend URL, for example:
   - `https://your-backend.onrender.com`

`backend/render.yaml` is included if you prefer Blueprint deploy.

## Deploy Frontend on Vercel

1. Import the same repo into Vercel.
2. Set project root directory to `frontend`.
3. Add environment variable:
   - `VITE_API_URL=https://your-backend.onrender.com`
   - For reliable video/audio calls across different networks, also set TURN values:
     - `VITE_TURN_URL=turn:your-turn-server:3478`
     - `VITE_TURN_USERNAME=your-username`
     - `VITE_TURN_CREDENTIAL=your-password`
4. Deploy.

## Notes

- Messages are realtime and stay in memory. Registered accounts persist in SQLite.
- If your backend is sleeping on free Render tier, first message may be delayed while waking up.
- WebRTC calls need a TURN server for many mobile/corporate/NAT-restricted networks; STUN-only can fail to exchange media.

## Validation

Requires Node.js 22.12+ or Node.js 24 LTS. After installing both packages, run:

```bash
cd frontend
npm run lint
npm test
npm run build
```

The regression suite starts an isolated backend on an automatically assigned port
and checks health, presence, sender identity, global/direct/room messages, room
membership enforcement, directed-target isolation, and call signaling. It closes
the server and clients after completion. Browser media tests still require camera
and microphone access (or simulated devices); cross-network calls may need TURN.

### Browser checks

The browser suite covers desktop and mobile navigation, room sharing, drafts,
multiline messages, connection recovery, simulated video calls, and automated
WCAG accessibility checks. It starts and stops its own frontend and backend.

```bash
cd frontend
npx playwright install chromium
npm run test:e2e
```

To use an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
to its executable path when running the suite. Tests use simulated camera and
microphone devices; no actual camera or microphone is recorded.

### Accounts and encryption

Choose **Create account** on the welcome screen, or **Sign in** to reclaim an existing handle. You can add an optional email address during registration and sign in with either your username or that email and your password. Other chat participants see your handle. Account handles begin with @. Guests can still join public chat. Leaving the space signs out. Refreshing the page clears the browser's in-memory token. Sessions expire after eight hours and restarting the backend invalidates them.

Run the backend with Node.js 24. Account records use SQLite, keyed username and email lookups, salted scrypt password verifiers, and AES-256-GCM authenticated encryption. Development and tests use an in-memory database and ephemeral key when Turso is absent. Temporary accounts expire when the process exits. Production requires remote Turso storage and a managed encryption key. For production, set NODE_ENV=production, supply ACCOUNT_KEY from a secret manager (generate 32 random bytes with `openssl rand -hex 32`), and configure storage. On Render, set TURSO_DATABASE_URL to the database libsql URL and TURSO_AUTH_TOKEN to its database-scoped write token. The backend creates its accounts table before accepting traffic. Keep a separate secure backup of the key alongside your database backup procedure. This version supports a single backend instance.

Serve the frontend and backend through HTTPS in production. Terminate TLS at a reverse proxy that supports WebSocket upgrades, configure the proxy to overwrite forwarded headers, set TRUSTED_PROXY to its IP or CIDR (default loopback), restrict direct backend access to the proxy, set CLIENT_ORIGIN to the frontend origin, and set VITE_API_URL to the HTTPS backend URL before building. Chat messages remain in memory. Orbit encrypts user-written chat text in the browser. Each page generates a temporary Curve25519 device key. Direct and global messages use per-recipient NaCl boxes (XSalsa20-Poly1305 with a fresh random nonce). Before sending a DM, exchange the two directional verification codes through an independent trusted channel and enter the other person’s code. Each code binds both device keys, display names, and connection IDs, in order. A changed connection or device requires fresh verification. The check runs locally and Orbit does not transmit the entered code.

For a private room, enter a name to generate a new random 256-bit invitation key. Copy the room code and share it privately. The relay receives a hash identifying the room and authenticated ciphertext. Anyone holding the invitation can decrypt room traffic and create room messages. A new room and invitation are needed to exclude a former member. Public chat is readable by every participant, including an operator who joins. The relay can see participants, timing, ciphertext sizes and system activity. The website publisher controls the JavaScript delivered to devices, so a malicious client update could capture future plaintext. Calls require verified devices at both ends. Offers, answers, and ICE candidates are encrypted and authenticated with the device-pair key, bound to the call ID, direction, and signal type. Browsers protect the media with WebRTC DTLS-SRTP. The relay can still observe or interrupt a call.
