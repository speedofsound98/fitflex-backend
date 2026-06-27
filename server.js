// server.js (CommonJS)
// npm i express pg cors bcryptjs dotenv jsonwebtoken cookie-parser express-rate-limit resend

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const cron = require('node-cron');
const { Resend } = require('resend');
const Stripe = require('stripe');
const twilio = require('twilio');
const { Pool } = require('pg');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

const app = express();

// ---- Config ----
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'fitflex-dev-secret-change-in-prod';
const isProd = process.env.NODE_ENV === 'production';

// Resend email client (only active when RESEND_API_KEY is set)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'FitFlex <noreply@fitflex.app>';

// Stripe (only active when STRIPE_SECRET_KEY is set)
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Twilio (only active when TWILIO_ACCOUNT_SID is set)
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // Twilio sandbox default

// Credit pack definitions (also used on /pricing page)
const CREDIT_PACKS = [
  { id: 'pack_10',  credits: 10,  price_cents: 1500, label: '10 Credits', popular: false },
  { id: 'pack_25',  credits: 25,  price_cents: 3000, label: '25 Credits', popular: true  },
  { id: 'pack_50',  credits: 50,  price_cents: 5000, label: '50 Credits', popular: false },
];

// ---- Middleware ----
app.use(express.json());
app.use(cookieParser());

