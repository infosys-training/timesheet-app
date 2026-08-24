const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const {
  workEntrySchema,
  updateWorkEntrySchema,
  rejectWorkEntrySchema
} = require('../validation/schemas');

const router = express.Router();
const statuses = ['draft', 'submitted', 'approved', 'rejected'];
const entryFields = `we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
                     we.status, we.submitted_at, we.reviewed_at, we.reviewed_by,
                     we.rejection_reason, we.created_at, we.updated_at, c.name as client_name`;

function invalidTransition(res, status, action, allowed) {
  return res.status(409).json({
    error: `Cannot ${action} work entry in ${status} status; allowed from: ${allowed.join(', ')}`
  });
}

function sendUpdatedEntry(db, res, id, message, statusCode = 200) {
  db.get(
    `SELECT ${entryFields}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Work entry updated but failed to retrieve' });
      }
      res.status(statusCode).json({ message, workEntry: row });
    }
  );
}

// All routes require authentication
router.use(authenticateUser);

// Approvers see submitted entries across users, excluding their own.
// This route must be registered before /:id.
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();
  db.all(
    `SELECT ${entryFields}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = 'submitted' AND we.user_email <> ?
     ORDER BY we.date DESC, we.created_at DESC`,
    [req.userEmail],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json({ workEntries: rows });
    }
  );
});

// Get all work entries for authenticated user (with optional client/status filters)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  
  let query = `
    SELECT ${entryFields}
    FROM work_entries we
    JOIN clients c ON we.client_id = c.id
    WHERE we.user_email = ?
  `;
  
  const params = [req.userEmail];
  
  if (clientId) {
    const clientIdNum = parseInt(clientId);
    if (isNaN(clientIdNum)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
  }

  if (status) {
    if (!statuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid work entry status' });
    }
    query += ' AND we.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY we.date DESC, we.created_at DESC';
  
  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    
    res.json({ workEntries: rows });
  });
});

// Get specific work entry
router.get('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    `SELECT ${entryFields}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ? AND we.user_email = ?`,
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      
      res.json({ workEntry: row });
    }
  );
});

// Create new work entry
router.post('/', (req, res, next) => {
  try {
    const { error, value } = workEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    const { clientId, hours, description, date } = value;
    const db = getDatabase();

    // Verify client exists and belongs to user
    db.get(
      'SELECT id FROM clients WHERE id = ? AND user_email = ?',
      [clientId, req.userEmail],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!row) {
          return res.status(400).json({ error: 'Client not found or does not belong to user' });
        }

        // Create work entry
        db.run(
          'INSERT INTO work_entries (client_id, user_email, hours, description, date) VALUES (?, ?, ?, ?, ?)',
          [clientId, req.userEmail, hours, description || null, date],
          function(err) {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: 'Failed to create work entry' });
            }

            // Return the created work entry with client name
            db.get(
              `SELECT ${entryFields}
               FROM work_entries we
               JOIN clients c ON we.client_id = c.id
               WHERE we.id = ?`,
              [this.lastID],
              (err, row) => {
                if (err) {
                  console.error('Database error:', err);
                  return res.status(500).json({ error: 'Work entry created but failed to retrieve' });
                }

                res.status(201).json({
                  message: 'Work entry created successfully',
                  workEntry: row
                });
              }
            );
          }
        );
      }
    );
  } catch (error) {
    next(error);
  }
});

// Submit an owned draft or rejected work entry.
router.post('/:id/submit', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  db.get(
    'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      if (!['draft', 'rejected'].includes(row.status)) {
        return invalidTransition(res, row.status, 'submit', ['draft', 'rejected']);
      }

      db.run(
        `UPDATE work_entries
         SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
             reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_email = ?`,
        [workEntryId, req.userEmail],
        (updateError) => {
          if (updateError) {
            console.error('Database error:', updateError);
            return res.status(500).json({ error: 'Failed to submit work entry' });
          }
          sendUpdatedEntry(db, res, workEntryId, 'Work entry submitted successfully');
        }
      );
    }
  );
});

function reviewEntry(req, res, action, body = req.body) {
  const workEntryId = parseInt(req.params.id);
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  db.get(
    'SELECT id, user_email, status FROM work_entries WHERE id = ?',
    [workEntryId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      if (row.user_email === req.userEmail) {
        return res.status(403).json({ error: `Approvers cannot ${action} their own work entry` });
      }
      if (row.status !== 'submitted') {
        return invalidTransition(res, row.status, action, ['submitted']);
      }

      const reason = action === 'reject' ? (body.reason || null) : null;
      const query = action === 'approve'
        ? `UPDATE work_entries
           SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP,
               reviewed_by = ?, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'submitted'`
        : `UPDATE work_entries
           SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP,
               reviewed_by = ?, rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'submitted'`;
      const params = action === 'approve'
        ? [req.userEmail, workEntryId]
        : [req.userEmail, reason, workEntryId];

      db.run(query, params, (updateError) => {
        if (updateError) {
          console.error('Database error:', updateError);
          return res.status(500).json({ error: `Failed to ${action} work entry` });
        }
        const message = action === 'approve'
          ? 'Work entry approved successfully'
          : 'Work entry rejected successfully';
        sendUpdatedEntry(db, res, workEntryId, message);
      });
    }
  );
}

router.post('/:id/approve', requireApprover, (req, res) => reviewEntry(req, res, 'approve'));

router.post('/:id/reject', requireApprover, (req, res, next) => {
  const { error, value } = rejectWorkEntrySchema.validate(req.body);
  if (error) {
    return next(error);
  }
  reviewEntry(req, res, 'reject', value);
});

// Update work entry
router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = parseInt(req.params.id);
    
    if (isNaN(workEntryId)) {
      return res.status(400).json({ error: 'Invalid work entry ID' });
    }

    const { error, value } = updateWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    const db = getDatabase();

    // Check if work entry exists and belongs to user
    db.get(
      'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
      [workEntryId, req.userEmail],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!row) {
          return res.status(404).json({ error: 'Work entry not found' });
        }
        if (row.status === 'approved') {
          return invalidTransition(res, row.status, 'update', ['draft', 'submitted', 'rejected']);
        }

        // If clientId is being updated, verify it belongs to user
        if (value.clientId) {
          db.get(
            'SELECT id FROM clients WHERE id = ? AND user_email = ?',
            [value.clientId, req.userEmail],
            (err, clientRow) => {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Internal server error' });
              }

              if (!clientRow) {
                return res.status(400).json({ error: 'Client not found or does not belong to user' });
              }

              performUpdate();
            }
          );
        } else {
          performUpdate();
        }

        function performUpdate() {
          // Build update query dynamically
          const updates = [];
          const values = [];

          if (value.clientId !== undefined) {
            updates.push('client_id = ?');
            values.push(value.clientId);
          }

          if (value.hours !== undefined) {
            updates.push('hours = ?');
            values.push(value.hours);
          }

          if (value.description !== undefined) {
            updates.push('description = ?');
            values.push(value.description || null);
          }

          if (value.date !== undefined) {
            updates.push('date = ?');
            values.push(value.date);
          }

          if (row.status === 'submitted') {
            updates.push('status = ?');
            values.push('draft');
            updates.push('submitted_at = NULL');
          }

          updates.push('updated_at = CURRENT_TIMESTAMP');
          values.push(workEntryId, req.userEmail);

          const query = `UPDATE work_entries SET ${updates.join(', ')} WHERE id = ? AND user_email = ?`;

          db.run(query, values, function(err) {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: 'Failed to update work entry' });
            }

            // Return updated work entry with client name
            db.get(
              `SELECT ${entryFields}
               FROM work_entries we
               JOIN clients c ON we.client_id = c.id
               WHERE we.id = ?`,
              [workEntryId],
              (err, row) => {
                if (err) {
                  console.error('Database error:', err);
                  return res.status(500).json({ error: 'Work entry updated but failed to retrieve' });
                }

                res.json({
                  message: 'Work entry updated successfully',
                  workEntry: row
                });
              }
            );
          });
        }
      }
    );
  } catch (error) {
    next(error);
  }
});

// Delete work entry
router.delete('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  // Check if work entry exists and belongs to user
  db.get(
    'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }
      if (row.status === 'approved') {
        return invalidTransition(res, row.status, 'delete', ['draft', 'submitted', 'rejected']);
      }
      
      // Delete work entry
      db.run(
        'DELETE FROM work_entries WHERE id = ? AND user_email = ?',
        [workEntryId, req.userEmail],
        function(err) {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to delete work entry' });
          }
          
          res.json({ message: 'Work entry deleted successfully' });
        }
      );
    }
  );
});

module.exports = router;
