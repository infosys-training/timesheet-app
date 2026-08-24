const express = require('express');
const { getDatabase } = require('../database/init');
const { emailSchema } = require('../validation/schemas');
const { authenticateUser, resolveRole } = require('../middleware/auth');

const router = express.Router();

// Login endpoint - creates user if doesn't exist
router.post('/login', async (req, res, next) => {
  try {
    const { error, value } = emailSchema.validate(req.body);
    if (error) {
      return next(error);
    }

    const { email } = value;
    const db = getDatabase();

    // Check if user exists
    const role = resolveRole(email);
    db.get('SELECT email, created_at, role FROM users WHERE email = ?', [email], (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (row) {
        // Keep the role synchronized with the current configuration.
        if (row.role !== role) {
          db.run('UPDATE users SET role = ? WHERE email = ?', [role, email], (updateErr) => {
            if (updateErr) {
              console.error('Database error:', updateErr);
            }
          });
        }
        return res.json({
          message: 'Login successful',
          user: {
            email: row.email,
            createdAt: row.created_at,
            role
          }
        });
      } else {
        // Create new user
        db.run('INSERT INTO users (email, role) VALUES (?, ?)', [email, role], function(err) {
          if (err) {
            console.error('Error creating user:', err);
            return res.status(500).json({ error: 'Failed to create user' });
          }

          res.status(201).json({
            message: 'User created and logged in successfully',
            user: {
              email: email,
              createdAt: new Date().toISOString(),
              role
            }
          });
        });
      }
    });
  } catch (error) {
    next(error);
  }
});

// Get current user info
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
      user: {
        email: row.email,
        createdAt: row.created_at,
        role: req.userRole
      }
    });
  });
});

module.exports = router;
