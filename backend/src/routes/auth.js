const express = require('express');
const { getDatabase } = require('../database/init');
const { emailSchema } = require('../validation/schemas');
const { authenticateUser } = require('../middleware/auth');
const { parseApproverEmails } = require('../middleware/auth');

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
    const isApprover = parseApproverEmails().has(email.toLowerCase());

    // Check if user exists
    db.get('SELECT email, role, created_at FROM users WHERE email = ?', [email], (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (row) {
        const role = row.role || 'user';
        const respond = (userRole) => res.json({
          message: 'Login successful',
          user: {
            email: row.email,
            createdAt: row.created_at,
            role: userRole
          }
        });
        if (isApprover && role !== 'approver') {
          return db.run(
            'UPDATE users SET role = ? WHERE email = ?',
            ['approver', email],
            (updateErr) => {
              if (updateErr) {
                console.error('Error updating user role:', updateErr);
                return res.status(500).json({ error: 'Failed to update user role' });
              }
              respond('approver');
            }
          );
        }
        return respond(role);
      } else {
        // Create new user
        const insertQuery = isApprover
          ? 'INSERT INTO users (email, role) VALUES (?, ?)'
          : 'INSERT INTO users (email) VALUES (?)';
        const insertParams = isApprover ? [email, 'approver'] : [email];
        db.run(insertQuery, insertParams, function(err) {
          if (err) {
            console.error('Error creating user:', err);
            return res.status(500).json({ error: 'Failed to create user' });
          }

          res.status(201).json({
            message: 'User created and logged in successfully',
            user: {
              email: email,
              createdAt: new Date().toISOString(),
              role: isApprover ? 'approver' : 'user'
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
        createdAt: row.created_at,
        role: row.role || req.userRole || 'user'
      }
    });
  });
});

module.exports = router;
