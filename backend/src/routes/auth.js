const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDatabase } = require('../database/init');
const { loginSchema, registerSchema } = require('../validation/schemas');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';
const JWT_EXPIRES_IN = '24h';
const SALT_ROUNDS = 10;

function generateToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function findUserByEmail(db, query, email) {
  return new Promise((resolve, reject) => {
    db.get(query, [email], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function insertUser(db, email, passwordHash) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, passwordHash], function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

router.post('/register', async (req, res, next) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) return next(error);

    const { email, password } = value;
    const db = getDatabase();

    const existing = await findUserByEmail(db, 'SELECT email FROM users WHERE email = ?', email);
    if (existing) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    await insertUser(db, email, passwordHash);

    res.status(201).json({
      message: 'User created and logged in successfully',
      token: generateToken(email),
      user: { email, createdAt: new Date().toISOString() }
    });
  } catch (err) {
    if (err.message === 'Insert failed' || err.message?.includes('insert')) {
      console.error('Error creating user:', err);
      return res.status(500).json({ error: 'Failed to create user' });
    }
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return next(error);

    const { email, password } = value;
    const db = getDatabase();

    const row = await findUserByEmail(
      db, 'SELECT email, password_hash, created_at FROM users WHERE email = ?', email
    );
    if (!row) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const passwordMatch = await bcrypt.compare(password, row.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({
      message: 'Login successful',
      token: generateToken(row.email),
      user: { email: row.email, createdAt: row.created_at }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', authenticateUser, (req, res) => {
  const db = getDatabase();
  
  db.get('SELECT email, created_at FROM users WHERE email = ?', [req.userEmail], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: { email: row.email, createdAt: row.created_at }
    });
  });
});

module.exports = router;
