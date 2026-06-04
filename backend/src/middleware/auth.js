const jwt = require('jsonwebtoken');
const { getDatabase } = require('../database/init');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Authentication middleware with JWT support
function authenticateUser(req, res, next) {
  let userEmail;

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userEmail = decoded.email;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } else if (process.env.NODE_ENV !== 'production') {
    // Fallback for dev/test: allow x-user-email header
    userEmail = req.headers['x-user-email'];
  }

  if (!userEmail) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(userEmail)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const db = getDatabase();

  // Check if user exists, create if not
  db.get('SELECT email FROM users WHERE email = ?', [userEmail], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    if (!row) {
      // Create new user
      db.run('INSERT INTO users (email) VALUES (?)', [userEmail], (err) => {
        if (err) {
          console.error('Error creating user:', err);
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        req.userEmail = userEmail;
        next();
      });
    } else {
      req.userEmail = userEmail;
      next();
    }
  });
}

module.exports = {
  authenticateUser,
  JWT_SECRET
};
