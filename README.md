# FitFlex Backend

Node.js + Express 5 + PostgreSQL API for the FitFlex fitness marketplace.

---

## Folder Structure

```
fitflex-backend/
├── server.js               ← All routes (single file)
├── schema/
│   └── fitflex_schema.sql  ← PostgreSQL table definitions
├── .env                    ← Environment variables (not committed)
├── package.json
└── README.md
```

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (`brew install postgresql@14`)

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
ADMIN_SECRET=change-this-to-a-strong-secret
```

**3. Start PostgreSQL**
```bash
brew services start postgresql
```

**4. Create and seed the database**
```bash
createdb fitflex
psql fitflex < schema/fitflex_schema.sql

# Create the password_resets table (if not in schema)
psql fitflex -c "
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);"
```

**5. Start the server**
```bash
node server.js
# → http://localhost:3000
```

**6. Verify it's running**
```bash
curl http://localhost:3000/api/ping
# → {"ok":true,"message":"pong from backend"}
```

---

## API Endpoints

### Auth
| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/signup/user` | `{ name, email, password }` | Register user |
| POST | `/api/signup/studio` | `{ name, email, password, location? }` | Register studio |
| POST | `/api/login` | `{ email, password }` | Login (user or studio) |
| POST | `/auth/request-password-reset` | `{ email }` | Send reset token |
| POST | `/auth/reset-password` | `{ token, newPassword }` | Apply reset |

All auth responses return `{ user: { id, name, email, role } }`.

### Classes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/classes` | All classes with studio info |
| GET | `/api/studios/:studioId/classes` | Classes for a specific studio |
| POST | `/api/studios/:studioId/classes` | Create a class |
| PATCH | `/api/classes/:classId` | Update a class |
| DELETE | `/api/classes/:classId` | Delete a class |

### Bookings
| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/book` | `{ user_id, class_id }` | Book a class |

### Admin
All admin endpoints require the header `x-admin-secret: <ADMIN_SECRET>`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List all users |
| GET | `/api/admin/studios` | List all studios |
| GET | `/api/admin/bookings` | List all bookings with user/class/studio info |
| DELETE | `/api/admin/users/:id` | Delete a user |
| DELETE | `/api/admin/studios/:id` | Delete a studio |

Example:
```bash
curl -H "x-admin-secret: your-secret" http://localhost:3000/api/admin/users
```

---

## Inspecting the Database

```bash
psql fitflex                          # open interactive session
psql fitflex -c "SELECT * FROM users;" # one-liner
```

Useful queries:
```sql
SELECT id, name, email, credits FROM users;
SELECT id, name, email, location FROM studios;
SELECT id, name, datetime, sport_type FROM classes ORDER BY datetime;
SELECT b.id, u.name, c.name FROM bookings b JOIN users u ON u.id=b.user_id JOIN classes c ON c.id=b.class_id;
```

---

## Git Workflow

```bash
git add <files>
git commit -m "Describe your change"
git pull origin main
git push origin main
```

Render auto-redeploys on push to `main`.

---

## Deployment (Render)

1. Connect the `fitflex-backend` GitHub repo to a Render Web Service
2. Build command: `npm install`
3. Start command: `node server.js`
4. Set environment variables in Render dashboard: `DATABASE_URL`, `FRONTEND_URL`, `ADMIN_SECRET`, `PORT=10000`

See `../DEPLOY_WORKFLOW.md` for full step-by-step instructions.