// ---- File uploads ----
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter(req, file, cb) {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// CORS: allow local dev + production Vercel frontend
const allowedOrigins = [
  'http://localhost:5173',
  'https://your-portfolio-g56q.vercel.app',
  /https:\/\/fitflex-frontend.*\.vercel\.app$/,
  /http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
  /http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

app.use(cors({ origin: allowedOrigins, credentials: true }));

// ---- Rate limiting ----
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many password reset requests. Please try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---- DB helper ----
async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ---- JWT / Cookie helpers ----
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie('fitflex_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

// optionalAuth — reads JWT if present, returns null if missing/invalid (no blocking)
function optionalAuth(req) {
  let token = req.cookies?.fitflex_token;
  if (!token) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  }
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// requireAuth middleware — verifies JWT from cookie OR Authorization header
function requireAuth(req, res, next) {
  let token = req.cookies?.fitflex_token;
  if (!token) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
  }
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

// ---- Email helpers ----

// Format a Date for .ics (YYYYMMDDTHHMMSSZ)
function toICSDate(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// Generate an .ics calendar invite string
function buildICS({ uid, summary, dtstart, dtend, location, description, organizer }) {
  const now = toICSDate(new Date());
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FitFlex//FitFlex//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}@fitflex.app`,
    `DTSTAMP:${now}`,
    `DTSTART:${toICSDate(dtstart)}`,
    `DTEND:${toICSDate(dtend)}`,
    `SUMMARY:${summary}`,
    location ? `LOCATION:${location}` : '',
    description ? `DESCRIPTION:${description.replace(/\n/g, '\\n')}` : '',
    organizer ? `ORGANIZER;CN="${organizer.name}":mailto:${organizer.email}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

// Send an email via Resend (gracefully no-ops if not configured)
async function sendEmail({ to, subject, html, icsContent }) {
  if (!resend) {
    console.log(`[email] Not configured — would have sent to ${to}: ${subject}`);
    return;
  }
  try {
    const payload = { from: FROM_EMAIL, to: Array.isArray(to) ? to : [to], subject, html };
    if (icsContent) {
      payload.attachments = [{
        filename: 'event.ics',
        content: Buffer.from(icsContent).toString('base64'),
      }];
    }
    await resend.emails.send(payload);
  } catch (err) {
    console.error('[email] Send failed:', err.message);
  }
}

// Booking confirmation email (sent to user + studio)
async function sendBookingConfirmation({ userEmail, userName, studioEmail, studioName, className, datetime, location, creditCost, bookingId }) {
  const classDate = new Date(datetime);
  const classEnd = new Date(classDate.getTime() + 60 * 60 * 1000); // assume 1hr
  const friendlyDate = classDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const friendlyTime = classDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const icsContent = buildICS({
    uid: `booking-${bookingId}`,
    summary: `${className} @ ${studioName}`,
    dtstart: classDate,
    dtend: classEnd,
    location: location || studioName,
    description: `FitFlex class booked by ${userName}.\nCredits used: ${creditCost}`,
    organizer: { name: studioName, email: studioEmail },
  });

  const userHtml = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <h2 style="color:#2563eb">Booking Confirmed! 🎉</h2>
      <p>Hi ${userName}, you're all set for:</p>
      <div style="background:#f0f7ff;border-radius:12px;padding:16px;margin:16px 0">
        <p style="margin:0 0 6px"><strong>${className}</strong></p>
        <p style="margin:0 0 4px;color:#555">📍 ${studioName}${location ? ' · ' + location : ''}</p>
        <p style="margin:0 0 4px;color:#555">📅 ${friendlyDate}</p>
        <p style="margin:0;color:#555">🕐 ${friendlyTime}</p>
      </div>
      <p style="color:#555">Credits used: <strong>${creditCost}</strong></p>
      <p style="color:#888;font-size:13px">The .ics file attached to this email lets you add the class to Google Calendar, Apple Calendar, or Outlook.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
    </div>`;

  const studioHtml = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <h2 style="color:#2563eb">New Booking 📋</h2>
      <p><strong>${userName}</strong> has booked a spot in:</p>
      <div style="background:#f0f7ff;border-radius:12px;padding:16px;margin:16px 0">
        <p style="margin:0 0 6px"><strong>${className}</strong></p>
        <p style="margin:0 0 4px;color:#555">📅 ${friendlyDate}</p>
        <p style="margin:0;color:#555">🕐 ${friendlyTime}</p>
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
    </div>`;

  await Promise.all([
    sendEmail({ to: userEmail, subject: `Booking confirmed: ${className}`, html: userHtml, icsContent }),
    sendEmail({ to: studioEmail, subject: `New booking: ${className} — ${userName}`, html: studioHtml }),
  ]);
}

// Cancellation email (sent to user + studio)
async function sendCancellationNotice({ userEmail, userName, studioEmail, studioName, className, datetime, creditCost }) {
  const classDate = new Date(datetime);
  const friendlyDate = classDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const friendlyTime = classDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const userHtml = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <h2 style="color:#dc2626">Booking Cancelled</h2>
      <p>Hi ${userName}, your booking has been cancelled:</p>
      <div style="background:#fef2f2;border-radius:12px;padding:16px;margin:16px 0">
        <p style="margin:0 0 6px"><strong>${className}</strong> @ ${studioName}</p>
        <p style="margin:0 0 4px;color:#555">📅 ${friendlyDate} · ${friendlyTime}</p>
      </div>
      <p style="color:#555"><strong>${creditCost} credit${creditCost !== 1 ? 's' : ''}</strong> have been refunded to your account.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
    </div>`;

  const studioHtml = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <h2 style="color:#dc2626">Booking Cancelled</h2>
      <p><strong>${userName}</strong> has cancelled their booking for:</p>
      <div style="background:#fef2f2;border-radius:12px;padding:16px;margin:16px 0">
        <p style="margin:0 0 6px"><strong>${className}</strong></p>
        <p style="margin:0;color:#555">📅 ${friendlyDate} · ${friendlyTime}</p>
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
    </div>`;

  await Promise.all([
    sendEmail({ to: userEmail, subject: `Booking cancelled: ${className}`, html: userHtml }),
    sendEmail({ to: studioEmail, subject: `Cancellation: ${className} — ${userName}`, html: studioHtml }),
  ]);
}

// ---- Constants ----
const SPORT_TYPES = [
  'Yoga', 'Pilates', 'HIIT', 'Cycling', 'Boxing',
  'Swimming', 'CrossFit', 'Dance', 'Martial Arts',
  'Shiatsu', 'Running', 'Other'
];

// =====================
// PUBLIC ROUTES
// =====================

app.get('/api/ping', (req, res) => res.json({ ok: true, message: 'pong from backend' }));

app.get('/api/sport-types', (req, res) => res.json({ sport_types: SPORT_TYPES }));

// GET /api/classes
app.get('/api/classes', async (req, res) => {
  try {
    const r = await query(
      `SELECT c.id, c.name, c.datetime, c.sport_type, c.credit_cost, c.capacity,
              s.id AS studio_id, s.name AS studio_name, s.location AS studio_location
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

// GET /api/studios  — public list of all studios
app.get('/api/studios', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, name, city, neighbourhood, location, about, verified, offers_appointments, opening_hour, closing_hour
         FROM studios
        ORDER BY verified DESC, name ASC`
    );
    res.json({ studios: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/studios/:studioId  — public studio profile
app.get('/api/studios/:studioId', async (req, res) => {
  const studioId = Number(req.params.studioId);
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  try {
    const r = await query(
      'SELECT id, name, city, neighbourhood, location, about, phone, website, instagram, verified, accepts_enquiries, offers_appointments, opening_hour, closing_hour, tagline, cover_color, cover_photo FROM studios WHERE id=$1',
      [studioId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Studio not found' });
    res.json({ studio: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

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
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/:userId/profile  — public profile
app.get('/api/users/:userId/profile', async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const r = await query('SELECT id, name, bio, public_fields, credits FROM users WHERE id=$1', [userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = r.rows[0];
    const publicFields = (user.public_fields || 'name').split(',');
    const profile = { id: user.id };
    if (publicFields.includes('name')) profile.name = user.name;
    if (publicFields.includes('bio')) profile.bio = user.bio;
    if (publicFields.includes('credits')) profile.credits = user.credits;
    res.json({ profile });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// SIGNUP / LOGIN / LOGOUT
// =====================

// POST /api/signup/user
app.post('/api/signup/user', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  try {
    const exists = await query('SELECT 1 FROM users WHERE name=$1 OR email=$2', [name, email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Name or email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const inserted = await query(
      'INSERT INTO users (name, email, password) VALUES ($1,$2,$3) RETURNING id',
      [name, email, hashed]
    );
    const id = inserted.rows[0].id;
    const token = signToken({ id, role: 'user', email });
    setAuthCookie(res, token);
    res.status(201).json({ user: { id, name, email, role: 'user' }, token, message: 'User registered successfully' });
  } catch (err) {
    console.error('signup/user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/signup/studio
app.post('/api/signup/studio', async (req, res) => {
  const { name, email, password, location } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  try {
    const exists = await query('SELECT 1 FROM studios WHERE name=$1 OR email=$2', [name, email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Studio name or email already exists' });
    const hashed = await bcrypt.hash(password, 10);
    const inserted = await query(
      'INSERT INTO studios (name, email, password, location) VALUES ($1,$2,$3,$4) RETURNING id',
      [name, email, hashed, location || null]
    );
    const id = inserted.rows[0].id;
    const token = signToken({ id, role: 'studio', email });
    setAuthCookie(res, token);
    res.status(201).json({ user: { id, name, email, role: 'studio' }, token, message: 'Studio registered successfully' });
  } catch (err) {
    console.error('signup/studio error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/login
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    let { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }
    email = email.trim().toLowerCase();
    password = password.trim();

    // Try users
    let r = await query('SELECT id, name, email, password FROM users WHERE lower(email)=$1', [email]);
    if (r.rows.length) {
      const u = r.rows[0];
      const ok = await bcrypt.compare(password, u.password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      const token = signToken({ id: u.id, role: 'user', email: u.email });
      setAuthCookie(res, token);
      return res.json({ user: { id: u.id, name: u.name, email: u.email, role: 'user' }, token });
    }

    // Try studios
    r = await query('SELECT id, name, email, password FROM studios WHERE lower(email)=$1', [email]);
    if (r.rows.length) {
      const s = r.rows[0];
      const ok = await bcrypt.compare(password, s.password);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
      const token = signToken({ id: s.id, role: 'studio', email: s.email });
      setAuthCookie(res, token);
      return res.json({ user: { id: s.id, name: s.name, email: s.email, role: 'studio' }, token });
    }

    return res.status(404).json({ error: 'No account found for this email' });
  } catch (err) {
    console.error('[login] error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('fitflex_token', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  });
  res.json({ ok: true });
});

// =====================
// USER PROTECTED ROUTES
// =====================

// GET /api/users/:userId/bookings
app.get('/api/users/:userId/bookings', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const r = await query(
      `SELECT b.id, b.timestamp, b.payment_status,
              c.id AS class_id, c.name AS class_name, c.datetime, c.sport_type, c.credit_cost,
              s.name AS studio_name, s.location AS studio_location
         FROM bookings b
         JOIN classes c ON c.id = b.class_id
         JOIN studios s ON s.id = c.studio_id
        WHERE b.user_id=$1
        ORDER BY c.datetime DESC`,
      [userId]
    );
    res.json({ bookings: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/:userId/settings
app.get('/api/users/:userId/settings', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const r = await query('SELECT id, name, email, bio, public_fields, credits, phone FROM users WHERE id=$1', [userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/users/:userId/settings
app.patch('/api/users/:userId/settings', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  const allowed = ['name', 'bio', 'public_fields', 'phone'];
  const fields = [], values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed.includes(k)) { fields.push(`${k}=$${idx++}`); values.push(v); }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    const r = await query(
      `UPDATE users SET ${fields.join(',')} WHERE id=$${idx} RETURNING id,name,email,bio,public_fields,credits,phone`,
      [...values, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/users/:userId/password
app.patch('/api/users/:userId/password', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  try {
    const r = await query('SELECT password FROM users WHERE id=$1', [userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(currentPassword, r.rows[0].password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await query('UPDATE users SET password=$1 WHERE id=$2', [hashed, userId]);
    res.json({ message: 'Password updated successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/book
app.post('/api/book', requireAuth, async (req, res) => {
  const { user_id, class_id } = req.body || {};
  if (!user_id || !class_id) return res.status(400).json({ error: 'user_id and class_id are required' });
  try {
    // Check if already booked
    const already = await query('SELECT 1 FROM bookings WHERE user_id=$1 AND class_id=$2', [user_id, class_id]);
    if (already.rows.length) return res.status(409).json({ error: 'You have already booked this class' });

    // Get class + studio info for email
    const clsRes = await query(
      `SELECT c.id, c.name, c.datetime, c.credit_cost, c.capacity,
              s.id AS studio_id, s.name AS studio_name, s.email AS studio_email, s.location
         FROM classes c JOIN studios s ON s.id = c.studio_id WHERE c.id=$1`,
      [class_id]
    );
    if (!clsRes.rows.length) return res.status(404).json({ error: 'Class not found' });
    const cls = clsRes.rows[0];

    // Get user info for email
    const userRes = await query('SELECT id, name, email, credits FROM users WHERE id=$1', [user_id]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    // Check credits
    if (user.credits < cls.credit_cost) {
      return res.status(400).json({ error: `Not enough credits. You have ${user.credits}, class costs ${cls.credit_cost}.` });
    }

    // Capacity check
    if (cls.capacity) {
      const booked = await query('SELECT COUNT(*) AS c FROM bookings WHERE class_id=$1', [class_id]);
      if (Number(booked.rows[0].c) >= cls.capacity) {
        return res.status(400).json({ error: 'This class is fully booked' });
      }
    }

    // Insert booking + deduct credits in transaction
    await query('BEGIN', []);
    const bookingRes = await query(
      'INSERT INTO bookings (user_id, class_id, payment_status) VALUES ($1,$2,$3) RETURNING id',
      [user_id, class_id, 'paid']
    );
    await query('UPDATE users SET credits=credits-$1 WHERE id=$2', [cls.credit_cost, user_id]);
    await query('COMMIT', []);

    const bookingId = bookingRes.rows[0].id;

    // Notify studio of new booking (non-blocking)
    createNotification({
      recipientType: 'studio',
      recipientId: cls.studio_id,
      type: 'booking',
      title: `New booking: ${cls.name}`,
      body: `${user.name} booked a spot in ${cls.name} on ${new Date(cls.datetime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`,
    });

    // Send confirmation emails (non-blocking)
    sendBookingConfirmation({
      userEmail: user.email,
      userName: user.name,
      studioEmail: cls.studio_email,
      studioName: cls.studio_name,
      className: cls.name,
      datetime: cls.datetime,
      location: cls.location,
      creditCost: cls.credit_cost,
      bookingId,
    }).catch(err => console.error('[email] booking confirmation failed:', err));

    res.status(201).json({ message: 'Booked successfully' });
  } catch (err) {
    await query('ROLLBACK', []).catch(() => {});
    console.error('book error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/bookings/:id  — cancel + refund
app.delete('/api/bookings/:id', requireAuth, async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!Number.isInteger(bookingId)) return res.status(400).json({ error: 'Invalid booking id' });
  try {
    const r = await query(
      `SELECT b.id, b.user_id, c.datetime, c.credit_cost, c.name AS class_name,
              u.name AS user_name, u.email AS user_email,
              s.id AS studio_id, s.name AS studio_name, s.email AS studio_email
         FROM bookings b
         JOIN classes c ON c.id = b.class_id
         JOIN users u ON u.id = b.user_id
         JOIN studios s ON s.id = c.studio_id
        WHERE b.id=$1`,
      [bookingId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Booking not found' });
    const booking = r.rows[0];
    if (new Date(booking.datetime) <= new Date()) {
      return res.status(400).json({ error: 'Cannot cancel a class that has already started or passed' });
    }
    await query('BEGIN', []);
    await query('DELETE FROM bookings WHERE id=$1', [bookingId]);
    await query('UPDATE users SET credits=credits+$1 WHERE id=$2', [booking.credit_cost, booking.user_id]);
    await query('COMMIT', []);

    // Notify studio of cancellation (non-blocking)
    createNotification({
      recipientType: 'studio',
      recipientId: booking.studio_id,
      type: 'cancellation',
      title: `Cancellation: ${booking.class_name}`,
      body: `${booking.user_name} cancelled their booking for ${booking.class_name}.`,
    });

    // Send cancellation emails (non-blocking)
    sendCancellationNotice({
      userEmail: booking.user_email,
      userName: booking.user_name,
      studioEmail: booking.studio_email,
      studioName: booking.studio_name,
      className: booking.class_name,
      datetime: booking.datetime,
      creditCost: booking.credit_cost,
    }).catch(err => console.error('[email] cancellation notice failed:', err));

    res.json({ ok: true, message: 'Booking cancelled and credits refunded' });
  } catch (e) {
    await query('ROLLBACK', []).catch(() => {});
    console.error('cancel booking error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// STUDIO PROTECTED ROUTES
// =====================

// PATCH /api/studios/:studioId
app.patch('/api/studios/:studioId', requireAuth, async (req, res) => {
  const studioId = Number(req.params.studioId);
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  const allowed = ['about', 'phone', 'website', 'instagram', 'city', 'neighbourhood', 'location', 'accepts_enquiries', 'offers_appointments', 'opening_hour', 'closing_hour', 'tagline', 'cover_color', 'cover_photo'];
  const fields = [], values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed.includes(k)) { fields.push(`${k}=$${idx++}`); values.push(v); }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    const r = await query(
      `UPDATE studios SET ${fields.join(',')} WHERE id=$${idx} RETURNING id,name,city,neighbourhood,location,about,phone,website,instagram,verified,accepts_enquiries,offers_appointments,opening_hour,closing_hour,tagline,cover_color,cover_photo`,
      [...values, studioId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Studio not found' });
    res.json({ studio: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/studios/:studioId/cover-photo — upload cover image
app.post('/api/studios/:studioId/cover-photo', requireAuth, upload.single('photo'), async (req, res) => {
  const studioId = parseInt(req.params.studioId);
  if (req.user.id !== studioId || req.user.role !== 'studio') return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let photoUrl;
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    // Production: upload to Cloudinary, then delete temp file
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'fitflex/studios',
      public_id: `studio-${studioId}`,
      overwrite: true,
      transformation: [{ width: 1200, height: 400, crop: 'fill', quality: 'auto' }],
    });
    fs.unlinkSync(req.file.path);
    photoUrl = result.secure_url;
  } else {
    // Local dev: serve from /uploads
    const ext = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    const newName = `studio-${studioId}-${Date.now()}.${ext}`;
    const newPath = path.join(uploadsDir, newName);
    fs.renameSync(req.file.path, newPath);
    const baseUrl = process.env.BACKEND_URL || `http://localhost:${port}`;
    photoUrl = `${baseUrl}/uploads/${newName}`;
  }

  await query('UPDATE studios SET cover_photo=$1 WHERE id=$2', [photoUrl, studioId]);
  res.json({ url: photoUrl });
});

// PATCH /api/studios/:studioId/password
app.patch('/api/studios/:studioId/password', requireAuth, async (req, res) => {
  const studioId = Number(req.params.studioId);
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  try {
    const r = await query('SELECT password FROM studios WHERE id=$1', [studioId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Studio not found' });
    const ok = await bcrypt.compare(currentPassword, r.rows[0].password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await query('UPDATE studios SET password=$1 WHERE id=$2', [hashed, studioId]);
    res.json({ message: 'Password updated successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/studios/:studioId/classes
app.post('/api/studios/:studioId/classes', requireAuth, async (req, res) => {
  const studioId = Number(req.params.studioId);
  const { name, datetime, sport_type, credit_cost, capacity } = req.body || {};
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  if (!name || !datetime) return res.status(400).json({ error: 'name and datetime are required' });
  const creditCost = (Number.isFinite(+credit_cost) && +credit_cost >= 0) ? +credit_cost : 1;
  const cap = Number.isFinite(+capacity) ? +capacity : null;
  try {
    const r = await query(
      `INSERT INTO classes (studio_id, name, datetime, sport_type, credit_cost, capacity)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,name,datetime,sport_type,credit_cost,capacity`,
      [studioId, name.trim(), new Date(datetime), sport_type || null, creditCost, cap]
    );
    res.status(201).json({ class: r.rows[0] });
  } catch (e) {
    console.error('create class error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/classes/:classId
app.patch('/api/classes/:classId', requireAuth, async (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId)) return res.status(400).json({ error: 'Invalid class id' });
  const fields = [], values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(req.body || {})) {
    if (['name','datetime','sport_type','credit_cost','capacity'].includes(k)) {
      fields.push(`${k}=$${idx++}`);
      values.push(k === 'datetime' ? new Date(v) : v);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    const r = await query(
      `UPDATE classes SET ${fields.join(',')} WHERE id=$${idx} RETURNING id,name,datetime,sport_type,credit_cost,capacity`,
      [...values, classId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Class not found' });
    res.json({ class: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/classes/:classId/attendees — studio sees who booked
app.get('/api/classes/:classId/attendees', requireAuth, async (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId)) return res.status(400).json({ error: 'Invalid class id' });
  try {
    const cls = await query('SELECT studio_id FROM classes WHERE id=$1', [classId]);
    if (!cls.rows.length) return res.status(404).json({ error: 'Class not found' });
    if (req.user.role !== 'studio' || req.user.id !== cls.rows[0].studio_id)
      return res.status(403).json({ error: 'Forbidden' });
    const r = await query(
      `SELECT u.id, u.name, u.email, u.phone, b.id AS booking_id, b.timestamp
       FROM bookings b JOIN users u ON u.id = b.user_id
       WHERE b.class_id=$1 ORDER BY b.timestamp ASC`,
      [classId]
    );
    res.json({ attendees: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/classes/:classId
app.delete('/api/classes/:classId', requireAuth, async (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId)) return res.status(400).json({ error: 'Invalid class id' });
  try {
    const r = await query('DELETE FROM classes WHERE id=$1 RETURNING id', [classId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Class not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// STUDIO ANALYTICS
// =====================

// GET /api/studios/:studioId/analytics
app.get('/api/studios/:studioId/analytics', requireAuth, async (req, res) => {
  const studioId = Number(req.params.studioId);
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  try {
    const r = await query(
      `SELECT c.id, c.name, c.datetime, c.credit_cost, c.capacity,
              COUNT(b.id)::int AS booking_count
         FROM classes c
         LEFT JOIN bookings b ON b.class_id = c.id
        WHERE c.studio_id = $1
        GROUP BY c.id
        ORDER BY c.datetime DESC`,
      [studioId]
    );
    const classes = r.rows;
    const totalBookings = classes.reduce((s, c) => s + c.booking_count, 0);
    const totalRevenue = classes.reduce((s, c) => s + c.booking_count * c.credit_cost, 0);
    res.json({ classes, totalBookings, totalRevenue });
  } catch (e) {
    console.error('analytics error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// STUDIO MESSAGING
// =====================

// POST /api/classes/:classId/message  — studio sends a message to all booked users
app.post('/api/classes/:classId/message', requireAuth, async (req, res) => {
  const classId = Number(req.params.classId);
  if (!Number.isInteger(classId)) return res.status(400).json({ error: 'Invalid class id' });
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  try {
    // Get class + studio info
    const clsRes = await query(
      `SELECT c.id, c.name, c.datetime, s.id AS studio_id, s.name AS studio_name
         FROM classes c JOIN studios s ON s.id = c.studio_id WHERE c.id=$1`,
      [classId]
    );
    if (!clsRes.rows.length) return res.status(404).json({ error: 'Class not found' });
    const cls = clsRes.rows[0];

    // Get all booked users (with phone for WhatsApp)
    const usersRes = await query(
      `SELECT u.id, u.name, u.email, u.phone
         FROM bookings b JOIN users u ON u.id = b.user_id
        WHERE b.class_id=$1`,
      [classId]
    );
    const bookedUsers = usersRes.rows;
    if (!bookedUsers.length) return res.json({ ok: true, sent: 0, message: 'No users booked for this class' });

    const friendlyDate = new Date(cls.datetime).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
    const friendlyTime = new Date(cls.datetime).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit'
    });

    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
        <h2 style="color:#2563eb">Message from ${cls.studio_name} 📣</h2>
        <p>You have a message regarding your upcoming class:</p>
        <div style="background:#f0f7ff;border-radius:12px;padding:16px;margin:16px 0">
          <p style="margin:0 0 6px"><strong>${cls.name}</strong></p>
          <p style="margin:0;color:#555">📅 ${friendlyDate} · ${friendlyTime}</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:16px 0">
          <p style="white-space:pre-wrap;margin:0;color:#1a1a1a">${message.trim()}</p>
        </div>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
      </div>`;

    const whatsappText = `📣 *${cls.studio_name}* — message for *${cls.name}* (${friendlyDate} ${friendlyTime}):\n\n${message.trim()}`;

    let emailsSent = 0, whatsappSent = 0;

    await Promise.all(bookedUsers.map(async user => {
      // In-app notification
      await createNotification({
        recipientType: 'user',
        recipientId: user.id,
        type: 'message',
        title: `Message from ${cls.studio_name}`,
        body: message.trim().length > 100 ? message.trim().slice(0, 100) + '…' : message.trim(),
      });

      // Email
      await sendEmail({ to: user.email, subject: `Message from ${cls.studio_name}: ${cls.name}`, html });
      emailsSent++;

      // WhatsApp (only if user has phone + Twilio configured)
      if (twilioClient && user.phone) {
        const e164 = user.phone.replace(/\s+/g, '').replace(/^00/, '+');
        try {
          await twilioClient.messages.create({
            from: TWILIO_WHATSAPP_FROM,
            to: `whatsapp:${e164}`,
            body: whatsappText,
          });
          whatsappSent++;
        } catch (err) {
          console.error(`[whatsapp] Failed for ${user.phone}:`, err.message);
        }
      }
    }));

    res.json({ ok: true, sent: bookedUsers.length, emailsSent, whatsappSent });
  } catch (e) {
    console.error('class message error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// STRIPE PAYMENTS
// =====================

// GET /api/credit-packs  — list available packs (public)
app.get('/api/credit-packs', (req, res) => {
  res.json({ packs: CREDIT_PACKS });
});

// POST /api/payments/create-session  — create Stripe Checkout session
app.post('/api/payments/create-session', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { pack_id, user_id } = req.body || {};
  const pack = CREDIT_PACKS.find(p => p.id === pack_id);
  if (!pack) return res.status(400).json({ error: 'Invalid credit pack' });

  // Verify user exists
  const userRes = await query('SELECT id, email FROM users WHERE id=$1', [user_id]);
  if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `FitFlex ${pack.label}`,
            description: `${pack.credits} credits · valid for 1 year`,
          },
          unit_amount: pack.price_cents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/dashboard?payment=success`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing?payment=cancelled`,
      metadata: {
        user_id: String(user_id),
        pack_id: pack.id,
        credits: String(pack.credits),
      },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe session error:', e);
    res.status(500).json({ error: 'Payment session failed' });
  }
});

// POST /api/payments/webhook  — Stripe webhook (raw body required)
app.post('/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(503).send('Not configured');
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        const userId = Number(session.metadata.user_id);
        const credits = Number(session.metadata.credits);
        const packId = session.metadata.pack_id;
        const pack = CREDIT_PACKS.find(p => p.id === packId);
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

        try {
          await query('BEGIN', []);
          await query('UPDATE users SET credits=credits+$1 WHERE id=$2', [credits, userId]);
          await query(
            `INSERT INTO credit_purchases (user_id, credits, amount_cents, stripe_session_id, expires_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [userId, credits, pack ? pack.price_cents : 0, session.id, expiresAt]
          );
          await query('COMMIT', []);
          console.log(`[stripe] +${credits} credits for user ${userId}`);
        } catch (e) {
          await query('ROLLBACK', []).catch(() => {});
          console.error('[stripe] Credit update failed:', e);
        }
      }
    }
    res.json({ received: true });
  }
);

// GET /api/users/:userId/purchases  — credit purchase history
app.get('/api/users/:userId/purchases', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const r = await query(
      `SELECT id, credits, amount_cents, expires_at, created_at
         FROM credit_purchases WHERE user_id=$1 ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ purchases: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// APPOINTMENT SLOTS
// =====================

// GET /api/studios/:id/slots?from=ISO&to=ISO  — get slots for a week range
app.get('/api/studios/:id/slots', async (req, res) => {
  const studioId = Number(req.params.id);
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  const { from, to, userId } = req.query;
  try {
    let sql = `
      SELECT s.id, s.datetime, s.duration_minutes, s.capacity, s.credit_cost, s.notes,
             COUNT(sb.id)::int AS booked_count
        FROM appointment_slots s
        LEFT JOIN slot_bookings sb ON sb.slot_id = s.id
       WHERE s.studio_id = $1`;
    const params = [studioId];
    let idx = 2;
    if (from) { sql += ` AND s.datetime >= $${idx++}`; params.push(from); }
    if (to)   { sql += ` AND s.datetime <= $${idx++}`; params.push(to); }
    sql += ' GROUP BY s.id ORDER BY s.datetime ASC';

    const r = await query(sql, params);

    // If userId provided, also fetch which slots this user has booked
    let userBookedSlotIds = new Set();
    if (userId) {
      const ub = await query(
        'SELECT slot_id FROM slot_bookings WHERE user_id=$1',
        [Number(userId)]
      );
      userBookedSlotIds = new Set(ub.rows.map(r => r.slot_id));
    }

    const slots = r.rows.map(slot => ({
      ...slot,
      is_full: slot.booked_count >= slot.capacity,
      booked_by_user: userBookedSlotIds.has(slot.id),
    }));

    res.json({ slots });
  } catch (e) {
    console.error('get slots error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/studios/:id/slots  — create a slot (studio auth)
app.post('/api/studios/:id/slots', requireAuth, async (req, res) => {
  const studioId = Number(req.params.id);
  const { datetime, duration_minutes, capacity, credit_cost, notes } = req.body || {};
  if (!datetime) return res.status(400).json({ error: 'datetime is required' });
  try {
    const r = await query(
      `INSERT INTO appointment_slots (studio_id, datetime, duration_minutes, capacity, credit_cost, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [studioId, new Date(datetime), duration_minutes || 60, capacity || 1, credit_cost ?? 1, notes || null]
    );
    res.status(201).json({ slot: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/slots/:id  — delete a slot (studio auth)
app.delete('/api/slots/:id', requireAuth, async (req, res) => {
  const slotId = Number(req.params.id);
  try {
    await query('DELETE FROM appointment_slots WHERE id=$1', [slotId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/slots/:id/book  — user books a slot
app.post('/api/slots/:id/book', requireAuth, async (req, res) => {
  const slotId = Number(req.params.id);
  const userId = req.user.id;
  try {
    // Check capacity
    const slot = await query(
      `SELECT s.*, COUNT(sb.id)::int AS booked_count
         FROM appointment_slots s
         LEFT JOIN slot_bookings sb ON sb.slot_id = s.id
        WHERE s.id=$1 GROUP BY s.id`,
      [slotId]
    );
    if (!slot.rows.length) return res.status(404).json({ error: 'Slot not found' });
    const s = slot.rows[0];
    if (s.booked_count >= s.capacity) return res.status(400).json({ error: 'This slot is fully booked' });

    // Check user credits
    const userRes = await query('SELECT credits FROM users WHERE id=$1', [userId]);
    if (userRes.rows[0].credits < s.credit_cost) {
      return res.status(400).json({ error: `Not enough credits. You have ${userRes.rows[0].credits}, slot costs ${s.credit_cost}.` });
    }

    // Book + deduct credits in transaction
    await query('BEGIN', []);
    await query('INSERT INTO slot_bookings (slot_id, user_id) VALUES ($1,$2)', [slotId, userId]);
    await query('UPDATE users SET credits=credits-$1 WHERE id=$2', [s.credit_cost, userId]);
    await query('COMMIT', []);

    // Notify studio
    const studioRes = await query('SELECT id, name FROM studios WHERE id=$1', [s.studio_id]);
    const userNameRes = await query('SELECT name FROM users WHERE id=$1', [userId]);
    const friendlyTime = new Date(s.datetime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    await createNotification({
      recipientType: 'studio',
      recipientId: s.studio_id,
      type: 'booking',
      title: `Appointment booked: ${friendlyTime}`,
      body: `${userNameRes.rows[0]?.name} booked a ${s.duration_minutes}min appointment slot.`,
    });

    res.status(201).json({ ok: true });
  } catch (e) {
    await query('ROLLBACK', []).catch(() => {});
    console.error('book slot error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/slots/:id/book  — user cancels a slot booking
app.delete('/api/slots/:id/book', requireAuth, async (req, res) => {
  const slotId = Number(req.params.id);
  const userId = req.user.id;
  try {
    const slot = await query('SELECT credit_cost FROM appointment_slots WHERE id=$1', [slotId]);
    if (!slot.rows.length) return res.status(404).json({ error: 'Slot not found' });
    await query('BEGIN', []);
    await query('DELETE FROM slot_bookings WHERE slot_id=$1 AND user_id=$2', [slotId, userId]);
    await query('UPDATE users SET credits=credits+$1 WHERE id=$2', [slot.rows[0].credit_cost, userId]);
    await query('COMMIT', []);
    res.json({ ok: true });
  } catch (e) {
    await query('ROLLBACK', []).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// GROUP EVENTS
// =====================

// GET /api/groups/:id/events
app.get('/api/groups/:id/events', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  try {
    const r = await query(
      `SELECT e.id, e.title, e.description, e.datetime, e.location, e.created_at,
              u.name AS creator_name,
              COUNT(CASE WHEN er.status='going' THEN 1 END)::int AS going_count,
              COUNT(CASE WHEN er.status='maybe' THEN 1 END)::int AS maybe_count
         FROM group_events e
         LEFT JOIN users u ON u.id = e.creator_id
         LEFT JOIN event_rsvps er ON er.event_id = e.id
        WHERE e.group_id = $1
        GROUP BY e.id, u.name
        ORDER BY e.datetime ASC`,
      [groupId]
    );
    res.json({ events: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/events/:id  — event detail + RSVPs
app.get('/api/events/:id', async (req, res) => {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) return res.status(400).json({ error: 'Invalid event id' });
  try {
    const e = await query(
      `SELECT ge.*, u.name AS creator_name, g.name AS group_name, g.id AS group_id, g.cover_emoji
         FROM group_events ge
         LEFT JOIN users u ON u.id = ge.creator_id
         JOIN groups g ON g.id = ge.group_id
        WHERE ge.id = $1`,
      [eventId]
    );
    if (!e.rows.length) return res.status(404).json({ error: 'Event not found' });

    const rsvps = await query(
      `SELECT er.status, er.user_id, u.name
         FROM event_rsvps er JOIN users u ON u.id = er.user_id
        WHERE er.event_id = $1
        ORDER BY er.created_at ASC`,
      [eventId]
    );
    res.json({ event: e.rows[0], rsvps: rsvps.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/groups/:id/events  — create event (group admin only)
app.post('/api/groups/:id/events', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.user.id;
  const { title, description, datetime, location } = req.body || {};
  if (!title || !datetime) return res.status(400).json({ error: 'title and datetime are required' });
  try {
    const member = await query(
      'SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',
      [groupId, userId]
    );
    if (!member.rows.length || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can create events' });
    }
    const r = await query(
      `INSERT INTO group_events (group_id, creator_id, title, description, datetime, location)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [groupId, userId, title.trim(), description || null, new Date(datetime), location || null]
    );
    const event = r.rows[0];

    // Notify all group members
    const members = await query(
      'SELECT user_id FROM group_members WHERE group_id=$1 AND user_id!=$2',
      [groupId, userId]
    );
    const groupInfo = await query('SELECT name FROM groups WHERE id=$1', [groupId]);
    const groupName = groupInfo.rows[0]?.name || 'your group';
    const friendlyDate = new Date(datetime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const friendlyTime = new Date(datetime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    await Promise.all(members.rows.map(m =>
      createNotification({
        recipientType: 'user',
        recipientId: m.user_id,
        type: 'event',
        title: `New event in ${groupName}`,
        body: `${title} — ${friendlyDate} at ${friendlyTime}${location ? ' · ' + location : ''}`,
      })
    ));

    res.status(201).json({ event });
  } catch (e) {
    console.error('create event error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/events/:id  — update event (admin only)
app.patch('/api/events/:id', requireAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = req.user.id;
  try {
    // Check if user is admin of the group this event belongs to
    const check = await query(
      `SELECT gm.role FROM group_events ge
         JOIN group_members gm ON gm.group_id = ge.group_id AND gm.user_id = $2
        WHERE ge.id = $1`,
      [eventId, userId]
    );
    if (!check.rows.length || check.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can edit events' });
    }
    const allowed = ['title', 'description', 'datetime', 'location'];
    const fields = [], values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(req.body || {})) {
      if (allowed.includes(k)) {
        fields.push(`${k}=$${idx++}`);
        values.push(k === 'datetime' ? new Date(v) : v);
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
    const r = await query(
      `UPDATE group_events SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
      [...values, eventId]
    );
    res.json({ event: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/events/:id  — delete event (admin only)
app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = req.user.id;
  try {
    const check = await query(
      `SELECT gm.role FROM group_events ge
         JOIN group_members gm ON gm.group_id = ge.group_id AND gm.user_id = $2
        WHERE ge.id = $1`,
      [eventId, userId]
    );
    if (!check.rows.length || check.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can delete events' });
    }
    await query('DELETE FROM group_events WHERE id=$1', [eventId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/events/:id/rsvp  — RSVP to an event
app.post('/api/events/:id/rsvp', requireAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = req.user.id;
  const { status } = req.body || {};
  if (!['going', 'maybe', 'not_going'].includes(status)) {
    return res.status(400).json({ error: 'status must be going, maybe, or not_going' });
  }
  try {
    await query(
      `INSERT INTO event_rsvps (event_id, user_id, status)
       VALUES ($1,$2,$3)
       ON CONFLICT (event_id, user_id) DO UPDATE SET status=$3`,
      [eventId, userId, status]
    );
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/events/:id/rsvp  — remove RSVP
app.delete('/api/events/:id/rsvp', requireAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = req.user.id;
  try {
    await query('DELETE FROM event_rsvps WHERE event_id=$1 AND user_id=$2', [eventId, userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// GROUP FEED (POSTS + COMMENTS)
// =====================

// GET /api/groups/:id/posts
app.get('/api/groups/:id/posts', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  try {
    // Check feed visibility
    const groupRes = await query('SELECT is_feed_public FROM groups WHERE id=$1', [groupId]);
    if (!groupRes.rows.length) return res.status(404).json({ error: 'Group not found' });

    if (!groupRes.rows[0].is_feed_public) {
      // Feed is private — must be a member
      const user = optionalAuth(req);
      if (!user) return res.status(403).json({ error: 'This group\'s feed is private', feedPrivate: true });
      const membership = await query(
        'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
        [groupId, user.id]
      );
      if (!membership.rows.length) {
        return res.status(403).json({ error: 'Join the group to see the feed', feedPrivate: true });
      }
    }

    const r = await query(
      `SELECT p.id, p.content, p.created_at,
              u.id AS user_id, u.name AS user_name,
              COUNT(c.id)::int AS comment_count
         FROM group_posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN post_comments c ON c.post_id = p.id
        WHERE p.group_id = $1
        GROUP BY p.id, u.id
        ORDER BY p.created_at DESC`,
      [groupId]
    );
    res.json({ posts: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/groups/:id/posts  — create a post (members only)
app.post('/api/groups/:id/posts', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.user.id;
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content is required' });
  try {
    // Must be a member
    const member = await query(
      'SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',
      [groupId, userId]
    );
    if (!member.rows.length) return res.status(403).json({ error: 'You must be a member to post' });

    const r = await query(
      `INSERT INTO group_posts (group_id, user_id, content)
       VALUES ($1,$2,$3) RETURNING id, content, created_at`,
      [groupId, userId, content.trim()]
    );
    const post = r.rows[0];
    const userRes = await query('SELECT name FROM users WHERE id=$1', [userId]);
    const userName = userRes.rows[0]?.name;

    // Notify other members
    const others = await query(
      'SELECT user_id FROM group_members WHERE group_id=$1 AND user_id!=$2',
      [groupId, userId]
    );
    const groupRes = await query('SELECT name FROM groups WHERE id=$1', [groupId]);
    const groupName = groupRes.rows[0]?.name || 'your group';
    const preview = content.trim().length > 80 ? content.trim().slice(0, 80) + '…' : content.trim();

    await Promise.all(others.rows.map(m =>
      createNotification({
        recipientType: 'user',
        recipientId: m.user_id,
        type: 'post',
        title: `${userName} posted in ${groupName}`,
        body: preview,
      })
    ));

    res.status(201).json({ post: { ...post, user_id: userId, user_name: userName, comment_count: 0 } });
  } catch (e) {
    console.error('create post error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/posts/:id  — delete post (author or group admin)
app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const userId = req.user.id;
  try {
    const post = await query(
      `SELECT p.user_id, p.group_id, gm.role
         FROM group_posts p
         LEFT JOIN group_members gm ON gm.group_id = p.group_id AND gm.user_id = $2
        WHERE p.id = $1`,
      [postId, userId]
    );
    if (!post.rows.length) return res.status(404).json({ error: 'Post not found' });
    const { user_id, role } = post.rows[0];
    if (user_id !== userId && role !== 'admin') {
      return res.status(403).json({ error: 'Not authorised to delete this post' });
    }
    await query('DELETE FROM group_posts WHERE id=$1', [postId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/posts/:id/comments
app.get('/api/posts/:id/comments', async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isInteger(postId)) return res.status(400).json({ error: 'Invalid post id' });
  try {
    const r = await query(
      `SELECT c.id, c.content, c.created_at, u.id AS user_id, u.name AS user_name
         FROM post_comments c JOIN users u ON u.id = c.user_id
        WHERE c.post_id = $1
        ORDER BY c.created_at ASC`,
      [postId]
    );
    res.json({ comments: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/posts/:id/comments  — add a comment
app.post('/api/posts/:id/comments', requireAuth, async (req, res) => {
  const postId = Number(req.params.id);
  const userId = req.user.id;
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content is required' });
  try {
    // Check user is a member of the group this post belongs to
    const check = await query(
      `SELECT gm.role FROM group_posts p
         JOIN group_members gm ON gm.group_id = p.group_id AND gm.user_id = $2
        WHERE p.id = $1`,
      [postId, userId]
    );
    if (!check.rows.length) return res.status(403).json({ error: 'You must be a group member to comment' });

    const r = await query(
      `INSERT INTO post_comments (post_id, user_id, content)
       VALUES ($1,$2,$3) RETURNING id, content, created_at`,
      [postId, userId, content.trim()]
    );
    const userRes = await query('SELECT name FROM users WHERE id=$1', [userId]);

    // Notify the post author (if not the commenter)
    const postRes = await query('SELECT user_id FROM group_posts WHERE id=$1', [postId]);
    const postAuthorId = postRes.rows[0]?.user_id;
    if (postAuthorId && postAuthorId !== userId) {
      const preview = content.trim().length > 80 ? content.trim().slice(0, 80) + '…' : content.trim();
      await createNotification({
        recipientType: 'user',
        recipientId: postAuthorId,
        type: 'comment',
        title: `${userRes.rows[0]?.name} commented on your post`,
        body: preview,
      });
    }

    res.status(201).json({
      comment: { ...r.rows[0], user_id: userId, user_name: userRes.rows[0]?.name }
    });
  } catch (e) {
    console.error('comment error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/comments/:id  — delete comment (author or admin)
app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  const commentId = Number(req.params.id);
  const userId = req.user.id;
  try {
    const c = await query(
      `SELECT c.user_id, gm.role
         FROM post_comments c
         JOIN group_posts p ON p.id = c.post_id
         LEFT JOIN group_members gm ON gm.group_id = p.group_id AND gm.user_id = $2
        WHERE c.id = $1`,
      [commentId, userId]
    );
    if (!c.rows.length) return res.status(404).json({ error: 'Comment not found' });
    if (c.rows[0].user_id !== userId && c.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Not authorised' });
    }
    await query('DELETE FROM post_comments WHERE id=$1', [commentId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// NOTIFICATIONS
// =====================

// Helper: create a notification
async function createNotification({ recipientType, recipientId, type, title, body }) {
  try {
    await query(
      `INSERT INTO notifications (recipient_type, recipient_id, type, title, body)
       VALUES ($1,$2,$3,$4,$5)`,
      [recipientType, recipientId, type, title, body]
    );
  } catch (e) {
    console.error('[notification] Failed to create:', e.message);
  }
}

// GET /api/notifications  — get notifications for the logged-in user/studio
app.get('/api/notifications', requireAuth, async (req, res) => {
  const { id, role } = req.user;
  const recipientType = role === 'studio' ? 'studio' : 'user';
  try {
    const r = await query(
      `SELECT id, type, title, body, read, created_at
         FROM notifications
        WHERE recipient_type=$1 AND recipient_id=$2
        ORDER BY created_at DESC
        LIMIT 50`,
      [recipientType, id]
    );
    const unread = r.rows.filter(n => !n.read).length;
    res.json({ notifications: r.rows, unread });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/notifications/read-all  — mark all as read
app.patch('/api/notifications/read-all', requireAuth, async (req, res) => {
  const { id, role } = req.user;
  const recipientType = role === 'studio' ? 'studio' : 'user';
  try {
    await query(
      `UPDATE notifications SET read=true
        WHERE recipient_type=$1 AND recipient_id=$2 AND read=false`,
      [recipientType, id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/notifications/:id/read  — mark one as read
app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await query('UPDATE notifications SET read=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// STUDIO ENQUIRIES
// =====================

// GET /api/studios/:studioId — update to include accepts_enquiries
// (already handled by the existing GET /api/studios/:studioId route — just needs the column in SELECT)

// POST /api/studios/:studioId/enquire  — user sends custom time enquiry to studio
app.post('/api/studios/:studioId/enquire', requireAuth, async (req, res) => {
  const studioId = Number(req.params.studioId);
  if (!Number.isInteger(studioId)) return res.status(400).json({ error: 'Invalid studio id' });
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  const userId = req.user.id;
  try {
    // Check studio accepts enquiries
    const studioRes = await query(
      'SELECT id, name, accepts_enquiries FROM studios WHERE id=$1', [studioId]
    );
    if (!studioRes.rows.length) return res.status(404).json({ error: 'Studio not found' });
    if (!studioRes.rows[0].accepts_enquiries) {
      return res.status(400).json({ error: 'This studio is not accepting enquiries' });
    }

    const userRes = await query('SELECT name, email FROM users WHERE id=$1', [userId]);
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];
    const studio = studioRes.rows[0];

    // Create notification for studio
    await createNotification({
      recipientType: 'studio',
      recipientId: studioId,
      type: 'enquiry',
      title: `New enquiry from ${user.name}`,
      body: message.trim(),
    });

    // Also send email to studio (non-blocking)
    sendEmail({
      to: (await query('SELECT email FROM studios WHERE id=$1', [studioId])).rows[0]?.email,
      subject: `New enquiry from ${user.name}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
          <h2 style="color:#2563eb">New Enquiry 💬</h2>
          <p><strong>${user.name}</strong> (${user.email}) sent you an enquiry:</p>
          <div style="background:#f0f7ff;border-radius:12px;padding:16px;margin:16px 0">
            <p style="white-space:pre-wrap;margin:0">${message.trim()}</p>
          </div>
          <p style="color:#888;font-size:13px">Reply directly to ${user.email}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
        </div>`,
    }).catch(() => {});

    res.json({ ok: true, message: 'Enquiry sent!' });
  } catch (e) {
    console.error('enquiry error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/studios/:studioId — already exists, just needs accepts_enquiries in allowed fields
// (update the existing PATCH handler's allowed array)

// =====================
// COMMUNITIES (GROUPS)
// =====================

// GET /api/groups  — browse all public groups (with optional search)
app.get('/api/groups', async (req, res) => {
  const { q, sport_type, city } = req.query;
  try {
    let sql = `
      SELECT g.id, g.name, g.sport_type, g.city, g.description, g.cover_emoji,
             g.is_private, g.is_feed_public, g.created_at,
             COUNT(gm.id)::int AS member_count
        FROM groups g
        LEFT JOIN group_members gm ON gm.group_id = g.id
       WHERE g.is_private = FALSE`;
    const params = [];
    let idx = 1;
    if (q) { sql += ` AND (lower(g.name) LIKE $${idx} OR lower(g.description) LIKE $${idx})`; params.push(`%${q.toLowerCase()}%`); idx++; }
    if (sport_type) { sql += ` AND lower(g.sport_type) = $${idx}`; params.push(sport_type.toLowerCase()); idx++; }
    if (city) { sql += ` AND lower(g.city) LIKE $${idx}`; params.push(`%${city.toLowerCase()}%`); idx++; }
    sql += ' GROUP BY g.id ORDER BY member_count DESC, g.created_at DESC';
    const r = await query(sql, params);
    res.json({ groups: r.rows });
  } catch (e) {
    console.error('list groups error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/groups/:id  — group profile
app.get('/api/groups/:id', async (req, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group id' });
  try {
    const g = await query(
      `SELECT g.id, g.name, g.sport_type, g.city, g.description, g.cover_emoji,
              g.is_private, g.is_feed_public, g.creator_id, g.created_at,
              COUNT(gm.id)::int AS member_count
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id
        WHERE g.id = $1 GROUP BY g.id`,
      [groupId]
    );
    if (!g.rows.length) return res.status(404).json({ error: 'Group not found' });

    const members = await query(
      `SELECT u.id, u.name, gm.role, gm.joined_at
         FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1
        ORDER BY gm.role DESC, gm.joined_at ASC`,
      [groupId]
    );
    res.json({ group: g.rows[0], members: members.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/groups  — create a group (auth required, creator becomes admin)
app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, sport_type, city, description, cover_emoji, is_private } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' });
  const userId = req.user.id;
  try {
    const r = await query(
      `INSERT INTO groups (name, sport_type, city, description, cover_emoji, is_private, creator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name.trim(), sport_type || null, city || null, description || null, cover_emoji || '🏃', !!is_private, userId]
    );
    const group = r.rows[0];
    // Creator joins as admin
    await query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES ($1,$2,$3)',
      [group.id, userId, 'admin']
    );
    res.status(201).json({ group });
  } catch (e) {
    console.error('create group error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/groups/:id  — update group (admin only)
app.patch('/api/groups/:id', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.user.id;
  try {
    const member = await query(
      'SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',
      [groupId, userId]
    );
    if (!member.rows.length || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can edit this group' });
    }
    const allowed = ['name', 'sport_type', 'city', 'description', 'cover_emoji', 'is_private', 'is_feed_public'];
    const fields = [], values = [];
    let idx = 1;
    for (const [k, v] of Object.entries(req.body || {})) {
      if (allowed.includes(k)) { fields.push(`${k}=$${idx++}`); values.push(v); }
    }
    if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
    const r = await query(
      `UPDATE groups SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
      [...values, groupId]
    );
    res.json({ group: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/groups/:id/join  — join a group
app.post('/api/groups/:id/join', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.user.id;
  try {
    const group = await query('SELECT id, is_private FROM groups WHERE id=$1', [groupId]);
    if (!group.rows.length) return res.status(404).json({ error: 'Group not found' });
    if (group.rows[0].is_private) return res.status(403).json({ error: 'This group is private' });
    await query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [groupId, userId, 'member']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/groups/:id/leave  — leave a group
app.delete('/api/groups/:id/leave', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.user.id;
  try {
    await query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/groups/:id  — delete group (admin only)
app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.user.id;
  try {
    const member = await query(
      'SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',
      [groupId, userId]
    );
    if (!member.rows.length || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can delete this group' });
    }
    await query('DELETE FROM groups WHERE id=$1', [groupId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/:userId/groups  — groups a user belongs to
app.get('/api/users/:userId/groups', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId);
  try {
    const r = await query(
      `SELECT g.id, g.name, g.sport_type, g.city, g.cover_emoji, g.is_private, gm.role,
              COUNT(gm2.id)::int AS member_count
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         LEFT JOIN group_members gm2 ON gm2.group_id = g.id
        WHERE gm.user_id = $1
        GROUP BY g.id, gm.role
        ORDER BY gm.joined_at DESC`,
      [userId]
    );
    res.json({ groups: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// FOLLOWS
// =====================

// POST /api/users/:id/follow
app.post('/api/users/:id/follow', requireAuth, async (req, res) => {
  const followingId = Number(req.params.id);
  const followerId = req.user.id;
  if (followerId === followingId) return res.status(400).json({ error: 'Cannot follow yourself' });
  try {
    await query(
      'INSERT INTO user_follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [followerId, followingId]
    );
    const target = await query('SELECT name FROM users WHERE id=$1', [followingId]);
    await createNotification({
      recipientType: 'user', recipientId: followingId,
      type: 'follow', title: `${req.user.email} is now following you`,
      body: 'Someone new is following your activity.',
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /api/users/:id/follow
app.delete('/api/users/:id/follow', requireAuth, async (req, res) => {
  const followingId = Number(req.params.id);
  const followerId = req.user.id;
  try {
    await query('DELETE FROM user_follows WHERE follower_id=$1 AND following_id=$2', [followerId, followingId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/users/:id/following — who this user follows
app.get('/api/users/:id/following', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  try {
    const r = await query(
      `SELECT u.id, u.name FROM user_follows uf
         JOIN users u ON u.id = uf.following_id
        WHERE uf.follower_id=$1 ORDER BY uf.created_at DESC`,
      [userId]
    );
    res.json({ following: r.rows });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/users/:id/followers
app.get('/api/users/:id/followers', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  try {
    const r = await query(
      `SELECT u.id, u.name FROM user_follows uf
         JOIN users u ON u.id = uf.follower_id
        WHERE uf.following_id=$1 ORDER BY uf.created_at DESC`,
      [userId]
    );
    res.json({ followers: r.rows });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/users/:id/feed  — activity feed from people you follow
app.get('/api/users/:id/feed', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  try {
    // Bookings (only if user has made bookings public) + group joins from followed users
    const r = await query(
      `SELECT 'booking' AS type, u.id AS user_id, u.name AS user_name,
              c.name AS subject, s.name AS detail, b.timestamp AS created_at
         FROM user_follows uf
         JOIN users u ON u.id = uf.following_id
         JOIN bookings b ON b.user_id = u.id
         JOIN classes c ON c.id = b.class_id
         JOIN studios s ON s.id = c.studio_id
        WHERE uf.follower_id=$1
          AND u.public_fields LIKE '%bookings%'
       UNION ALL
       SELECT 'joined_group' AS type, u.id, u.name,
              g.name AS subject, g.sport_type AS detail, gm.joined_at AS created_at
         FROM user_follows uf
         JOIN users u ON u.id = uf.following_id
         JOIN group_members gm ON gm.user_id = u.id
         JOIN groups g ON g.id = gm.group_id
        WHERE uf.follower_id=$1
       ORDER BY created_at DESC LIMIT 30`,
      [userId]
    );
    res.json({ feed: r.rows });
  } catch (e) {
    console.error('feed error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// DIRECT MESSAGES
// =====================

// GET /api/messages/inbox  — list conversations
app.get('/api/messages/inbox', requireAuth, async (req, res) => {
  const { id, role } = req.user;
  const myType = role === 'studio' ? 'studio' : 'user';
  try {
    // Get latest message per conversation partner
    const r = await query(
      `SELECT DISTINCT ON (partner_type, partner_id)
              dm.id, dm.content, dm.read, dm.created_at,
              dm.sender_type, dm.sender_id,
              dm.recipient_type, dm.recipient_id,
              CASE WHEN dm.sender_type=$1 AND dm.sender_id=$2
                   THEN dm.recipient_type ELSE dm.sender_type END AS partner_type,
              CASE WHEN dm.sender_type=$1 AND dm.sender_id=$2
                   THEN dm.recipient_id ELSE dm.sender_id END AS partner_id
         FROM direct_messages dm
        WHERE (dm.sender_type=$1 AND dm.sender_id=$2)
           OR (dm.recipient_type=$1 AND dm.recipient_id=$2)
        ORDER BY partner_type, partner_id, dm.created_at DESC`,
      [myType, id]
    );

    // Enrich with partner names
    const enriched = await Promise.all(r.rows.map(async row => {
      let partnerName = 'Unknown';
      try {
        if (row.partner_type === 'user') {
          const u = await query('SELECT name FROM users WHERE id=$1', [row.partner_id]);
          partnerName = u.rows[0]?.name;
        } else {
          const s = await query('SELECT name FROM studios WHERE id=$1', [row.partner_id]);
          partnerName = s.rows[0]?.name;
        }
      } catch { /* ignore */ }
      return { ...row, partner_name: partnerName };
    }));

    // Unread count
    const unread = await query(
      `SELECT COUNT(*)::int AS count FROM direct_messages
        WHERE recipient_type=$1 AND recipient_id=$2 AND read=FALSE`,
      [myType, id]
    );

    res.json({ conversations: enriched, unread: unread.rows[0].count });
  } catch (e) {
    console.error('inbox error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/:type/:partnerId  — conversation thread
app.get('/api/messages/:type/:partnerId', requireAuth, async (req, res) => {
  const { id, role } = req.user;
  const myType = role === 'studio' ? 'studio' : 'user';
  const partnerType = req.params.type;
  const partnerId = Number(req.params.partnerId);
  try {
    const r = await query(
      `SELECT * FROM direct_messages
        WHERE (sender_type=$1 AND sender_id=$2 AND recipient_type=$3 AND recipient_id=$4)
           OR (sender_type=$3 AND sender_id=$4 AND recipient_type=$1 AND recipient_id=$2)
        ORDER BY created_at ASC`,
      [myType, id, partnerType, partnerId]
    );
    // Mark received messages as read
    await query(
      `UPDATE direct_messages SET read=TRUE
        WHERE recipient_type=$1 AND recipient_id=$2
          AND sender_type=$3 AND sender_id=$4 AND read=FALSE`,
      [myType, id, partnerType, partnerId]
    );
    res.json({ messages: r.rows });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/messages/:type/:recipientId  — send a DM
app.post('/api/messages/:type/:recipientId', requireAuth, async (req, res) => {
  const { id, role } = req.user;
  const myType = role === 'studio' ? 'studio' : 'user';
  const recipientType = req.params.type;
  const recipientId = Number(req.params.recipientId);
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' });
  try {
    const r = await query(
      `INSERT INTO direct_messages (sender_type, sender_id, recipient_type, recipient_id, content)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [myType, id, recipientType, recipientId, content.trim()]
    );

    // Get sender name for notification
    const senderRes = myType === 'user'
      ? await query('SELECT name FROM users WHERE id=$1', [id])
      : await query('SELECT name FROM studios WHERE id=$1', [id]);
    const senderName = senderRes.rows[0]?.name || 'Someone';

    // Notify recipient
    await createNotification({
      recipientType,
      recipientId,
      type: 'dm',
      title: `Message from ${senderName}`,
      body: content.trim().length > 80 ? content.trim().slice(0, 80) + '…' : content.trim(),
    });

    res.status(201).json({ message: r.rows[0] });
  } catch (e) {
    console.error('send DM error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// GROUP BROADCAST MESSAGE
// =====================

// POST /api/groups/:id/broadcast  — admin sends message to all members
app.post('/api/groups/:id/broadcast', requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.user.id;
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message content required' });
  try {
    const member = await query(
      'SELECT role FROM group_members WHERE group_id=$1 AND user_id=$2',
      [groupId, userId]
    );
    if (!member.rows.length || member.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can broadcast messages' });
    }

    const groupRes = await query('SELECT name FROM groups WHERE id=$1', [groupId]);
    const groupName = groupRes.rows[0]?.name || 'your group';
    const senderRes = await query('SELECT name, email FROM users WHERE id=$1', [userId]);
    const senderName = senderRes.rows[0]?.name;
    const preview = content.trim().length > 80 ? content.trim().slice(0, 80) + '…' : content.trim();

    // Notify + email all members except sender
    const members = await query(
      `SELECT u.id, u.name, u.email FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id=$1 AND gm.user_id!=$2`,
      [groupId, userId]
    );

    await Promise.all(members.rows.map(async m => {
      await createNotification({
        recipientType: 'user', recipientId: m.id,
        type: 'broadcast',
        title: `📢 Message from ${groupName}`,
        body: preview,
      });
      await sendEmail({
        to: m.email,
        subject: `Message from ${groupName}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
            <h2 style="color:#2563eb">📢 Message from ${groupName}</h2>
            <p><strong>${senderName}</strong> sent a message to the group:</p>
            <div style="background:#f0f7ff;border-radius:12px;padding:16px;margin:16px 0">
              <p style="white-space:pre-wrap;margin:0">${content.trim()}</p>
            </div>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
            <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
          </div>`,
      });
    }));

    res.json({ ok: true, sent: members.rows.length });
  } catch (e) {
    console.error('broadcast error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// ADMIN ENDPOINTS
// =====================

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers['x-admin-secret'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [users, studios, classes, bookings] = await Promise.all([
      query('SELECT COUNT(*)::int AS count FROM users'),
      query('SELECT COUNT(*)::int AS count FROM studios'),
      query('SELECT COUNT(*)::int AS count FROM classes'),
      query('SELECT COUNT(*)::int AS count FROM bookings'),
    ]);
    res.json({
      users: users.rows[0].count,
      studios: studios.rows[0].count,
      classes: classes.rows[0].count,
      bookings: bookings.rows[0].count,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT u.id, u.name, u.email, u.credits,
              COUNT(b.id)::int AS booking_count
         FROM users u
         LEFT JOIN bookings b ON b.user_id=u.id
        GROUP BY u.id ORDER BY u.id DESC`
    );
    res.json({ users: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/studios', requireAdmin, async (req, res) => {
  try {
    const r = await query(
      'SELECT id, name, email, city, location, verified FROM studios ORDER BY id DESC'
    );
    res.json({ studios: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT b.id, b.payment_status, b.timestamp,
              u.name AS user_name, u.email AS user_email,
              c.name AS class_name, c.datetime,
              s.name AS studio_name
         FROM bookings b
         JOIN users u ON u.id=b.user_id
         JOIN classes c ON c.id=b.class_id
         JOIN studios s ON s.id=c.studio_id
        ORDER BY b.timestamp DESC`
    );
    res.json({ bookings: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const r = await query('DELETE FROM users WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/studios/:id', requireAdmin, async (req, res) => {
  try {
    const r = await query('DELETE FROM studios WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Studio not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/studios/:id/verify', requireAdmin, async (req, res) => {
  const { verified } = req.body || {};
  try {
    const r = await query(
      'UPDATE studios SET verified=$1 WHERE id=$2 RETURNING id,name,verified',
      [!!verified, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Studio not found' });
    res.json({ studio: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// PASSWORD RESET
// =====================

app.post('/auth/request-password-reset', resetLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const normalizedEmail = email.trim().toLowerCase();
  try {
    // Check studios first, then users
    const studioRes = await query('SELECT id, name FROM studios WHERE lower(email)=$1', [normalizedEmail]);
    if (studioRes.rows.length > 0) {
      const studio = studioRes.rows[0];
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expires = new Date(Date.now() + 1000 * 60 * 30);
      await query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
        [-studio.id, tokenHash, expires] // negative id = studio
      );
      const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset?token=${token}&type=studio`;
      const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
          <h2 style="color:#2563eb">Reset your password</h2>
          <p>Hi ${studio.name}, click below to reset your FitFlex studio password. Expires in 30 minutes.</p>
          <a href="${resetLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Reset Password</a>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
        </div>`;
      await sendEmail({ to: email, subject: 'Reset your FitFlex studio password', html });
      const resp = { message: 'If the email exists, a reset link has been sent.' };
      if (!resend) resp.devResetLink = resetLink;
      return res.json(resp);
    }

    const user = await query('SELECT id, name FROM users WHERE lower(email)=$1', [normalizedEmail]);
    if (user.rows.length > 0) {
      const userId = user.rows[0].id;
      const userName = user.rows[0].name;
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expires = new Date(Date.now() + 1000 * 60 * 30); // 30 min

      await query(
        'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
        [userId, tokenHash, expires]
      );

      const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset?token=${token}`;

      // Send reset email
      const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
          <h2 style="color:#2563eb">Reset your password</h2>
          <p>Hi ${userName}, we received a request to reset your FitFlex password.</p>
          <p>Click the button below to set a new password. This link expires in 30 minutes.</p>
          <a href="${resetLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">
            Reset Password
          </a>
          <p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
        </div>`;

      await sendEmail({ to: email, subject: 'Reset your FitFlex password', html });

      // In dev (no email configured), expose the link in the response
      const resp = { message: 'If the email exists, a reset link has been sent.' };
      if (!resend) resp.devResetLink = resetLink;
      return res.json(resp);
    }
    return res.json({ message: 'If the email exists, a reset link has been sent.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and newPassword required' });
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const found = await query(
      `SELECT pr.user_id FROM password_resets pr
       WHERE pr.token_hash=$1 AND pr.expires_at > NOW()
       ORDER BY pr.id DESC LIMIT 1`,
      [tokenHash]
    );
    if (found.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });
    const rawId = found.rows[0].user_id;
    const hashed = await bcrypt.hash(newPassword, 10);
    if (rawId < 0) {
      // Studio (stored as negative id)
      await query('UPDATE studios SET password=$1 WHERE id=$2', [hashed, -rawId]);
    } else {
      await query('UPDATE users SET password=$1 WHERE id=$2', [hashed, rawId]);
    }
    await query('DELETE FROM password_resets WHERE user_id=$1', [rawId]);
    return res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// =====================
// 24H CLASS REMINDER CRON
// =====================

async function sendEventReminders() {
  try {
    const r = await query(
      `SELECT ge.id, ge.title, ge.datetime, ge.location,
              g.name AS group_name,
              u.name AS user_name, u.email AS user_email
         FROM group_events ge
         JOIN groups g ON g.id = ge.group_id
         JOIN group_members gm ON gm.group_id = ge.group_id
         JOIN users u ON u.id = gm.user_id
        WHERE ge.datetime BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'`,
      []
    );
    if (!r.rows.length) return;
    console.log(`[cron] Sending 24h event reminders for ${r.rows.length} attendee(s)`);
    await Promise.all(r.rows.map(row => {
      const friendlyDate = new Date(row.datetime).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const friendlyTime = new Date(row.datetime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
          <h2 style="color:#2563eb">Event reminder ⏰</h2>
          <p>Hi ${row.user_name}, your group event is tomorrow!</p>
          <div style="background:#f0f7ff;border-radius:12px;padding:16px;margin:16px 0">
            <p style="margin:0 0 6px"><strong>${row.title}</strong></p>
            <p style="margin:0 0 4px;color:#555">👥 ${row.group_name}</p>
            <p style="margin:0 0 4px;color:#555">📅 ${friendlyDate}</p>
            <p style="margin:0 0 4px;color:#555">🕐 ${friendlyTime}</p>
            ${row.location ? `<p style="margin:0;color:#555">📍 ${row.location}</p>` : ''}
          </div>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
        </div>`;
      return sendEmail({ to: row.user_email, subject: `Reminder: ${row.title} is tomorrow`, html });
    }));
  } catch (e) {
    console.error('[cron] Event reminder error:', e);
  }
}

async function sendClassReminders() {
  try {
    const r = await query(
      `SELECT c.id, c.name, c.datetime, s.name AS studio_name, s.location,
              u.name AS user_name, u.email AS user_email
         FROM classes c
         JOIN studios s ON s.id = c.studio_id
         JOIN bookings b ON b.class_id = c.id
         JOIN users u ON u.id = b.user_id
        WHERE c.datetime BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'`,
      []
    );
    if (!r.rows.length) return;
    console.log(`[cron] Sending 24h reminders for ${r.rows.length} booking(s)`);
    await Promise.all(r.rows.map(row => {
      const friendlyDate = new Date(row.datetime).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
      });
      const friendlyTime = new Date(row.datetime).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit'
      });
      const html = `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
          <h2 style="color:#2563eb">Class reminder ⏰</h2>
          <p>Hi ${row.user_name}, your class is tomorrow!</p>
          <div style="background:#f0f7ff;border-radius:12px;padding:16px;margin:16px 0">
            <p style="margin:0 0 6px"><strong>${row.class_name}</strong></p>
            <p style="margin:0 0 4px;color:#555">📍 ${row.studio_name}${row.location ? ' · ' + row.location : ''}</p>
            <p style="margin:0 0 4px;color:#555">📅 ${friendlyDate}</p>
            <p style="margin:0;color:#555">🕐 ${friendlyTime}</p>
          </div>
          <p style="color:#888;font-size:13px">See you there! If you can no longer make it, please cancel from your dashboard so others can take your spot.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
          <p style="color:#aaa;font-size:12px">FitFlex — your fitness marketplace</p>
        </div>`;
      return sendEmail({
        to: row.user_email,
        subject: `Reminder: ${row.class_name} is tomorrow`,
        html,
      });
    }));
  } catch (e) {
    console.error('[cron] Reminder error:', e);
  }
}

// Run every hour at :00
cron.schedule('0 * * * *', async () => {
  await sendClassReminders();
  await sendEventReminders();
});

// ---- Workout plan parser ----
const XLSX = require('xlsx');

const planUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname) ||
      file.mimetype === 'text/csv' ||
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('excel');
    ok ? cb(null, true) : cb(new Error('Only Excel or CSV files are allowed'));
  },
});

app.post('/api/workout-plan/parse', requireAuth, planUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheets = wb.SheetNames.map(name => {
      const ws = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      // Strip completely empty rows
      const cleaned = rows.filter(r => r.some(c => c !== '' && c !== null && c !== undefined));
      return { name, rows: cleaned };
    });
    res.json({ sheets });
  } catch (e) {
    res.status(400).json({ error: 'Could not parse file: ' + e.message });
  }
});

// ---- Start ----
app.listen(port, '0.0.0.0', () => {
  console.log(`FitFlex backend running on http://0.0.0.0:${port}`);
  if (!resend) console.log('[email] No RESEND_API_KEY — emails will be logged to console only');
  if (!isProd) console.log('[auth] Running in development mode — cookies use SameSite=Lax');
});
