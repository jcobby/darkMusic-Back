# Dark Music Yard (DMY)

Official website for **Dark Music Yard** — music, free beats, merch, feature
bookings and brand promotion, with Paystack checkout and an admin dashboard.

> _Stream everywhere. Support directly here._

- **`frontend/`** — Next.js (App Router) + Tailwind CSS
- **`backend/`** — Node.js + Express + MongoDB (Mongoose), Paystack, file storage

## Features

- **Home** — hero, latest releases, featured video, featured merch, booking & brand CTAs
- **Music** — Spotify / Apple / YouTube links + paid MP3 downloads (GH₵10)
- **Free Beats** — free MP3 download + paid studio WAV (GH₵100)
- **Merch** — t-shirts, hoodies, caps, posters, signed & limited editions
- **Features / Brand Promotion / Contact** — inquiry forms saved to the database
- **Checkout** — Paystack (cards + MTN / Telecel Mobile Money); digital files are
  delivered via time-limited download links right after payment
- **Admin** (`/admin`) — manage releases/beats/merch and read inquiries & orders

## Prerequisites

- Node.js 18.18+ (20 LTS recommended)
- MongoDB — local `mongod` or a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster
- A [Paystack](https://dashboard.paystack.com) account (test keys are fine to start)

## Setup

```bash
# 1. Install all dependencies (root + frontend + backend)
npm run install:all

# 2. Configure environment variables
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Then edit **`backend/.env`** and set at least:

- `MONGODB_URI` — your local or Atlas connection string
- `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` — admin login
- `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY` — to enable checkout

## Seed example content

Populates the catalog with the sample releases, beats and merch (plus
placeholder media files so the buy/download flow works end-to-end):

```bash
npm --prefix backend run seed
```

## Run in development

```bash
npm run dev
```

- Frontend → http://localhost:3000
- Backend  → http://localhost:5000
- Admin    → http://localhost:3000/admin
- Health   → http://localhost:5000/api/health

## Payments (Paystack)

1. Put your **test** secret/public keys in `backend/.env`.
2. Add a download (MP3/WAV) or merch item to the cart and check out — you'll be
   redirected to Paystack's hosted page. Pay with a
   [test card](https://paystack.com/docs/payments/test-payments) or test Mobile Money.
3. You return to `/checkout/callback`, which verifies the payment and shows your
   download links.
4. **Webhook (recommended):** in the Paystack dashboard set the webhook URL to
   `https://<your-api-host>/api/checkout/paystack/webhook`. It's the source of
   truth that marks orders paid. (Locally, expose it with a tunnel such as
   `ngrok` or `cloudflared`.)

## Production build

```bash
npm run build
npm run start:backend   # serves the compiled API from backend/dist
npm run start:frontend  # serves the Next.js production build
```

## Fill in your branding

- Logo / artist photo → `frontend/public/` (see `frontend/public/README.md`)
- Streaming, social, WhatsApp, emails → `frontend/.env.local` (`NEXT_PUBLIC_*`)
- Cover art, audio files and merch photos → uploaded via `/admin`

## API overview

Base URL: `http://localhost:5000/api`

| Method | Route                          | Description                         |
| ------ | ------------------------------ | ----------------------------------- |
| GET    | `/health`                      | Service health                      |
| GET    | `/releases`, `/beats`, `/merch`| Public catalog (`?featured=true`)   |
| GET    | `/beats/:slug/free`            | Free beat MP3 download              |
| POST   | `/inquiries`                   | Feature / brand / contact submission|
| POST   | `/checkout/initialize`         | Start a Paystack payment            |
| GET    | `/checkout/verify`             | Verify a payment                    |
| POST   | `/checkout/paystack/webhook`   | Paystack webhook (HMAC verified)    |
| GET    | `/download/:token`             | Download a purchased file           |
| POST   | `/auth/login`                  | Admin login → JWT                   |
| *      | `/admin/*`                     | Catalog CRUD + inquiries/orders (JWT)|

## Project structure

```
DarkYard/
├── frontend/             # Next.js app
│   └── src/
│       ├── app/          # pages (home, music, free-beats, merch, features,
│       │                 #        brand-promotion, contact, cart, checkout, admin)
│       ├── components/   # UI + admin dashboard components
│       ├── config/site.ts
│       └── lib/          # api.ts (public) + adminApi.ts (authed)
└── backend/              # Express API
    └── src/
        ├── models/       # Release, Beat, MerchProduct, Inquiry, Order
        ├── controllers/  # catalog, inquiry, checkout, auth, admin
        ├── services/     # paystack, storage, upload, mailer
        ├── routes/       # route definitions
        ├── scripts/seed.ts
        ├── app.ts        # express app
        └── index.ts      # server entry
```
