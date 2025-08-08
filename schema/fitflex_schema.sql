
-- FitFlex Database Schema

-- Users of the platform
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  credits INT DEFAULT 5
);

-- Studios (gyms, yoga centers, etc.)
CREATE TABLE studios (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  description TEXT
);

-- Fitness classes offered by studios
CREATE TABLE classes (
  id SERIAL PRIMARY KEY,
  studio_id INT REFERENCES studios(id),
  name TEXT NOT NULL,
  datetime TIMESTAMP NOT NULL,
  sport_type TEXT,
  credit_cost INT DEFAULT 1,
  capacity INT
);

-- Bookings made by users for classes
CREATE TABLE bookings (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  class_id INT REFERENCES classes(id),
  payment_status TEXT DEFAULT 'paid',
  timestamp TIMESTAMP DEFAULT NOW()
);
