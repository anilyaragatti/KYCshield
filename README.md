# KYCShield

KYCShield creates expiring email or WhatsApp invites, validates customer links, and connects a verifier and customer in a two-person WebRTC call. The verifier can run a live detection pipeline that sends customer media over the existing Socket.IO connection to Node, which forwards it to the local Python detector service and shows fused risk scores.

## Requirements

- Node.js 18 or later and npm
- Local MongoDB Community Server
- Gmail app password for email delivery (optional)

## Install and configure

```sh
npm install
Copy-Item .env.example .env
```

MongoDB connects through Mongoose to `mongodb://127.0.0.1:27017/kycshield` by default. Start the local MongoDB service before running the app. Set `MONGO_URL` only if you need a different local URL.

For invite email, enable 2-Step Verification on the Gmail account, create a Google app password, and set `SMTP_USER` and `SMTP_PASS`. Do not use the normal Gmail password. If SMTP is not configured, the invite is still created and its link is returned for manual sharing.

## Run

```sh
npm start
npm run dev
```

Open `http://localhost:1009` (or the port configured in `.env`).

## Run the Python detection service

Start the Node server and local MongoDB as above. In a second terminal, activate the existing Python environment under `ml-service/.venv` (or create a Python 3.10+ environment there if needed), install the base requirements, copy the service env file, and start FastAPI:

```powershell
cd ml-service
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --host 127.0.0.1 --port 8000
```

Mac/Linux activation and environment commands are in [ml-service/README.md](ml-service/README.md). Open <http://127.0.0.1:8000/docs> to view the Python API. Set `DETECTOR_BACKEND=mock` for the default mock mode, and set the Node `ML_SERVICE_URL` to the Python service URL if it differs from the default.

Once a customer video is connected, use **Start analysis** in the verifier room. The verifier's browser captures frames and short audio windows from the remote stream and sends them only to this Node server over Socket.IO. The Node server stores numeric scores and reason text, never the media. Mock results are illustrative and are not real detection.

## Camera checks and liveness challenges

After camera permission is granted, the customer can choose a camera from **Camera** on the join page. KYCShield checks the active device label on the server against known virtual-camera names and notes if another listed virtual camera is installed. The active-device label and flag are saved with the session; no camera media is saved.

To try a virtual camera, install OBS Studio, select **Start Virtual Camera** in OBS, then choose that device from the customer's `#camera-select` dropdown. The verifier room should show a rust virtual-camera warning and add the configured `VCAM_RISK_BONUS` to the risk score.

The verifier can select **Send liveness challenge** while the customer is connected. The server chooses a random instruction and starts the `CHALLENGE_TTL_MS` countdown. The verifier observes the response and marks **Pass** or **Fail**; if no result is submitted before the timer ends, the challenge is recorded as a timeout. Pass adds an informational reason without lowering risk. Fail or timeout adds `LIVENESS_FAIL_BONUS`. Challenge type and result are saved with the session; digit challenges are not stored with their digits.

### Demo a fake scenario

With the Python service running in mock mode, open <http://127.0.0.1:8000/docs>, expand `POST /mock/scenario`, and execute it with:

```json
{"face":"fake","audio":"fake"}
```

New detector requests will then return high mock scores. Restore the default scenario with `{"face":"real","audio":"real"}`.

## Routes

- `POST /api/invites` creates an invite and pending session.
- `GET /api/invites/:token/validate` checks an invite.
- `GET /api/sessions` returns the latest five sessions.
- `POST /api/sessions/:roomId/decision` saves an `approved` or `rejected` decision.
- `GET /join/:token` renders the public consent page.
- `GET /room/:roomId` renders the verifier's live call room.
- `GET /dashboard` opens the analyst dashboard.
- `GET /dashboard/sessions/:roomId` opens a session review.
- `GET /api/sessions/:roomId/report.pdf` downloads a PDF audit report.
- `GET /api/dashboard/feedback.csv` downloads labeled-session feedback for a future retraining queue.

