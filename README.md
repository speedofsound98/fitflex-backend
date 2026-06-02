# FitFlex Backend

Node.js + Express 5 + PostgreSQL API for the FitFlex fitness marketplace.

---

## Stack

- Node.js + Express 5
- PostgreSQL (local via Homebrew, production via Render PostgreSQL)
- bcryptjs — password hashing
- jsonwebtoken — JWT auth (httpOnly cookie + Authorization header fallback)
- Resend — transactional email + .ics calendar attachments
- Stripe — credit pack payments
- Twilio — WhatsApp notifications (optional)
- node-cron — 24h class reminder scheduler

---

## Folder Structure

```
fitflex-backend/
├── server.js               ← All routes in one file
├── schema/
│   └── fitflex_schema.sql  ← PostgreSQL table definitions
├── .env                    ← Environment variables (never committed)
├── package.json
└── README.md
```

---

## Local Setup

**1. Install dependencies**
```bash
npm install
```

**2. Create `.env`**
```
PORT=3000
DATABASE_URL=postgresql://<your-mac-username>@localhost:5432/fitflex
FRONTEND_URL=http://localhost:5173
ADMIN_SECRET=fitflex-admin-2026!
JWT_SECRET=your-random-secret
NODE_ENV=development

# Email (leave blank to skip in dev — emails log to console instead)
RESEND_API_KEY=
RESEND_FROM_EMAIL=FitFlex <noreply@yourdomain.com>

# Stripe (leave blank to disable payments)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Twilio WhatsApp (leave blank to disable)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```

**3. Start PostgreSQL and create the DB**
```bash
brew services start postgresql
createdb fitflex
psql fitflex < schema/fitflex_schema.sql
```

**4. Start the server**
```bash
node server.js
# → http://localhost:3000
```

**5. Verify**
```bash
curl http://localhost:3000/api/ping
# → {"ok":true,"message":"pong from backend"}
```

---

## Auth

- JWT signed on login/signup, stored in **httpOnly cookie** + returned in response body
- Frontend sends JWT as `Authorization: Bearer <token>` header on all authenticated requests
- `requireAuth` middleware accepts either cookie or header
- `POST /api/logout` clears the cookie

---

## API Endpoints

### Public
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/ping` | Health check |
| POST | `/api/signup/user` | `{name, email, password}` |
| POST | `/api/signup/studio` | `{name, email, password, location?}` |
| POST | `/api/login` | Rate limited 20/15min |
| POST | `/api/logout` | Clears cookie |
| GET | `/api/classes` | All classes with studio info |
| GET | `/api/sport-types` | Sport type list |
| GET | `/api/studios/:id` | Public studio profile |
| GET | `/api/studios/:id/classes` | Studio's classes |
| GET | `/api/credit-packs` | Available credit packs |
| GET | `/api/users/:id/profile` | Public user profile |
| POST | `/auth/request-password-reset` | Rate limited 5/hr |
| POST | `/auth/reset-password` | `{token, newPassword}` |

### User (JWT required)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/book` | Checks credits + capacity, deducts credits |
| DELETE | `/api/bookings/:id` | Cancel + refund credits |
| GET | `/api/users/:id/bookings` | Booking history |
| GET | `/api/users/:id/settings` | Private settings |
| PATCH | `/api/users/:id/settings` | Update name, bio, phone, public_fields |
| PATCH | `/api/users/:id/password` | Change password |
| GET | `/api/users/:id/purchases` | Credit purchase history |
| POST | `/api/payments/create-session` | Stripe Checkout session |

### Studio (JWT required)
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/studios/:id/classes` | Create class |
| PATCH | `/api/classes/:id` | Update class |
| DELETE | `/api/classes/:id` | Delete class |
| POST | `/api/classes/:id/message` | Email + notify all booked users |
| GET | `/api/studios/:id/analytics` | Booking counts per class |
| PATCH | `/api/studios/:id` | Update profile (incl. accepts_enquiries) |
| PATCH | `/api/studios/:id/password` | Change password |
| POST | `/api/studios/:id/enquire` | User sends custom time enquiry |

### Notifications (JWT required)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/notifications` | Last 50 notifications + unread count |
| PATCH | `/api/notifications/read-all` | Mark all as read |
| PATCH | `/api/notifications/:id/read` | Mark one as read |

### Admin (`x-admin-secret` header required)
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/admin/stats` | Platform counts |
| GET | `/api/admin/users` | All users + booking_count |
| GET | `/api/admin/studios` | All studios |
| GET | `/api/admin/bookings` | All bookings |
| DELETE | `/api/admin/users/:id` | Delete user |
| DELETE | `/api/admin/studios/:id` | Delete studio |
| PATCH | `/api/admin/studios/:id/verify` | `{verified: true/false}` |

### Stripe Webhook
| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/payments/webhook` | Raw body; credits added on payment success |

---

## Database Schema

| Table | Key columns |
|-------|-------------|
| `users` | id, name, email, password, credits(5), bio, public_fields, phone |
| `studios` | id, name, email, password, location, city, neighbourhood, about, phone, website, instagram, verified, accepts_enquiries |
| `classes` | id, studio_id, name, datetime, sport_type, credit_cost, capacity |
| `bookings` | id, user_id, class_id, payment_status, timestamp |
| `password_resets` | id, user_id, token_hash, expires_at |
| `credit_purchases` | id, user_id, credits, amount_cents, stripe_session_id, expires_at |
| `notifications` | id, recipient_type, recipient_id, type, title, body, read |

---

## Production (Render)

**Required env vars:**
| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Render internal PostgreSQL URL |
| `FRONTEND_URL` | Vercel frontend URL |
| `ADMIN_SECRET` | Admin dashboard password |
| `JWT_SECRET` | Random string (`openssl rand -hex 32`) |
| `NODE_ENV` | `production` |

**Optional (for features):**
| Variable | Feature |
|----------|---------|
| `RESEND_API_KEY` | Email notifications |
| `RESEND_FROM_EMAIL` | Email sender address |
| `STRIPE_SECRET_KEY` | Payments |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `TWILIO_ACCOUNT_SID` | WhatsApp |
| `TWILIO_AUTH_TOKEN` | WhatsApp |
| `TWILIO_WHATSAPP_FROM` | WhatsApp sender |

Auto-deploys on push to `main`.
