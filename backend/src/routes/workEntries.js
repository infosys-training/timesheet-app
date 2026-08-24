const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, rejectWorkEntrySchema } = require('../validation/schemas');

const router = express.Router();

// All routes require authentication
router.use(authenticateUser);

const entryFields = `
  we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
  we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.rejection_reason,
  we.created_at, we.updated_at, c.name as client_name
`;

const entrySelect = `SELECT ${entryFields}
  FROM work_entries we
  JOIN clients c ON we.client_id = c.id`;

function parseEntryId(value, res) {
  const id = parseInt(value);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid work entry ID' });
    return null;
  }
  return id;
}

function validateEntryId(req, res, next) {
  if (parseEntryId(req.params.id, res) !== null) next();
}

function sendUpdatedEntry(db, id, res, message, retrievalError) {
  db.get(`${entrySelect} WHERE we.id = ?`, [id], (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: retrievalError });
    }
    res.json({ message, workEntry: row });
  });
}

// This route must be declared before /:id.
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();
  db.all(
    `${entrySelect} WHERE we.status = 'submitted' ORDER BY we.submitted_at ASC, we.created_at ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      res.json({ workEntries: rows });
    }
  );
});

// Get all work entries for authenticated user (with optional client filter)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  
  let query = `
    SELECT we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
           we.status, we.submitted_at, we.reviewed_at, we.reviewed_by,
           we.rejection_reason, we.created_at, we.updated_at, c.name as client_name
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
    if (!['draft', 'submitted', 'approved', 'rejected'].includes(status)) {
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
  const workEntryId = parseEntryId(req.params.id, res);
  if (workEntryId === null) return;
  
  const db = getDatabase();
  
  db.get(
    `${entrySelect}
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
              `${entrySelect} WHERE we.id = ?`,
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

// Update work entry
router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = parseEntryId(req.params.id, res);
    if (workEntryId === null) return;

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

        if (row.status === 'submitted' || row.status === 'approved') {
          return res.status(409).json({
            error: `Work entry cannot be edited while it is ${row.status}`
          });
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

          updates.push('updated_at = CURRENT_TIMESTAMP');
          values.push(workEntryId, req.userEmail);

          const query = `UPDATE work_entries SET ${updates.join(', ')} WHERE id = ? AND user_email = ?`;

          db.run(query, values, function(err) {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: 'Failed to update work entry' });
            }

            sendUpdatedEntry(
              db,
              workEntryId,
              res,
              'Work entry updated successfully',
              'Work entry updated but failed to retrieve'
            );
          });
        }
      }
    );
  } catch (error) {
    next(error);
  }
});

function transitionError(action, status, res) {
  return res.status(409).json({
    error: `Cannot ${action} work entry while it is ${status}`
  });
}

router.post('/:id/submit', (req, res) => {
  const workEntryId = parseEntryId(req.params.id, res);
  if (workEntryId === null) return;
  const db = getDatabase();

  db.get(
    'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?',
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) return res.status(404).json({ error: 'Work entry not found' });
      if (!['draft', 'rejected'].includes(row.status)) {
        return transitionError('submit', row.status, res);
      }
      db.run(
        `UPDATE work_entries
         SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
             reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_email = ?`,
        [workEntryId, req.userEmail],
        (updateErr) => {
          if (updateErr) {
            console.error('Database error:', updateErr);
            return res.status(500).json({ error: 'Failed to submit work entry' });
          }
          sendUpdatedEntry(
            db,
            workEntryId,
            res,
            'Work entry submitted successfully',
            'Work entry submitted but failed to retrieve'
          );
        }
      );
    }
  );
});

function reviewEntry(action, req, res, next) {
  const workEntryId = parseEntryId(req.params.id, res);
  if (workEntryId === null) return;
  const db = getDatabase();

  db.get(
    `${entrySelect} WHERE we.id = ?`,
    [workEntryId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!row) return res.status(404).json({ error: 'Work entry not found' });
      if (row.user_email === req.userEmail) {
        return res.status(403).json({ error: 'Approvers cannot review their own work entries' });
      }
      if (row.status !== 'submitted') return transitionError(action, row.status, res);

      let reason;
      if (action === 'reject') {
        const validation = rejectWorkEntrySchema.validate(req.body);
        if (validation.error) return next(validation.error);
        reason = validation.value.reason || null;
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      db.run(
        `UPDATE work_entries
         SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
             rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'submitted'`,
        [status, req.userEmail, reason || null, workEntryId],
        (updateErr) => {
          if (updateErr) {
            console.error('Database error:', updateErr);
            return res.status(500).json({ error: `Failed to ${action} work entry` });
          }
          const resultMessage = action === 'approve'
            ? 'Work entry approved successfully'
            : 'Work entry rejected successfully';
          sendUpdatedEntry(
            db,
            workEntryId,
            res,
            resultMessage,
            action === 'approve'
              ? 'Work entry approved but failed to retrieve'
              : 'Work entry rejected but failed to retrieve'
          );
        }
      );
    }
  );
}

router.post('/:id/approve', validateEntryId, requireApprover, (req, res, next) => {
  reviewEntry('approve', req, res, next);
});

router.post('/:id/reject', validateEntryId, requireApprover, (req, res, next) => {
  reviewEntry('reject', req, res, next);
});

// Delete work entry
router.delete('/:id', (req, res) => {
  const workEntryId = parseEntryId(req.params.id, res);
  if (workEntryId === null) return;
  
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

      if (row.status === 'submitted' || row.status === 'approved') {
        return res.status(409).json({
          error: `Work entry cannot be deleted while it is ${row.status}`
        });
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