## Analyst dashboard and audit reports

After starting the Node server, open <http://localhost:1009/dashboard>. Set `DASHBOARD_USER` and `DASHBOARD_PASS` in the root `.env` and restart the server to require HTTP Basic authentication for analyst pages, dashboard APIs, analyst feedback, and PDF reports. For example, replace the placeholders below with your own credentials:

```dotenv
DASHBOARD_USER=analyst
DASHBOARD_PASS=replace-with-a-long-random-password
```

On localhost, the app can run without these credentials and prints a warning. If `PUBLIC_BASE_URL` is not a localhost URL, the server exits at startup unless both credentials are set. Configure credentials before using ngrok or any public URL.

## Security

Set these values in the root `.env` before exposing KYCShield:

```dotenv
DASHBOARD_USER=your-verifier-and-analyst-user
DASHBOARD_PASS=use-a-long-unique-password
VERIFIER_TOKEN_SECRET=use-a-long-random-secret
VERIFIER_GRACE_MS=30000
```

The root page, verifier rooms, invite creation, recent-session API, decision API, and analyst routes require HTTP Basic authentication. Customer invite pages and invite validation remain public so recipients can join. Invite validation is limited to 60 requests per minute per IP; Socket.IO room joins are limited to 20 attempts per minute per IP. Static assets remain public.

Each verifier room page receives a signed HMAC-SHA256 token scoped to its room and valid for 12 hours. The socket server checks that token before granting the verifier role. If `VERIFIER_TOKEN_SECRET` is blank, the server generates a random secret at startup and warns that verifier tokens will reset on restart. Set a stable secret when you deploy so active room pages do not become invalid after a restart.

If the verifier socket briefly disconnects or its page refreshes, the customer's page stays open while the verifier slot is reserved for `VERIFIER_GRACE_MS` (30 seconds by default). Rejoining with a valid room token cancels the grace timer and starts a fresh WebRTC offer. Clicking **End call** ends the session immediately. Basic security headers are applied to all HTTP responses.

The dashboard refreshes its statistics and paginated session list every 10 seconds. Open a row's **View** link for the score timeline, reason counts, liveness and virtual-camera results, and analyst feedback. Select **Download audit report** to stream a PDF. Reports with simulated detections include a MOCK warning banner. The feedback CSV is available from the dashboard header.

The room's **Approve** or **Reject** action reveals an analyst feedback card. Choose **Mark fraud** or **False alarm**, optionally add a note up to 300 characters, and save. Feedback is upserted by room and stores the latest risk and label at feedback time. Session summaries are recomputed from that room's Score documents when a decision is saved, the call ends, or later scores are stored.

## Test a call locally

1. Start the local MongoDB service, then run `npm start`.
2. Open `http://localhost:1009` in one browser tab. If credentials are configured, authenticate in the browser prompt. Send an invite to a phone number so you can copy its link.
3. Open the customer invite link in a second tab in the same browser. In the verifier tab, select **Open my room**.
4. In the customer tab, agree to join. Allow camera and microphone access in both tabs.
5. Approve or reject the call from the verifier room. The decision is saved to the session.
6. Refresh the verifier room while connected. The customer should see **Verifier reconnecting...** and remain on the call page; the verifier should rejoin and establish a fresh video connection within the grace period. Clicking **End call** should end it immediately.

## Test from a phone with ngrok

1. Set `DASHBOARD_USER`, `DASHBOARD_PASS`, and a stable random `VERIFIER_TOKEN_SECRET` in `.env`.
2. Run `ngrok http 1009` while the app is running.
3. Set `PUBLIC_BASE_URL` in `.env` to the HTTPS forwarding URL shown by ngrok, then restart the app and create a fresh invite.
4. Open the invite link on the phone and allow camera and microphone access. Keep the authenticated verifier tab open on the computer.

Ngrok can carry the Socket.IO signaling connection. Video and audio travel directly between browsers using WebRTC; this project configures the requested public STUN server and does not include a TURN relay, so some network combinations may not establish media.
