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
  accepts_enquiries BOOLEAN DEFAULT FALSE,
  offers_appointments BOOLEAN DEFAULT FALSE
);

-- Appointment slots
CREATE TABLE IF NOT EXISTS appointment_slots (
  id SERIAL PRIMARY KEY,
  studio_id INT REFERENCES studios(id) ON DELETE CASCADE,
  datetime TIMESTAMPTZ NOT NULL,
  duration_minutes INT DEFAULT 60,
  capacity INT DEFAULT 1,
  credit_cost INT DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slot_bookings (
  id SERIAL PRIMARY KEY,
  slot_id INT REFERENCES appointment_slots(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(slot_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_slots_studio ON appointment_slots(studio_id, datetime);
CREATE INDEX IF NOT EXISTS idx_slot_bookings_slot ON slot_bookings(slot_id);
CREATE INDEX IF NOT EXISTS idx_slot_bookings_user ON slot_bookings(user_id);

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

-- Communities
CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sport_type TEXT,
  city TEXT,
  description TEXT,
  cover_emoji TEXT DEFAULT '🏃',
  is_private BOOLEAN DEFAULT FALSE,
  is_feed_public BOOLEAN DEFAULT FALSE,
  creator_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_members (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',  -- 'admin' or 'member'
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gm_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id);

-- Group events
CREATE TABLE IF NOT EXISTS group_events (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  creator_id INT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  datetime TIMESTAMPTZ NOT NULL,
  location TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_rsvps (
  id SERIAL PRIMARY KEY,
  event_id INT REFERENCES group_events(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('going','maybe','not_going')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ge_group ON group_events(group_id);

-- Group feed
CREATE TABLE IF NOT EXISTS group_posts (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES groups(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS post_comments (
  id SERIAL PRIMARY KEY,
  post_id INT REFERENCES group_posts(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_group ON group_posts(group_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id);

-- Social graph
CREATE TABLE IF NOT EXISTS user_follows (
  id SERIAL PRIMARY KEY,
  follower_id INT REFERENCES users(id) ON DELETE CASCADE,
  following_id INT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, following_id)
);

-- Direct messages
CREATE TABLE IF NOT EXISTS direct_messages (
  id SERIAL PRIMARY KEY,
  sender_type TEXT NOT NULL,
  sender_id INT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_id INT NOT NULL,
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON user_follows(following_id);
CREATE INDEX IF NOT EXISTS idx_dm_recipient ON direct_messages(recipient_type, recipient_id, read);
CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_type, sender_id);
CREATE INDEX IF NOT EXISTS idx_er_event ON event_rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_er_user ON event_rsvps(user_id);
