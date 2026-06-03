const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser } = require('../middleware/auth');

const router = express.Router();

router.use(authenticateUser);

// Get all activity codes
router.get('/', (req, res) => {
  const db = getDatabase();

  db.all(
    'SELECT id, code, name, category, description, created_at FROM activity_codes ORDER BY category, code',
    [],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      res.json({ activityCodes: rows });
    }
  );
});

// Get activity codes grouped by category
router.get('/by-category', (req, res) => {
  const db = getDatabase();

  db.all(
    'SELECT id, code, name, category, description, created_at FROM activity_codes ORDER BY category, code',
    [],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      const grouped = {};
      for (const row of rows) {
        if (!grouped[row.category]) {
          grouped[row.category] = [];
        }
        grouped[row.category].push(row);
      }

      res.json({ categories: grouped });
    }
  );
});

// Get a specific activity code
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id);

  if (isNaN(id)) {
    return res.status(400).json({ error: 'Invalid activity code ID' });
  }

  const db = getDatabase();

  db.get(
    'SELECT id, code, name, category, description, created_at FROM activity_codes WHERE id = ?',
    [id],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Activity code not found' });
      }

      res.json({ activityCode: row });
    }
  );
});

// Get drill-down dashboard data for activity codes
router.get('/dashboard/drilldown', (req, res) => {
  const db = getDatabase();

  const summaryQuery = `
    SELECT 
      ac.id as activity_code_id,
      ac.code,
      ac.name as activity_name,
      ac.category,
      COALESCE(SUM(we.hours), 0) as total_hours,
      COUNT(we.id) as entry_count
    FROM activity_codes ac
    LEFT JOIN work_entries we ON we.activity_code_id = ac.id AND we.user_email = ?
    GROUP BY ac.id, ac.code, ac.name, ac.category
    ORDER BY total_hours DESC
  `;

  const categoryQuery = `
    SELECT 
      ac.category,
      COALESCE(SUM(we.hours), 0) as total_hours,
      COUNT(we.id) as entry_count
    FROM activity_codes ac
    LEFT JOIN work_entries we ON we.activity_code_id = ac.id AND we.user_email = ?
    GROUP BY ac.category
    ORDER BY total_hours DESC
  `;

  db.all(summaryQuery, [req.userEmail], (err, byCode) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    db.all(categoryQuery, [req.userEmail], (err, byCategory) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      res.json({
        byActivityCode: byCode,
        byCategory: byCategory,
      });
    });
  });
});

module.exports = router;
