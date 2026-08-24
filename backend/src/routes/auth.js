const express = require('express');
const { getDatabase } = require('../database/init');
const { emailSchema } = require('../validation/schemas');
const { authenticateUser, isConfiguredApprover } = require('../middleware/auth');

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
    db.get('SELECT email, created_at, role FROM users WHERE email = ?', [email], (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (row) {
        // User exists
        const role = isConfiguredApprover(row.email) ? 'approver' : (row.role || 'user');
        return res.json({
          message: 'Login successful',
          user: {
            email: row.email,
            createdAt: row.created_at,
            role,
            isApprover: role === 'approver'
          }
        });
      } else {
        // Create new user
        const role = isConfiguredApprover(email) ? 'approver' : 'user';
        const insert = role === 'approver'
          ? ['INSERT INTO users (email, role) VALUES (?, ?)', [email, role]]
          : ['INSERT INTO users (email) VALUES (?)', [email]];
        db.run(insert[0], insert[1], function(err) {
          if (err) {
            console.error('Error creating user:', err);
            return res.status(500).json({ error: 'Failed to create user' });
          }

          res.status(201).json({
            message: 'User created and logged in successfully',
            user: {
              email: email,
              createdAt: new Date().toISOString(),
              role,
              isApprover: role === 'approver'
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
  
  db.get('SELECT email, created_at, role FROM users WHERE email = ?', [req.userEmail], (err, row) => {
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
        role: req.userRole || row.role || 'user',
        isApprover: !!req.isApprover
      }
    });
  });
});

module.exports = router;
