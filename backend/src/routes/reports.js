const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser } = require('../middleware/auth');
const PDFDocument = require('pdfkit');

const router = express.Router();

// All routes require authentication
router.use(authenticateUser);

// Get hourly report for specific client
router.get('/client/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }
  
  const db = getDatabase();
  const { startDate, endDate } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  
  // Verify client belongs to user
  db.get(
    'SELECT id, name FROM clients WHERE id = ? AND user_email = ?',
    [clientId, req.userEmail],
    (err, client) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      let countQuery = 'SELECT COUNT(*) as count FROM work_entries WHERE client_id = ? AND user_email = ?';
      let dataQuery = `SELECT id, hours, description, date, created_at, updated_at
         FROM work_entries WHERE client_id = ? AND user_email = ?`;
      const params = [clientId, req.userEmail];

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

      dataQuery += ' ORDER BY date DESC LIMIT ? OFFSET ?';

      // Check count first
      db.get(countQuery, params, (err, result) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        if (result.count > 10000) {
          return res.status(400).json({
            error: 'Too many entries (' + result.count + '). Please filter by date range using startDate and endDate query parameters.'
          });
        }

        const dataParams = [...params, limit, offset];
        db.all(dataQuery, dataParams, (err, workEntries) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }
          
          // Calculate total hours
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
    }
  );
});

// Export client report as CSV (streamed directly)
router.get('/export/csv/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }
  
  const db = getDatabase();
  const { startDate, endDate } = req.query;
  
  // Verify client belongs to user and get data
  db.get(
    'SELECT id, name FROM clients WHERE id = ? AND user_email = ?',
    [clientId, req.userEmail],
    (err, client) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      let countQuery = 'SELECT COUNT(*) as count FROM work_entries WHERE client_id = ? AND user_email = ?';
      let dataQuery = `SELECT hours, description, date, created_at
         FROM work_entries WHERE client_id = ? AND user_email = ?`;
      const params = [clientId, req.userEmail];

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

      dataQuery += ' ORDER BY date DESC';

      // Check count first
      db.get(countQuery, params, (err, result) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        if (result.count > 10000) {
          return res.status(400).json({
            error: 'Too many entries (' + result.count + '). Please filter by date range using startDate and endDate query parameters.'
          });
        }

        // Get work entries
        db.all(dataQuery, params, (err, workEntries) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }
          
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${client.name.replace(/[^a-zA-Z0-9]/g, '_')}_report_${timestamp}.csv`;

          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

          // Write CSV header
          res.write('Date,Hours,Description,Created At\n');

          // Write each row (escape quotes in description)
          workEntries.forEach(entry => {
            const desc = (entry.description || '').replace(/"/g, '""');
            const createdAt = (entry.created_at || '').replace(/"/g, '""');
            res.write(`"${entry.date}","${entry.hours}","${desc}","${createdAt}"\n`);
          });

          res.end();
        });
      });
    }
  );
});

// Export client report as PDF
router.get('/export/pdf/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }
  
  const db = getDatabase();
  const { startDate, endDate } = req.query;
  
  // Verify client belongs to user and get data
  db.get(
    'SELECT id, name FROM clients WHERE id = ? AND user_email = ?',
    [clientId, req.userEmail],
    (err, client) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      
      if (!client) {
        return res.status(404).json({ error: 'Client not found' });
      }
      
      let countQuery = 'SELECT COUNT(*) as count FROM work_entries WHERE client_id = ? AND user_email = ?';
      let dataQuery = `SELECT hours, description, date, created_at
         FROM work_entries WHERE client_id = ? AND user_email = ?`;
      const params = [clientId, req.userEmail];

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

      dataQuery += ' ORDER BY date DESC';

      // Check count first
      db.get(countQuery, params, (err, result) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        if (result.count > 10000) {
          return res.status(400).json({
            error: 'Too many entries (' + result.count + '). Please filter by date range using startDate and endDate query parameters.'
          });
        }

        // Get work entries
        db.all(dataQuery, params, (err, workEntries) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }
          
          // Create PDF
          const doc = new PDFDocument();
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${client.name.replace(/[^a-zA-Z0-9]/g, '_')}_report_${timestamp}.pdf`;
          
          // Set response headers
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          
          // Pipe PDF to response
          doc.pipe(res);
          
          // Add content to PDF
          doc.fontSize(20).text(`Time Report for ${client.name}`, { align: 'center' });
          doc.moveDown();
          
          const totalHours = workEntries.reduce((sum, entry) => sum + parseFloat(entry.hours), 0);
          doc.fontSize(14).text(`Total Hours: ${totalHours.toFixed(2)}`);
          doc.text(`Total Entries: ${workEntries.length}`);
          doc.text(`Generated: ${new Date().toLocaleString()}`);
          doc.moveDown();
          
          // Add table header
          doc.fontSize(12).text('Date', 50, doc.y, { width: 100 });
          doc.text('Hours', 150, doc.y - 15, { width: 80 });
          doc.text('Description', 230, doc.y - 15, { width: 300 });
          doc.moveDown();
          
          // Add horizontal line
          doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
          doc.moveDown(0.5);
          
          // Add work entries
          workEntries.forEach((entry, index) => {
            const y = doc.y;
            
            // Check if we need a new page
            if (y > 700) {
              doc.addPage();
            }
            
            doc.text(entry.date, 50, doc.y, { width: 100 });
            doc.text(entry.hours.toString(), 150, y, { width: 80 });
            doc.text(entry.description || 'No description', 230, y, { width: 300 });
            doc.moveDown();
            
            // Add separator line every 5 entries
            if ((index + 1) % 5 === 0) {
              doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
              doc.moveDown(0.5);
            }
          });
          
          // Finalize PDF
          doc.end();
        });
      });
    }
  );
});

module.exports = router;
