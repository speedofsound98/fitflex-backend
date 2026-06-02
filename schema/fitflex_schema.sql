-- Drop old tables if you're resetting (order matters due to FKs)
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS classes;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS studios;

-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  credits INT DEFAULT 5,
  bio TEXT,
  public_fields TEXT DEFAULT 'name',
  phone TEXT
);

-- Studios
CREATE TABLE studios (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  location TEXT,              -- legacy free-text field
  city TEXT,                  -- structured location
  neighbourhood TEXT,
  about TEXT,
  phone TEXT,
  website TEXT,
  instagram TEXT,
  verified BOOLEAN DEFAULT FALSE,
  description TEXT,
  accepts_enquiries BOOLEAN DEFAULT FALSE
);

-- Classes
CREATE TABLE classes (
  id SERIAL PRIMARY KEY,
  studio_id INT REFERENCES studios(id),
  name TEXT NOT NULL,
  datetime TIMESTAMP NOT NULL,
  sport_type TEXT,
  credit_cost INT DEFAULT 1,
  capacity INT
);

-- Bookings
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  class_id INT REFERENCES classes(id),
  payment_status TEXT DEFAULT 'paid',
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwresets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_pwresets_expires ON password_resets(expires_at);

-- Credit purchases (Stripe payments)
CREATE TABLE IF NOT EXISTS credit_purchases (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  credits INT NOT NULL,
  amount_cents INT NOT NULL,
  stripe_session_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cp_user ON credit_purchases(user_id);

-- In-app notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  recipient_type TEXT NOT NULL,  -- 'user' or 'studio'
  recipient_id INT NOT NULL,
  type TEXT NOT NULL,            -- 'booking', 'cancellation', 'message', 'enquiry'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications(recipient_type, recipient_id, read);
