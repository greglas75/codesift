-- SQL schema — what's actually in the database
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  total INT NOT NULL,
  status TEXT NOT NULL
);

-- Extra table that has no Prisma model — also drift
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  occurred_at TIMESTAMP DEFAULT NOW()
);
