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

// =====================
// Studio class manager
// =====================

// GET /api/studios/:studioId/classes
app.get('/api/studios/:studioId/classes', async (req, res) => {
  const studioId = Number(req.params.studioId);
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  try {
    const r = await query(
      `SELECT c.id, c.name, c.datetime, c.sport_type, c.credit_cost, c.capacity
         FROM classes c
        WHERE c.studio_id = $1
        ORDER BY c.datetime DESC`,
      [studioId]
    );
    res.json({ classes: r.rows });
  } catch (e) {
    console.error('list studio classes error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/studios/:studioId/classes
// body: { name, datetime, sport_type, credit_cost, capacity }
app.post('/api/studios/:studioId/classes', async (req, res) => {
  const studioId = Number(req.params.studioId);
  const { name, datetime, sport_type, credit_cost, capacity } = req.body || {};
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  if (!name || !datetime) return res.status(400).json({ error: 'name and datetime are required' });

  // Basic normalization
  const creditCost = Number.isFinite(+credit_cost) ? +credit_cost : 1;
  const cap = Number.isFinite(+capacity) ? +capacity : null;

  try {
    const r = await query(
      `INSERT INTO classes (studio_id, name, datetime, sport_type, credit_cost, capacity)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, datetime, sport_type, credit_cost, capacity`,
      [studioId, name.trim(), new Date(datetime), (sport_type || null), creditCost, cap]
    );
    res.status(201).json({ class: r.rows[0] });
  } catch (e) {
    console.error('create class error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/classes/:classId
// body: any of { name, datetime, sport_type, credit_cost, capacity }
app.patch('/api/classes/:classId', async (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId)) return res.status(400).json({ error: 'Invalid class id' });

  const fields = [];
  const values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(req.body || {})) {
    if (['name','datetime','sport_type','credit_cost','capacity'].includes(k)) {
      fields.push(`${k} = $${idx++}`);
      values.push(k === 'datetime' ? new Date(v) : v);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

  try {
    const r = await query(
      `UPDATE classes SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, datetime, sport_type, credit_cost, capacity`,
      [...values, classId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Class not found' });
    res.json({ class: r.rows[0] });
  } catch (e) {
    console.error('update class error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/classes/:classId
app.delete('/api/classes/:classId', async (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId)) return res.status(400).json({ error: 'Invalid class id' });
  try {
    // optional: cascade or rely on FK behavior; here we just try to delete
    const r = await query('DELETE FROM classes WHERE id = $1 RETURNING id', [classId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Class not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('delete class error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});


const crypto = require('crypto');
const bcrypt = require('bcrypt'); // or require('bcryptjs')

/** POST /auth/request-password-reset
 * Body: { email }
 * - If email exists, generate a token, store its hash + expiry, and (in prod) email the link.
 * - Always return 200 to avoid email enumeration.
 */
app.post('/auth/request-password-reset', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (user.rows.length > 0) {
      const userId = user.rows[0].id;
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expires = new Date(Date.now() + 1000 * 60 * 30); // 30 minutes

      // If using users columns:
      // await pool.query(
      //   'UPDATE users SET reset_token_hash=$1, reset_token_expires=$2 WHERE id=$3',
      //   [tokenHash, expires, userId]
      // );

      // If using password_resets table (recommended):
      await pool.query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [userId, tokenHash, expires]
      );

      // In development, return the reset link so you can click it without email
      const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset?token=${token}`;
      return res.json({ message: 'If the email exists, a reset link has been sent.', devResetLink: resetLink });
    }

    return res.json({ message: 'If the email exists, a reset link has been sent.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** POST /auth/reset-password
 * Body: { token, newPassword }
 * - Verifies token, expiry; updates password; clears the token entry.
 */
app.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and newPassword required' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    // If using users columns:
    // const found = await pool.query(
    //   'SELECT id FROM users WHERE reset_token_hash=$1 AND reset_token_expires > NOW()',
    //   [tokenHash]
    // );

    // If using password_resets table:
    const found = await pool.query(
      `SELECT pr.user_id
       FROM password_resets pr
       WHERE pr.token_hash = $1 AND pr.expires_at > NOW()
       ORDER BY pr.id DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (found.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const userId = found.rows[0].user_id;
    const hashed = await bcrypt.hash(newPassword, 10);

    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, userId]);

    // Clear used tokens
    // For users-column approach:
    // await pool.query('UPDATE users SET reset_token_hash=NULL, reset_token_expires=NULL WHERE id=$1', [userId]);

    // For password_resets table: delete this token (and optionally all tokens for this user)
    await pool.query('DELETE FROM password_resets WHERE user_id=$1', [userId]);

    return res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});


// ---- Start ----
app.listen(port, '0.0.0.0', () => {
  console.log(`FitFlex backend running on http://0.0.0.0:${port}`);
});
