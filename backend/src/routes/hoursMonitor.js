const express = require('express');
const { authenticateUser } = require('../middleware/auth');
const { checkAndAlert } = require('../services/hoursMonitor');

const router = express.Router();

router.use(authenticateUser);

// Check weekly hours for the authenticated user and send alert if threshold exceeded
router.get('/weekly-check', async (req, res) => {
  try {
    const referenceDate = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await checkAndAlert(req.userEmail, referenceDate);
    res.json(result);
  } catch (err) {
    console.error('Hours monitor error:', err);
    res.status(500).json({ error: 'Failed to check weekly hours' });
  }
});

module.exports = router;
