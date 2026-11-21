// Regression tests for the credit / authorization fixes.
// Needs a local Postgres. Creates (and drops) a throwaway `fitflex_test` DB.
//   npm test
// Override the server with TEST_PG_ADMIN_URL / TEST_DATABASE_URL if needed.

// --- Env must be set BEFORE server.js loads (dotenv never overrides set vars) ---
const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgresql://localhost:5432/postgres';
const TEST_DB = 'fitflex_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || `postgresql://localhost:5432/${TEST_DB}`;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_not_used_for_network';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
// Make sure tests never send real email / WhatsApp from the developer's .env
process.env.RESEND_API_KEY = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.TWILIO_AUTH_TOKEN = '';
process.env.CLOUDINARY_CLOUD_NAME = '';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const Stripe = require('stripe');

let app, pool;

before(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'schema', 'fitflex_schema.sql'), 'utf8'));
  await db.end();

  // Silence the server's startup logging/migration chatter.
  const origErr = console.error;
  console.error = () => {};
  ({ app, pool, schemaReady } = require('../server'));
  await schemaReady;
  // Startup migrations for other tables are fire-and-forget; give them a moment.
  await new Promise(r => setTimeout(r, 300));
  console.error = origErr;
});
let schemaReady;

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE slot_bookings, appointment_slots, bookings, classes, credit_purchases, notifications, users, studios RESTART IDENTITY CASCADE');
});

// ---- helpers ----
const tokenFor = (id, role) => jwt.sign({ id, role, email: `${role}${id}@test.dev` }, process.env.JWT_SECRET);
const auth = (id, role) => ({ Authorization: `Bearer ${tokenFor(id, role)}` });

async function makeUser(credits = 10) {
  const r = await pool.query(
    `INSERT INTO users (name, email, password, credits) VALUES ($1,$2,'x',$3) RETURNING id`,
    [`u${Math.random()}`, `u${Math.random()}@test.dev`, credits]
  );
  return r.rows[0].id;
}
async function makeStudio() {
  const r = await pool.query(
    `INSERT INTO studios (name, email, password) VALUES ($1,$2,'x') RETURNING id`,
    [`s${Math.random()}`, `s${Math.random()}@test.dev`]
  );
  return r.rows[0].id;
}
const future = () => new Date(Date.now() + 7 * 864e5);
async function makeClass(studioId, { cost = 1, capacity = null } = {}) {
  const r = await pool.query(
    `INSERT INTO classes (studio_id, name, datetime, credit_cost, capacity) VALUES ($1,'Yoga',$2,$3,$4) RETURNING id`,
    [studioId, future(), cost, capacity]
  );
  return r.rows[0].id;
}
async function makeSlot(studioId, { cost = 2, capacity = 1 } = {}) {
  const r = await pool.query(
    `INSERT INTO appointment_slots (studio_id, datetime, credit_cost, capacity) VALUES ($1,$2,$3,$4) RETURNING id`,
    [studioId, future(), cost, capacity]
  );
  return r.rows[0].id;
}
const credits = async (userId) => (await pool.query('SELECT credits FROM users WHERE id=$1', [userId])).rows[0].credits;

// ---- free-credit exploit ----
test('cancelling a slot you never booked does NOT refund credits', async () => {
  const studio = await makeStudio();
  const user = await makeUser(10);
  const slot = await makeSlot(studio, { cost: 5 });

  for (let i = 0; i < 3; i++) {
    const res = await request(app).delete(`/api/slots/${slot}/book`).set(auth(user, 'user'));
    assert.equal(res.status, 404);
  }
  assert.equal(await credits(user), 10);
});

test('a slot booking is refunded exactly once, even if cancel is repeated', async () => {
  const studio = await makeStudio();
  const user = await makeUser(10);
  const slot = await makeSlot(studio, { cost: 4 });

  assert.equal((await request(app).post(`/api/slots/${slot}/book`).set(auth(user, 'user'))).status, 201);
  assert.equal(await credits(user), 6);

  const results = await Promise.all([1, 2, 3].map(() =>
    request(app).delete(`/api/slots/${slot}/book`).set(auth(user, 'user'))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 404, 404]);
  assert.equal(await credits(user), 10);
});

