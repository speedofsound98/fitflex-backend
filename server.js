// server.js (CommonJS)
// npm i express pg cors bcryptjs dotenv
// Ensure you have a .env with PORT and DATABASE_URL

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();

// ---- Config ----
const port = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Accept JSON bodies
app.use(express.json());

// CORS: allow Vite on localhost:5173 and your LAN IP (adjust regex if needed)
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      // Allow any 192.168.x.x:5173 origin (dev on LAN)
      /http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
      /http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
      /http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+(:\d+)?$/,
    ],
    credentials: true,
  })
);

// ---- Helpers ----
async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ---- Routes ----

// Health
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, message: 'pong from backend' });
});

// TEMP: debug bcrypt for Alice
app.get('/api/debug-bcrypt-alice', async (req, res) => {
  try {
    const { rows } = await query("SELECT password FROM users WHERE lower(email)='alice@example.com'");
    const hash = rows?.[0]?.password || '';
    const ok = await require('bcryptjs').compare('secret123', hash);
    res.json({ haveHash: !!hash, hashPrefix: hash.slice(0,7), ok });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'debug failed' });
  }
});



// SIGNUP: user
// body: { name, email, password }
app.post('/api/signup/user', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }

  try {
    const exists = await query(
      'SELECT 1 FROM users WHERE name = $1 OR email = $2',
      [name, email]
    );
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Name or email already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    await query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3)',
      [name, email, hashed]
    );

    // Minimal payload for UI
    res.status(201).json({
      user: { name, email, role: 'user' },
      message: 'User registered successfully',
    });
  } catch (err) {
    console.error('signup/user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// SIGNUP: studio
// body: { name, email, password, location? }
app.post('/api/signup/studio', async (req, res) => {
  const { name, email, password, location } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }

  try {
    // Optional: one-studio-only guard
    // const count = await query('SELECT COUNT(*)::int AS c FROM studios');
    // if (count.rows[0].c >= 1) {
    //   return res.status(403).json({ error: 'Studio sign-up is closed for MVP' });
    // }

    const exists = await query(
      'SELECT 1 FROM studios WHERE name = $1 OR email = $2',
      [name, email]
    );
    if (exists.rows.length) {
      return res.status(409).json({ error: 'Studio name or email already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    await query(
      'INSERT INTO studios (name, email, password, location) VALUES ($1, $2, $3, $4)',
      [name, email, hashed, location || null]
    );

    res.status(201).json({
      user: { name, email, role: 'studio' },
      message: 'Studio registered successfully',
    });
  } catch (err) {
    console.error('signup/studio error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// LOGIN (email+password for user or studio)
app.post('/api/login', async (req, res) => {
  try {
    let { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }

    // normalize inputs so casing/whitespace never breaks login
    email = email.trim().toLowerCase();
    password = password.trim();

    // Try users (case-insensitive match)
    let r = await query(
      'SELECT id, name, email, password FROM users WHERE lower(email) = $1',
      [email]
    );
    if (r.rows.length) {
      const u = r.rows[0];
      const ok = await require('bcryptjs').compare(password, u.password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      return res.json({ user: { id: u.id, name: u.name, email: u.email, role: 'user' } });
    }

    // Try studios (case-insensitive match)
    r = await query(
      'SELECT id, name, email, password FROM studios WHERE lower(email) = $1',
      [email]
    );
    if (r.rows.length) {
      const s = r.rows[0];
      const ok = await require('bcryptjs').compare(password, s.password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      return res.json({ user: { id: s.id, name: s.name, email: s.email, role: 'studio' } });
    }

    return res.status(404).json({ error: 'No account found for this email' });
  } catch (err) {
    console.error('[login] error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


// Example classes list (adjust to your needs)
// GET /api/classes
app.get('/api/classes', async (req, res) => {
  try {
    const r = await query(
      `SELECT c.id, c.name, c.datetime, c.sport_type, c.credit_cost, c.capacity,
              s.id AS studio_id, s.name AS studio_name
         FROM classes c
         JOIN studios s ON s.id = c.studio_id
       ORDER BY c.datetime ASC`
    );
    res.json({ classes: r.rows });
  } catch (err) {
    console.error('classes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Example booking endpoint (MVP)
// body: { user_id, class_id }
app.post('/api/book', async (req, res) => {
  const { user_id, class_id } = req.body || {};
  if (!user_id || !class_id) {
    return res.status(400).json({ error: 'user_id and class_id are required' });
  }
  try {
    await query(
      'INSERT INTO bookings (user_id, class_id, payment_status) VALUES ($1, $2, $3)',
      [user_id, class_id, 'paid']
    );
    res.status(201).json({ message: 'Booked successfully' });
  } catch (err) {
    console.error('book error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---- Start ----
app.listen(port, '0.0.0.0', () => {
  console.log(`FitFlex backend running on http://0.0.0.0:${port}`);
});
