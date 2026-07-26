# 💸 Spending

A private Progressive Web App that links your bank accounts through **Plaid**,
categorizes every transaction, and shows you exactly what you're spending your
money on. Tap the icon on your iPhone → get an up-to-date reading.

This is a **fully standalone project** — its own code and its own
[Convex](https://convex.dev) backend/database. It is not connected to any other
app. Your bank login never touches this app (Plaid handles it), and your
long-lived access token lives only on the Convex server, never in the browser.

<!-- Add a screenshot here after your first run, e.g. web/screenshot.png -->

---

## What you get

- **Hero number** — total spent in the last 7 / 30 / 90 days
- **Where it goes** — donut + legend broken down by category (Food & Drink,
  Shopping, Bills, Transport, …)
- **Top merchants** and **spend by month**
- **Recent transactions** feed
- **Account picker** — view one account or all combined
- **Credit-card watch** — how much you've put on credit cards this month (goal $0)
- **Subscription finder** — surfaces recurring charges so you can cancel unused ones
- **Monthly budgets** — set a cap per category with an over-budget alert
- **Business tagging + CSV export** — mark business expenses and export for taxes
- **Passcode lock** (with optional Face ID / fingerprint) so the app is protected
  on your phone
- **Daily auto-refresh** (a Convex cron) so the number is fresh when you open it,
  plus a manual refresh button (↻)
- Installs to the iPhone home screen with its own app icon

Accurate by design: internal transfers and credit-card bill payments are excluded
from spending totals, so moving money around or paying a card never double-counts.

## Project layout

```
spending-app/
├── convex/            # backend (your own Convex deployment)
│   ├── schema.ts      # plaidItems + bankTransactions tables
│   ├── plaid.ts       # link token, token exchange, transaction sync, summaries
│   └── crons.ts       # daily auto-sync
└── web/               # static PWA front-end (host anywhere over https)
    ├── index.html     # the whole app (UI + charts + Plaid Link + Convex client)
    ├── config.js      # <-- paste YOUR Convex URL here
    ├── manifest.webmanifest
    ├── sw.js          # service worker (installability + offline shell)
    └── icon-*.png / apple-touch-icon.png
```

---

## One-time setup (≈ 15 minutes)

### 1. Get free Plaid API keys
1. Sign up at <https://dashboard.plaid.com/signup>.
2. **Developers → Keys** — copy your **client_id** and the **Sandbox** secret.
   (Sandbox links to fake test banks so you can see everything work first.
   Request **Production** access later to link your real bank.)

### 2. Create this app's Convex backend
From the project root:

```bash
npm install
npx convex dev        # creates YOUR deployment, generates types, deploys plaid.ts + crons
```

`npx convex dev` prints your deployment URL (e.g. `https://your-project-123.convex.cloud`).
Then set your Plaid secrets on that deployment:

```bash
npx convex env set PLAID_CLIENT_ID  your_client_id_here
npx convex env set PLAID_SECRET     your_sandbox_secret_here
npx convex env set PLAID_ENV        sandbox      # change to "production" for real banks
```

### 3. Point the front-end at your backend
Open **`web/config.js`** and paste the deployment URL from step 2:

```js
window.SPENDING_CONVEX_URL = "https://your-project-123.convex.cloud";
```

### 4. Serve the `web/` folder over https
Plaid Link and “Add to Home Screen” both require https. Any static host works:

```bash
npm run web            # local preview: npx serve web
```

For a real deployment, drop the `web/` folder on Netlify / Vercel / GitHub Pages /
Cloudflare Pages.

### 5. Add it to your iPhone
1. Open the app's URL in **Safari** on your iPhone.
2. Enter a **private sync code** — any secret phrase. It's how the app finds your
   data across devices; use the same phrase everywhere.
3. Tap **Share → Add to Home Screen**. You now have a **Spending** icon.
4. Tap it → **Connect a bank** → log in through Plaid.

In Sandbox, use Plaid's test login: username `user_good`, password `pass_good`.

---

## Keeping it up to date
- A Convex cron (`sync bank transactions`) refreshes every linked bank once a day
  at 6 AM ET.
- Opening the app also kicks a background sync, and the ↻ button forces one.

## Privacy model (read this)
Data is scoped by your **sync code**. There is no password wall — **anyone who
knows your sync code can read your spending summary** via the Convex API. So:

- Use a long, non-obvious sync code (not your email).
- Your Plaid **access token is never exposed** to the browser — it's only readable
  by server-side (`internalQuery`) code.
- To lock this down further, add real auth (Convex Auth) and gate the
  `spendingSummary` / `recentTransactions` / `listItems` queries on the signed-in
  user instead of a shared sync code.

## Cost
Plaid Sandbox is free and unlimited. Plaid Production has a free tier for a small
number of linked items — see <https://plaid.com/pricing/>.

## License
MIT
