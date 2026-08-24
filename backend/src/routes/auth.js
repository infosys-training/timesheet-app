const express = require('express');
const { getDatabase } = require('../database/init');
const { emailSchema } = require('../validation/schemas');
const { authenticateUser } = require('../middleware/auth');

function configuredRole(email) {
  return (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase()) ? 'approver' : 'member';
}

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
    db.get('SELECT email, role, created_at FROM users WHERE email = ?', [email], (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (row) {
        const role = configuredRole(email);
        const respond = () => res.json({
          message: 'Login successful',
          user: { email: row.email, role, createdAt: row.created_at }
        });
        if ((row.role || 'member') === role) return respond();
        return db.run('UPDATE users SET role = ? WHERE email = ?', [role, email], (updateError) => {
          if (updateError) {
            console.error('Error reconciling user role:', updateError);
            return res.status(500).json({ error: 'Internal server error' });
          }
          respond();
        });
      } else {
        // Create new user
        db.run('INSERT INTO users (email) VALUES (?)', [email], function(err) {
          if (err) {
            console.error('Error creating user:', err);
            return res.status(500).json({ error: 'Failed to create user' });
          }

          const role = configuredRole(email);
          db.run('UPDATE users SET role = ? WHERE email = ?', [role, email], (updateError) => {
            if (updateError) {
              console.error('Error setting user role:', updateError);
              return res.status(500).json({ error: 'Failed to create user' });
            }
            res.status(201).json({
              message: 'User created and logged in successfully',
              user: {
                email: email,
                role,
                createdAt: new Date().toISOString()
              }
            });
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
  
  db.get('SELECT email, role, created_at FROM users WHERE email = ?', [req.userEmail], (err, row) => {
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
        role: row.role || req.role || 'member',
        createdAt: row.created_at
      }
    });
  });
});

module.exports = router;
