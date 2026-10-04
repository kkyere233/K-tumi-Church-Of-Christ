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

4. Open `http://localhost:3000`. The first run creates the bootstrap Admin account from the `.env` settings. Sign in with the configured username. Admin can create staff and Member accounts and assign roles in **Settings**. A Member login is automatically linked to the directory record with the same email address, so create the member record with that email first.

Use `npm run dev` during development. Set `NODE_ENV=production` behind HTTPS before deployment so session cookies are marked secure. If HTTPS terminates at a trusted reverse proxy, set `TRUST_PROXY=1` in `.env`.

## Open from another laptop on the same Wi-Fi

Keep the app running on the host computer with `npm start`. Use the `Same-network access` URL printed in its terminal on the other laptop, for example `http://192.168.0.129:3000`. Do not use `localhost` on the other laptop; that refers to the other laptop itself.

If the address does not load, allow inbound TCP port 3000 on the host computer's private network. In PowerShell opened as Administrator, run:

```powershell
New-NetFirewallRule -DisplayName "Church dashboard (LAN)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -Profile Private
```

Both computers must be on the same non-guest Wi-Fi network, and the host computer must stay on with the app running. For access from outside that network, deploy the app to a public host such as Render instead; the LAN address is not public.

## Access

- Admin: staff accounts, members, attendance, announcements, events, finance, reports, and settings
- Secretary: members, attendance, announcements, events, and reports
- Financial Secretary and Treasurer: finance records and reports
- Member: a personal dashboard showing dues paid and outstanding by month

The API checks the authenticated session and role on the server. Dashboard role visibility is only presentation; it is not used as the security boundary.

Finance staff can record a member's dues for a specific month. The directory and Member login forms use an age-group selection rather than asking for an exact age: below 20 is GHS 10 per month, and 20 or above (including age 20) is GHS 20 per month. The amount is saved with the directory member and enforced when finance staff record payments. Enter `0` as the amount paid to register a month that remains unpaid. A member's monthly dues history lists all 12 months of the current year at the member's applicable rate when no saved record exists. Existing dues records retain their saved expected amounts, and records created before monthly tracking remain visible as legacy totals without an assigned month.

Member directory records store an age group and can also store optional marital status and contact phone details. The site displays the selected age group, not an exact age.