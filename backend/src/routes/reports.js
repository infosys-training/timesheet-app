const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser } = require('../middleware/auth');
const { EFFORT_CATEGORIES } = require('../validation/schemas');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// All routes require authentication
router.use(authenticateUser);

// Get effort breakdown by category for the authenticated user
router.get('/effort-breakdown', (req, res) => {
  const db = getDatabase();

  db.all(
    `SELECT effort_category, SUM(hours) as total_hours, COUNT(*) as entry_count
     FROM work_entries
     WHERE user_email = ?
     GROUP BY effort_category
     ORDER BY total_hours DESC`,
    [req.userEmail],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      const breakdown = EFFORT_CATEGORIES.map((category) => {
        const row = rows.find((r) => r.effort_category === category);
        return {
          category,
          totalHours: row ? parseFloat(row.total_hours) : 0,
          entryCount: row ? row.entry_count : 0,
        };
      });

      const grandTotalHours = breakdown.reduce((sum, item) => sum + item.totalHours, 0);

      res.json({
        breakdown,
        grandTotalHours,
        categories: EFFORT_CATEGORIES,
      });
    }
  );
});

// Get hourly report for specific client
router.get('/client/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }
  
  const db = getDatabase();
  
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
      
      // Get work entries for this client
      db.all(
        `SELECT id, hours, description, date, created_at, updated_at
         FROM work_entries 
         WHERE client_id = ? AND user_email = ? 
         ORDER BY date DESC`,
        [clientId, req.userEmail],
        (err, workEntries) => {
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
            entryCount: workEntries.length
          });
        }
      );
    }
  );
});

