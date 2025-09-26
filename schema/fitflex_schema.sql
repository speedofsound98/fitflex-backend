-- Drop old tables if you’re resetting (order matters due to FKs)
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS classes;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS studios;

-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,              -- add this
  credits INT DEFAULT 5
);

-- Studios
CREATE TABLE studios (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,           -- studio name unique helps UX
  email TEXT UNIQUE NOT NULL,          -- add this
  password TEXT NOT NULL,              -- add this
  location TEXT,
  description TEXT
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
