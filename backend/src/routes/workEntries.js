const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const {
  workEntrySchema,
  updateWorkEntrySchema,
  rejectWorkEntrySchema
} = require('../validation/schemas');

const router = express.Router();
const VALID_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];
const workEntrySelect = `
  SELECT we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
         we.status, we.submitted_at, we.reviewed_at, we.reviewed_by,
         we.rejection_reason, we.created_at, we.updated_at, c.name as client_name
  FROM work_entries we
  JOIN clients c ON we.client_id = c.id
`;

// All routes require authentication
router.use(authenticateUser);

function transitionError(res, action, status) {
  return res.status(409).json({
    error: `Cannot ${action} work entry from ${status} status`
  });
}

function getWorkEntryId(req, res) {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    res.status(400).json({ error: 'Invalid work entry ID' });
    return null;
  }

  return workEntryId;
}

function getOwnedWorkEntry(req, res, workEntryId, callback) {
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

      callback(db, row);
    }
  );
}

// Get pending work entries for approvers
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();

  db.all(
    `${workEntrySelect}
     WHERE we.status = 'submitted'
     ORDER BY we.date DESC, we.created_at DESC`,
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
  
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  let query = `${workEntrySelect} WHERE we.user_email = ?`;
  const params = [req.userEmail];
  
  if (clientId) {
    const clientIdNum = parseInt(clientId);
    if (isNaN(clientIdNum)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
  }

  if (status !== undefined) {
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
  const workEntryId = getWorkEntryId(req, res);
  if (workEntryId === null) return;
  
  const db = getDatabase();
  
  db.get(
    `${workEntrySelect} WHERE we.id = ? AND we.user_email = ?`,
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
              `${workEntrySelect} WHERE we.id = ?`,
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

// Submit work entry for approval
router.post('/:id/submit', (req, res) => {
  const workEntryId = getWorkEntryId(req, res);
  if (workEntryId === null) return;

  getOwnedWorkEntry(req, res, workEntryId, (db, row) => {
    if (row.status !== 'draft' && row.status !== 'rejected') {
      return transitionError(res, 'submit', row.status);
    }

    db.run(
        `UPDATE work_entries
         SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
             rejection_reason = NULL, reviewed_at = NULL, reviewed_by = NULL
         WHERE id = ? AND user_email = ?`,
        [workEntryId, req.userEmail],
        (err) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to submit work entry' });
          }

          db.get(
            `${workEntrySelect} WHERE we.id = ?`,
            [workEntryId],
            (err, workEntry) => {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Work entry submitted but failed to retrieve' });
              }

              res.json({
                message: 'Work entry submitted successfully',
                workEntry
              });
            }
          );
        }
    );
  });
});

function reviewWorkEntry(req, res, action, rejectionReason) {
  const workEntryId = getWorkEntryId(req, res);
  if (workEntryId === null) return;

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
        return res.status(403).json({
          error: `Cannot ${action} your own work entry`
        });
      }

      if (row.status !== 'submitted') {
        return transitionError(res, action, row.status);
      }

      const status = action === 'approve' ? 'approved' : 'rejected';
      const reason = action === 'reject' ? rejectionReason : null;
      db.run(
        `UPDATE work_entries
         SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
             rejection_reason = ?
         WHERE id = ?`,
        [status, req.userEmail, reason, workEntryId],
        (err) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: `Failed to ${action} work entry` });
          }

          db.get(
            `${workEntrySelect} WHERE we.id = ?`,
            [workEntryId],
            (err, workEntry) => {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({
                  error: `Work entry ${action}d but failed to retrieve`
                });
              }

              res.json({
                message: `Work entry ${action}d successfully`,
                workEntry
              });
            }
          );
        }
      );
    }
  );
}

// Approve a submitted work entry
router.post('/:id/approve', requireApprover, (req, res) => {
  reviewWorkEntry(req, res, 'approve', null);
});

// Reject a submitted work entry
router.post('/:id/reject', requireApprover, (req, res, next) => {
  try {
    const { error, value } = rejectWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    reviewWorkEntry(req, res, 'reject', value.reason === undefined ? null : value.reason);
  } catch (error) {
    next(error);
  }
});

// Update work entry
router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = getWorkEntryId(req, res);
    if (workEntryId === null) return;

    const { error, value } = updateWorkEntrySchema.validate(req.body);
    if (error) {
      return next(error);
    }

    // Check if work entry exists and belongs to user
    getOwnedWorkEntry(req, res, workEntryId, (db, row) => {
      if (row.status === 'submitted' || row.status === 'approved') {
        return res.status(409).json({
          error: `Work entry cannot be edited while status is ${row.status}`
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

            // Return updated work entry with client name
            db.get(
              `${workEntrySelect} WHERE we.id = ?`,
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
    });
  } catch (error) {
    next(error);
  }
});

// Delete work entry
router.delete('/:id', (req, res) => {
  const workEntryId = getWorkEntryId(req, res);
  if (workEntryId === null) return;
  
  // Check if work entry exists and belongs to user
  getOwnedWorkEntry(req, res, workEntryId, (db, row) => {
    if (row.status === 'submitted' || row.status === 'approved') {
      return res.status(409).json({
        error: `Work entry cannot be deleted while status is ${row.status}`
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
  });
});

module.exports = router;