// ---- transactions / races ----
test('parallel bookings cannot spend more credits than the user has', async () => {
  const studio = await makeStudio();
  const user = await makeUser(1);
  const classIds = await Promise.all([1, 2, 3, 4, 5].map(() => makeClass(studio, { cost: 1 })));

  const results = await Promise.all(classIds.map(id =>
    request(app).post('/api/book').set(auth(user, 'user')).send({ class_id: id })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(await credits(user), 0);
});

test('parallel bookings cannot exceed class capacity', async () => {
  const studio = await makeStudio();
  const cls = await makeClass(studio, { cost: 1, capacity: 1 });
  const users = await Promise.all([1, 2, 3, 4, 5].map(() => makeUser(10)));

  const results = await Promise.all(users.map(u =>
    request(app).post('/api/book').set(auth(u, 'user')).send({ class_id: cls })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  const n = (await pool.query('SELECT COUNT(*)::int AS c FROM bookings WHERE class_id=$1', [cls])).rows[0].c;
  assert.equal(n, 1);
});

test('the same user cannot double-book a class in parallel', async () => {
  const studio = await makeStudio();
  const user = await makeUser(10);
  const cls = await makeClass(studio, { cost: 2 });

  const results = await Promise.all([1, 2, 3].map(() =>
    request(app).post('/api/book').set(auth(user, 'user')).send({ class_id: cls })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(await credits(user), 8);
});

test('a class booking is refunded exactly once under parallel cancels', async () => {
  const studio = await makeStudio();
  const user = await makeUser(10);
  const cls = await makeClass(studio, { cost: 3 });
  await request(app).post('/api/book').set(auth(user, 'user')).send({ class_id: cls });
  const bookingId = (await pool.query('SELECT id FROM bookings WHERE user_id=$1', [user])).rows[0].id;

  const results = await Promise.all([1, 2, 3].map(() =>
    request(app).delete(`/api/bookings/${bookingId}`).set(auth(user, 'user'))));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(await credits(user), 10);
});

test('refund uses the price actually paid, not a later raised price', async () => {
  const studio = await makeStudio();
  const user = await makeUser(10);
  const cls = await makeClass(studio, { cost: 1 });
  await request(app).post('/api/book').set(auth(user, 'user')).send({ class_id: cls });

  const patch = await request(app).patch(`/api/classes/${cls}`).set(auth(studio, 'studio')).send({ credit_cost: 100 });
  assert.equal(patch.status, 200);

  const bookingId = (await pool.query('SELECT id FROM bookings WHERE user_id=$1', [user])).rows[0].id;
  await request(app).delete(`/api/bookings/${bookingId}`).set(auth(user, 'user'));
  assert.equal(await credits(user), 10);
});

// ---- role confusion ----
test('a studio token cannot book / cancel as the user with the same id', async () => {
  const studio = await makeStudio(); // id 1
  const user = await makeUser(10);   // id 1 — same number, different table
  assert.equal(studio, user);
  const cls = await makeClass(studio, { cost: 2 });

  const book = await request(app).post('/api/book').set(auth(studio, 'studio')).send({ class_id: cls });
  assert.equal(book.status, 403);
  assert.equal(await credits(user), 10);

  await request(app).post('/api/book').set(auth(user, 'user')).send({ class_id: cls });
  const bookingId = (await pool.query('SELECT id FROM bookings WHERE user_id=$1', [user])).rows[0].id;
  const cancel = await request(app).delete(`/api/bookings/${bookingId}`).set(auth(studio, 'studio'));
  assert.equal(cancel.status, 403);

  const slot = await makeSlot(studio);
  assert.equal((await request(app).post(`/api/slots/${slot}/book`).set(auth(studio, 'studio'))).status, 403);
  assert.equal((await request(app).post('/api/groups').set(auth(studio, 'studio')).send({ name: 'x' })).status, 403);
});

// ---- price validation ----
test('studios cannot set negative or fractional credit costs', async () => {
  const studio = await makeStudio();
  const s = auth(studio, 'studio');
  const dt = future().toISOString();

  assert.equal((await request(app).post(`/api/studios/${studio}/classes`).set(s).send({ name: 'x', datetime: dt, credit_cost: -50 })).status, 400);
  assert.equal((await request(app).post(`/api/studios/${studio}/classes`).set(s).send({ name: 'x', datetime: dt, credit_cost: 1.5 })).status, 400);
  assert.equal((await request(app).post(`/api/studios/${studio}/slots`).set(s).send({ datetime: dt, credit_cost: -1 })).status, 400);

  const cls = await makeClass(studio);
  assert.equal((await request(app).patch(`/api/classes/${cls}`).set(s).send({ credit_cost: -10 })).status, 400);
  assert.equal((await request(app).patch(`/api/classes/${cls}`).set(s).send({ capacity: -1 })).status, 400);

  const ok = await request(app).post(`/api/studios/${studio}/classes`).set(s).send({ name: 'Free intro', datetime: dt, credit_cost: 0 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.class.credit_cost, 0);
});

// ---- Stripe webhook ----
function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return { payload, header };
}

test('Stripe webhook verifies signature and grants credits exactly once on retries', async () => {
  const user = await makeUser(0);
  const event = {
    id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123', payment_status: 'paid', metadata: { user_id: String(user), pack_id: 'pack_10', credits: '10' } } },
  };
  const { payload, header } = signedWebhook(event);

  for (let i = 0; i < 3; i++) {
    const res = await request(app).post('/api/payments/webhook')
      .set('Content-Type', 'application/json').set('stripe-signature', header).send(payload);
    assert.equal(res.status, 200);
  }
  assert.equal(await credits(user), 10);
  const n = (await pool.query('SELECT COUNT(*)::int AS c FROM credit_purchases WHERE user_id=$1', [user])).rows[0].c;
  assert.equal(n, 1);
});

test('Stripe webhook rejects a bad signature', async () => {
  const user = await makeUser(0);
  const res = await request(app).post('/api/payments/webhook')
    .set('Content-Type', 'application/json').set('stripe-signature', 't=1,v1=deadbeef')
    .send(JSON.stringify({ type: 'checkout.session.completed', data: { object: { metadata: { user_id: String(user) } } } }));
  assert.equal(res.status, 400);
  assert.equal(await credits(user), 0);
});

test('regular JSON routes still parse bodies', async () => {
  const studio = await makeStudio();
  const res = await request(app).post(`/api/studios/${studio}/classes`).set(auth(studio, 'studio'))
    .send({ name: 'Pilates', datetime: future().toISOString(), credit_cost: 2, capacity: 8 });
  assert.equal(res.status, 201);
  assert.equal(res.body.class.capacity, 8);
});
