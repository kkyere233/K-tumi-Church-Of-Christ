# Kukurantumi Church Of Christ Youth Dashboard

The login page, dashboard, Express API, and MongoDB storage run together as one application. Do not open `COC jct.html` directly from File Explorer; the server serves it at `/dashboard` only after sign-in.

## Requirements

- Node.js 20 or newer, with npm
- MongoDB running locally, or a MongoDB Atlas connection string

## Setup

1. In this folder, install dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env` and set `MONGODB_URI`, a unique `SESSION_SECRET` of at least 32 characters, and the first Admin's username, name, email, and unique password of at least 8 characters. `.env` is excluded from Git.

3. Start the app:

   ```powershell
   npm start
   ```

4. Open `http://localhost:3000`. The first run creates the bootstrap Admin account from the `.env` settings. Sign in with the configured username. Admin can create staff accounts and assign roles in **Settings**.

Use `npm run dev` during development. Set `NODE_ENV=production` behind HTTPS before deployment so session cookies are marked secure. If HTTPS terminates at a trusted reverse proxy, set `TRUST_PROXY=1` in `.env`.

## Access

- Admin: staff accounts, members, attendance, announcements, events, finance, reports, and settings
- Secretary: members, attendance, announcements, events, and reports
- Financial Secretary and Treasurer: finance records and reports

The API checks the authenticated session and role on the server. Dashboard role visibility is only presentation; it is not used as the security boundary.