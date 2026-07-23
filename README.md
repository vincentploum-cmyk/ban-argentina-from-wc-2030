# Ban Argentina from WC 2030 — Campaign Landing Page

A tongue-in-cheek fan campaign site: a petition to ban the Argentina national
squad from the 2030 World Cup, secure donations via **Stripe Checkout**, a
**daily Top Donors** leaderboard (shown as `First L.` for privacy), and embedded
YouTube clips of the squad's most talked-about moments.

> ⚠️ This is a satirical fan project. It is **not** affiliated with FIFA,
> CONMEBOL, the AFA, or any team/player. If you collect real money, read
> "Running this responsibly" below first.

## Features

- **Landing page** — bold, responsive, mobile-first (`public/`).
- **Petition signing** — name + email, deduplicated, with a live signature counter.
- **Stripe donations** — Checkout Session flow; card details never touch this
  server (Stripe's hosted page handles them).
- **Daily leaderboard** — top donors for the current day + an all-time hall of
  fame, anonymised to `First L.`. Donors opt in to being shown.
- **YouTube gallery** — click-to-load embeds (privacy-friendly `youtube-nocookie`),
  swap in your own clip IDs.
- **Demo mode** — the site runs and is fully clickable before you add Stripe keys.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    then edit .env and add your Stripe keys (see below)

# 3. Run
npm start          # http://localhost:3000
# or: npm run dev  # auto-restarts on file changes (Node 18+)
```

Without Stripe keys the site starts in **demo mode**: everything renders and the
donate button explains that no real charge is made.

## Stripe setup

1. Create a Stripe account and grab your keys from
   <https://dashboard.stripe.com/apikeys>. Use **test** keys (`sk_test_…`,
   `pk_test_…`) while developing.
2. Put them in `.env` (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`).
3. Set up the webhook so confirmed payments land on the leaderboard:

   ```bash
   # install the Stripe CLI, then:
   stripe login
   stripe listen --forward-to localhost:3000/api/webhook
   ```

   Copy the `whsec_…` secret it prints into `STRIPE_WEBHOOK_SECRET` in `.env`.
4. Test with Stripe's card `4242 4242 4242 4242`, any future expiry, any CVC.

For production, create a webhook endpoint in the Stripe Dashboard pointing at
`https://your-domain/api/webhook` for the `checkout.session.completed` event,
and set `PUBLIC_BASE_URL` to your real URL.

## Swapping in the YouTube clips

Edit `public/index.html` and change each `data-yt="…"` attribute in the
`#video-grid` to the YouTube video ID you want (the part after `watch?v=`). The
thumbnail and caption update automatically.

## API

| Method | Path                          | Purpose                                   |
| ------ | ----------------------------- | ----------------------------------------- |
| GET    | `/api/config`                 | Publishable key + feature flags           |
| GET    | `/api/stats`                  | Totals for the hero counters              |
| GET    | `/api/donors/top`             | Top donors (today + all-time), anonymised |
| POST   | `/api/create-checkout-session`| Start a Stripe Checkout donation          |
| POST   | `/api/webhook`                | Stripe webhook (records confirmed donation)|
| POST   | `/api/petition/sign`          | Add a signature                           |

## Data storage

Signatures and donations are kept in JSON files under `data/` (git-ignored) via
`lib/store.js`. This is fine for a demo or low traffic. For anything serious,
replace `lib/store.js` with a real database — the module's surface is small and
that's the only file that needs to change.

## Running this responsibly

If you take real donations from the public, this is no longer just code:

- **Be transparent** about who "we" are and exactly what the money funds.
  The footer already states donations cover campaign/filing/hosting costs — keep
  that honest and specific.
- **Comply with Stripe's terms** and your local fundraising / consumer-protection
  laws. Depending on your country, public fundraising may require registration.
- **Handle personal data lawfully** (e.g. GDPR): only collect what you need, say
  why, and let people opt out. Donors already opt in before appearing on the board.
- **Keep it satire, not defamation.** Comment on public sporting conduct; don't
  publish false statements of fact about individuals.

## Deploy

Any Node host works (Render, Railway, Fly.io, a VPS, etc.). Set the environment
variables from `.env.example`, ensure `data/` is writable (or swap in a DB), and
run `npm start`. Point `PUBLIC_BASE_URL` at your domain.

## License

MIT — see `LICENSE`.
