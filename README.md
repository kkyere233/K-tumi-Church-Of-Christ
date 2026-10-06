# Kukurantumi Church Of Christ Youth Dashboard

The login page, dashboard, backend API, and MongoDB storage run together as one application. Do not open `COC jct.html` directly from File Explorer; the server serves it at `/dashboard` only after sign-in.

The active backend is Python with FastAPI and MongoDB. The original Node.js/Express backend is retained as a legacy option.

## Requirements

- Python 3.12+ and pip
- MongoDB running locally, or a MongoDB Atlas connection string
- Optional: Node.js 20+ and npm to build the Netlify frontend or run the legacy Node backend

## Python backend setup

1. In this folder, create a virtual environment and install dependencies:

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   python -m pip install --upgrade pip
   python -m pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and set `MONGODB_URI`, a unique `SESSION_SECRET` of at least 32 characters, and the first Admin's username, name, email, and unique password of at least 8 characters. `.env` is excluded from Git.

3. Start the Python app:

   ```powershell
   python main.py
   ```

4. Open `http://localhost:3000`. The first run creates the bootstrap Admin account from the `.env` settings. Sign in with the configured username. Admin can create staff and Member accounts and assign roles in **Settings**. A Member login is automatically linked to the directory record with the same email address, so create the member record with that email first.

Set `NODE_ENV=production` behind HTTPS before deployment so session cookies are marked secure. If HTTPS terminates at a trusted reverse proxy, set `TRUST_PROXY=1` in `.env`.

## Legacy Node.js backend

If you want to run the original JavaScript backend instead of Python, install Node dependencies and run:

```powershell
npm install
npm run start:node
```

## Open from another laptop on the same Wi-Fi

Keep the app running on the host computer with `python main.py`. Use the URL `http://<host-ip>:3000` on the other laptop, for example `http://192.168.0.129:3000`. Do not use `localhost` on the other laptop; that refers to the other laptop itself.

If the address does not load, allow inbound TCP port 3000 on the host computer's private network. In PowerShell opened as Administrator, run:

```powershell
New-NetFirewallRule -DisplayName "Church dashboard (LAN)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private
```

Both computers must be on the same non-guest Wi-Fi network, and the host computer must stay on with the app running. For public access, host the Python backend on Render and the static frontend on Netlify as described below.

## Deploy with Netlify and Render

Netlify serves the frontend, while Render runs the Python API; Netlify proxies `/api` and `/health` requests to Render so browser requests and session cookies stay on the Netlify site origin.

1. Create a MongoDB Atlas cluster and database user. In Atlas **Network Access**, allow connections from Render. If your Render service does not have fixed outbound IPs, Atlas may require `0.0.0.0/0`; use a strong database-user password and grant access only to the app database. Copy Atlas's `mongodb+srv://` connection string and replace its placeholders, URL-encoding special characters in the username or password if needed. Do not use a localhost URI or commit this credential.
2. Deploy the Render backend from this repository using `render.yaml`. In the Render service's environment settings, set `MONGODB_URI` to that Atlas connection string, along with the bootstrap Admin values and generated `SESSION_SECRET`. Keep `NODE_ENV=production` and `TRUST_PROXY=1`. The app verifies MongoDB connectivity during startup and rejects localhost URIs in production. Note the deployed backend origin, such as `https://your-service.onrender.com`.
3. In Netlify, import the same GitHub repository. The included `netlify.toml` sets the build command and publish directory. Add the build environment variable `RENDER_BACKEND_URL` with the Render backend origin only, for example `https://your-service.onrender.com` (no path).
4. Deploy the Netlify site and note its primary origin, for example `https://your-site.netlify.app`.
5. In the Render service environment, set `ALLOWED_ORIGINS` to the exact Netlify origin, including `https://`. For a custom domain, include both origins separated by a comma. Redeploy Render after changing this setting.
6. Visit the Netlify site's `/health` route and confirm it returns `{"status":"ok"}`. Then sign in and verify that the dashboard loads and data can be read and saved.

The Netlify build intentionally fails when `RENDER_BACKEND_URL` is missing or is not an HTTPS origin. Do not publish the repository root as a static site; the build copies only the login page, dashboard, and logo assets into `dist`.

The Render blueprint uses its free plan, which may sleep when idle. Netlify's proxy has a 26-second request timeout, so a cold start may make the first login or API request time out. Use an always-on Render plan if this happens or if reliable immediate access is important. Netlify deploy-preview URLs are not automatically allowed; add an exact preview origin to Render's `ALLOWED_ORIGINS` if you need to test a preview.

## Access

- Admin: staff accounts, members, attendance, announcements, events, finance, reports, and settings
- Secretary: members, attendance, announcements, events, and reports
- Financial Secretary and Treasurer: finance records and reports
- Member: a personal dashboard showing dues paid and outstanding by month

The API checks the signed-in session and role on the server. Dashboard role visibility is only presentation; it is not used as the security boundary.

Finance staff can record a member's dues for a specific month. The directory and Member login forms use an age-group selection rather than asking for an exact age: below 20 is GHS 10 per month, and 20 or above (including age 20) is GHS 20 per month. The amount is saved with the directory member and enforced when finance staff record payments. Enter `0` as the amount paid to register a month that remains unpaid. A member's monthly dues history lists all 12 months of the current year at the member's applicable rate when no saved record exists. Existing dues records retain their saved expected amounts, and records created before monthly tracking remain visible as legacy totals without an assigned month.

Member directory records store an age group and can also store optional marital status and contact phone details. The site displays the selected age group, not an exact age.