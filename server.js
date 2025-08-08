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

// Start server
app.listen(port, () => {
  console.log(`FitFlex backend running on http://localhost:${port}`);
});
