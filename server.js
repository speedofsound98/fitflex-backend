// Basic Express server for FitFlex MVP
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();



const app = express();
const port = process.env.PORT || 3000;

// Simple health check endpoint 
app.get('/api/ping', (req, res) => {
  res.json({ message: 'pong from backend' });
});

// Middleware
app.use(cors());
app.use(bodyParser.json());

// PostgreSQL connection setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Connected to PostgreSQL at:', res.rows[0].now);
  }
});

// Routes
app.get('/', (req, res) => {
  res.send('FitFlex API is running');
});

// Get all classes
app.get('/classes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM classes');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Book a class
app.post('/book', async (req, res) => {
  const { user_id, class_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO bookings (user_id, class_id, payment_status, timestamp) VALUES ($1, $2, $3, NOW())',
      [user_id, class_id, 'paid']
    );
    res.status(201).json({ message: 'Class booked successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user bookings
app.get('/bookings/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE user_id = $1',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const bcrypt = require('bcryptjs');

// POST /signup/user
app.post('/signup/user', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // Check for duplicates
    const existing = await pool.query(
      'SELECT * FROM users WHERE name = $1 OR email = $2',
      [name, email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Name or email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3)',
      [name, email, hashedPassword]
    );

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /signup/studio
app.post('/signup/studio', async (req, res) => {
  const { studio_name, location, email, password } = req.body;

  if (!studio_name || !location || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // Check for duplicates
    const existing = await pool.query(
      'SELECT * FROM studios WHERE studio_name = $1 OR email = $2',
      [studio_name, email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Studio name or email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert studio
    await pool.query(
      'INSERT INTO studios (studio_name, location, email, password) VALUES ($1, $2, $3, $4)',
      [studio_name, location, email, hashedPassword]
    );

    res.status(201).json({ message: 'Studio registered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// Start server
app.listen(port, () => {
  console.log(`FitFlex backend running on http://localhost:${port}`);
});