// Export client report as CSV
router.get('/export/csv/:clientId', (req, res) => {
  const clientId = parseInt(req.params.clientId);
  
  if (isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client ID' });
  }
  
  const db = getDatabase();
  
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
      
      // Get work entries
      db.all(
        `SELECT hours, description, date, created_at
         FROM work_entries 
         WHERE client_id = ? AND user_email = ? 
         ORDER BY date DESC`,
        [clientId, req.userEmail],
        (err, workEntries) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }
          
          // Create temporary CSV file
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${client.name.replace(/[^a-zA-Z0-9]/g, '_')}_report_${timestamp}.csv`;
          const tempPath = path.join(__dirname, '../../temp', filename);
          
          // Ensure temp directory exists
          const tempDir = path.dirname(tempPath);
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }
          
          const csvWriter = createCsvWriter({
            path: tempPath,
            header: [
              { id: 'date', title: 'Date' },
              { id: 'hours', title: 'Hours' },
              { id: 'description', title: 'Description' },
              { id: 'created_at', title: 'Created At' }
            ]
          });
          
          csvWriter.writeRecords(workEntries)
            .then(() => {
              // Send file and clean up
              res.download(tempPath, filename, (err) => {
                if (err) {
                  console.error('Error sending file:', err);
                }
                // Clean up temp file
                fs.unlink(tempPath, (unlinkErr) => {
                  if (unlinkErr) {
                    console.error('Error deleting temp file:', unlinkErr);
                  }
                });
              });
            })
            .catch((error) => {
              console.error('Error creating CSV:', error);
              res.status(500).json({ error: 'Failed to generate CSV report' });
            });
        }
      );
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
      
      // Get work entries
      db.all(
        `SELECT hours, description, date, created_at
         FROM work_entries 
         WHERE client_id = ? AND user_email = ? 
         ORDER BY date DESC`,
        [clientId, req.userEmail],
        (err, workEntries) => {
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
        }
      );
    }
  );
});

// Export dashboard as CSV
router.get('/export/dashboard/csv', (req, res) => {
  const db = getDatabase();

  // Get summary stats
  db.get(
    'SELECT COUNT(*) as client_count FROM clients WHERE user_email = ?',
    [req.userEmail],
    (err, clientRow) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      db.all(
        `SELECT effort_category, SUM(hours) as total_hours, COUNT(*) as entry_count
         FROM work_entries
         WHERE user_email = ?
         GROUP BY effort_category
         ORDER BY total_hours DESC`,
        [req.userEmail],
        (err, rows) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          const breakdown = EFFORT_CATEGORIES.map((category) => {
            const row = rows.find((r) => r.effort_category === category);
            return {
              category,
              total_hours: row ? parseFloat(row.total_hours).toFixed(2) : '0.00',
              entry_count: row ? row.entry_count : 0,
            };
          });

          const grandTotalHours = rows.reduce((sum, r) => sum + parseFloat(r.total_hours), 0);

          // Add percentage
          const records = breakdown.map((item) => ({
            ...item,
            percentage: grandTotalHours > 0
              ? ((parseFloat(item.total_hours) / grandTotalHours) * 100).toFixed(1) + '%'
              : '0.0%',
          }));

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `dashboard_report_${timestamp}.csv`;
          const tempPath = path.join(__dirname, '../../temp', filename);

          const tempDir = path.dirname(tempPath);
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          const csvWriter = createCsvWriter({
            path: tempPath,
            header: [
              { id: 'category', title: 'Category' },
              { id: 'total_hours', title: 'Total Hours' },
              { id: 'entry_count', title: 'Entry Count' },
              { id: 'percentage', title: 'Percentage' },
            ],
          });

          csvWriter.writeRecords(records)
            .then(() => {
              res.download(tempPath, filename, (err) => {
                if (err) {
                  console.error('Error sending file:', err);
                }
                fs.unlink(tempPath, (unlinkErr) => {
                  if (unlinkErr) {
                    console.error('Error deleting temp file:', unlinkErr);
                  }
                });
              });
            })
            .catch((error) => {
              console.error('Error creating CSV:', error);
              res.status(500).json({ error: 'Failed to generate dashboard CSV report' });
            });
        }
      );
    }
  );
});

// Export dashboard as PDF
router.get('/export/dashboard/pdf', (req, res) => {
  const db = getDatabase();

  db.get(
    'SELECT COUNT(*) as client_count FROM clients WHERE user_email = ?',
    [req.userEmail],
    (err, clientRow) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      db.get(
        'SELECT COUNT(*) as entry_count, COALESCE(SUM(hours), 0) as total_hours FROM work_entries WHERE user_email = ?',
        [req.userEmail],
        (err, entryRow) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          db.all(
            `SELECT effort_category, SUM(hours) as total_hours, COUNT(*) as entry_count
             FROM work_entries
             WHERE user_email = ?
             GROUP BY effort_category
             ORDER BY total_hours DESC`,
            [req.userEmail],
            (err, rows) => {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Internal server error' });
              }

              const grandTotalHours = rows.reduce((sum, r) => sum + parseFloat(r.total_hours), 0);

              const doc = new PDFDocument();
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const filename = `dashboard_report_${timestamp}.pdf`;

              res.setHeader('Content-Type', 'application/pdf');
              res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

              doc.pipe(res);

              // Title
              doc.fontSize(20).text('Dashboard Report', { align: 'center' });
              doc.moveDown();
              doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
              doc.moveDown(2);

              // Summary Stats
              doc.fontSize(16).text('Summary', { underline: true });
              doc.moveDown(0.5);
              doc.fontSize(12).text(`Total Clients: ${clientRow.client_count}`);
              doc.text(`Total Work Entries: ${entryRow.entry_count}`);
              doc.text(`Total Hours: ${parseFloat(entryRow.total_hours).toFixed(2)}`);
              doc.moveDown(2);

              // Effort Breakdown
              doc.fontSize(16).text('Effort Breakdown', { underline: true });
              doc.moveDown();

              // Table header
              doc.fontSize(11);
              const startX = 50;
              doc.text('Category', startX, doc.y, { width: 160 });
              doc.text('Hours', startX + 160, doc.y - 15, { width: 80 });
              doc.text('Entries', startX + 240, doc.y - 15, { width: 80 });
              doc.text('Percentage', startX + 320, doc.y - 15, { width: 100 });
              doc.moveDown();

              doc.moveTo(startX, doc.y).lineTo(startX + 420, doc.y).stroke();
              doc.moveDown(0.5);

              // Category rows
              EFFORT_CATEGORIES.forEach((category) => {
                const row = rows.find((r) => r.effort_category === category);
                const hours = row ? parseFloat(row.total_hours).toFixed(2) : '0.00';
                const count = row ? row.entry_count : 0;
                const pct = grandTotalHours > 0
                  ? ((row ? parseFloat(row.total_hours) : 0) / grandTotalHours * 100).toFixed(1) + '%'
                  : '0.0%';

                const y = doc.y;
                doc.text(category, startX, y, { width: 160 });
                doc.text(hours, startX + 160, y, { width: 80 });
                doc.text(count.toString(), startX + 240, y, { width: 80 });
                doc.text(pct, startX + 320, y, { width: 100 });
                doc.moveDown();
              });

              // Total row
              doc.moveDown(0.5);
              doc.moveTo(startX, doc.y).lineTo(startX + 420, doc.y).stroke();
              doc.moveDown(0.5);
              const totalY = doc.y;
              doc.font('Helvetica-Bold');
              doc.text('Total', startX, totalY, { width: 160 });
              doc.text(grandTotalHours.toFixed(2), startX + 160, totalY, { width: 80 });
              doc.text(entryRow.entry_count.toString(), startX + 240, totalY, { width: 80 });
              doc.text('100%', startX + 320, totalY, { width: 100 });
              doc.font('Helvetica');

              doc.end();
            }
          );
        }
      );
    }
  );
});

module.exports = router;
