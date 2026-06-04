const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser } = require('../middleware/auth');
const PDFDocument = require('pdfkit');

const router = express.Router();

// All routes require authentication
router.use(authenticateUser);

const MAX_ENTRIES = 10000;

function buildDateFilteredQuery(baseQuery, baseCountQuery, req) {
  const { startDate, endDate } = req.query;
  const params = [parseInt(req.params.clientId), req.userEmail];
  let countQuery = baseCountQuery;
  let dataQuery = baseQuery;

  if (startDate) {
    countQuery += ' AND date >= ?';
    dataQuery += ' AND date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    countQuery += ' AND date <= ?';
    dataQuery += ' AND date <= ?';
    params.push(endDate);
  }

  return { countQuery, dataQuery, params };
}

function verifyClientOwnership(db, clientId, userEmail, callback) {
  db.get(
    'SELECT id, name FROM clients WHERE id = ? AND user_email = ?',
    [clientId, userEmail],
    callback
  );
}

function checkEntryCountAndFetch(db, countQuery, dataQuery, params, callback) {
  db.get(countQuery, params, (err, result) => {
    if (err) {
      return callback(err, null, null);
    }
    if (result.count > MAX_ENTRIES) {
      return callback(null, null, result.count);
    }
    db.all(dataQuery, params, (err, entries) => {
      if (err) {
        return callback(err, null, null);
      }
      callback(null, entries, result.count);
    });
  });
}

// Get hourly report for specific client
router.get('/client/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }

  const db = getDatabase();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;

  verifyClientOwnership(db, clientId, req.userEmail, (err, client) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const baseCount = 'SELECT COUNT(*) as count FROM work_entries WHERE client_id = ? AND user_email = ?';
    const baseData = `SELECT id, hours, description, date, created_at, updated_at
       FROM work_entries WHERE client_id = ? AND user_email = ?`;
    const { countQuery, dataQuery, params } = buildDateFilteredQuery(baseData, baseCount, req);

    const paginatedQuery = dataQuery + ' ORDER BY date DESC LIMIT ? OFFSET ?';
    const dataParams = [...params, limit, offset];

    db.get(countQuery, params, (err, result) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (result.count > MAX_ENTRIES) {
        return res.status(400).json({
          error: 'Too many entries (' + result.count + '). Please filter by date range using startDate and endDate query parameters.'
        });
      }

      db.all(paginatedQuery, dataParams, (err, workEntries) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        const totalHours = workEntries.reduce((sum, entry) => sum + parseFloat(entry.hours), 0);
        res.json({
          client: client,
          workEntries: workEntries,
          totalHours: totalHours,
          entryCount: workEntries.length,
          totalCount: result.count
        });
      });
    });
  });
});

// Export client report as CSV (streamed directly)
router.get('/export/csv/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }

  const db = getDatabase();

  verifyClientOwnership(db, clientId, req.userEmail, (err, client) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const baseCount = 'SELECT COUNT(*) as count FROM work_entries WHERE client_id = ? AND user_email = ?';
    const baseData = `SELECT hours, description, date, created_at
       FROM work_entries WHERE client_id = ? AND user_email = ?`;
    const { countQuery, dataQuery, params } = buildDateFilteredQuery(baseData, baseCount, req);
    const orderedQuery = dataQuery + ' ORDER BY date DESC';

    checkEntryCountAndFetch(db, countQuery, orderedQuery, params, (err, workEntries, count) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!workEntries) {
        return res.status(400).json({
          error: 'Too many entries (' + count + '). Please filter by date range using startDate and endDate query parameters.'
        });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${client.name.replace(/[^a-zA-Z0-9]/g, '_')}_report_${timestamp}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.write('Date,Hours,Description,Created At\n');

      workEntries.forEach(entry => {
        const desc = (entry.description || '').replace(/"/g, '""');
        const createdAt = (entry.created_at || '').replace(/"/g, '""');
        res.write(`"${entry.date}","${entry.hours}","${desc}","${createdAt}"\n`);
      });

      res.end();
    });
  });
});

// Export client report as PDF
router.get('/export/pdf/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }

  const db = getDatabase();

  verifyClientOwnership(db, clientId, req.userEmail, (err, client) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const baseCount = 'SELECT COUNT(*) as count FROM work_entries WHERE client_id = ? AND user_email = ?';
    const baseData = `SELECT hours, description, date, created_at
       FROM work_entries WHERE client_id = ? AND user_email = ?`;
    const { countQuery, dataQuery, params } = buildDateFilteredQuery(baseData, baseCount, req);
    const orderedQuery = dataQuery + ' ORDER BY date DESC';

    checkEntryCountAndFetch(db, countQuery, orderedQuery, params, (err, workEntries, count) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!workEntries) {
        return res.status(400).json({
          error: 'Too many entries (' + count + '). Please filter by date range using startDate and endDate query parameters.'
        });
      }

      const doc = new PDFDocument();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${client.name.replace(/[^a-zA-Z0-9]/g, '_')}_report_${timestamp}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      doc.fontSize(20).text(`Time Report for ${client.name}`, { align: 'center' });
      doc.moveDown();

      const totalHours = workEntries.reduce((sum, entry) => sum + parseFloat(entry.hours), 0);
      doc.fontSize(14).text(`Total Hours: ${totalHours.toFixed(2)}`);
      doc.text(`Total Entries: ${workEntries.length}`);
      doc.text(`Generated: ${new Date().toLocaleString()}`);
      doc.moveDown();

      doc.fontSize(12).text('Date', 50, doc.y, { width: 100 });
      doc.text('Hours', 150, doc.y - 15, { width: 80 });
      doc.text('Description', 230, doc.y - 15, { width: 300 });
      doc.moveDown();
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.5);

      workEntries.forEach((entry, index) => {
        const y = doc.y;
        if (y > 700) {
          doc.addPage();
        }
        doc.text(entry.date, 50, doc.y, { width: 100 });
        doc.text(entry.hours.toString(), 150, y, { width: 80 });
        doc.text(entry.description || 'No description', 230, y, { width: 300 });
        doc.moveDown();
        if ((index + 1) % 5 === 0) {
          doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
          doc.moveDown(0.5);
        }
      });

      doc.end();
    });
  });
});

module.exports = router;
