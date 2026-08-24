const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, rejectWorkEntrySchema, workEntryStatusSchema } = require('../validation/schemas');

const router = express.Router();

const workEntryProjection = `
  we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
  we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.rejection_reason,
  we.created_at, we.updated_at, c.name as client_name
`;

function parsePositiveIntParam(id) {
  const parsedId = parseInt(id, 10);
  return Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
}

function transitionError(action, status) {
  return `Cannot ${action} a work entry with status ${status}`;
}

// All routes require authentication
router.use(authenticateUser);

// Get submitted work entries for approvers. Keep this before /:id.
router.get('/pending-approvals', (req, res) => {
  if (!req.isApprover) {
    return res.status(403).json({ error: 'Approver access required' });
  }

  const db = getDatabase();
  db.all(
    `SELECT ${workEntryProjection}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = 'submitted'
     ORDER BY we.date DESC`,
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

// Get all work entries for authenticated user (with optional client and status filters)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  
  let query = `
    SELECT ${workEntryProjection}
    FROM work_entries we
    JOIN clients c ON we.client_id = c.id
    WHERE we.user_email = ?
  `;
  
  const params = [req.userEmail];
  
  if (clientId) {
    const clientIdNum = parsePositiveIntParam(clientId);
    if (clientIdNum === null) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
  }
  
  if (status !== undefined) {
    const { error } = workEntryStatusSchema.validate(status);
    if (error) {
      return res.status(400).json({ error: 'Invalid status' });
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
  const workEntryId = parsePositiveIntParam(req.params.id);
  
  if (workEntryId === null) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    `SELECT ${workEntryProjection}
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
              `SELECT ${workEntryProjection}
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

// Submit a draft or rejected work entry
router.post('/:id/submit', (req, res) => {
  const workEntryId = parsePositiveIntParam(req.params.id);
  if (workEntryId === null) {
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

      const status = row.status || 'draft';
      if (status !== 'draft' && status !== 'rejected') {
        return res.status(409).json({ error: transitionError('submit', status) });
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

          db.get(
            `SELECT ${workEntryProjection}
             FROM work_entries we
             JOIN clients c ON we.client_id = c.id
             WHERE we.id = ?`,
            [workEntryId],
            (err, row) => {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Work entry submitted but failed to retrieve' });
              }

              res.json({
                message: 'Work entry submitted successfully',
                workEntry: row
              });
            }
          );
        }
      );
    }
  );
});

function reviewWorkEntry(req, res, action, reason) {
  const workEntryId = parsePositiveIntParam(req.params.id);
  if (workEntryId === null) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  if (!req.isApprover) {
    return res.status(403).json({ error: 'Approver access required' });
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
        return res.status(403).json({ error: 'Approvers cannot review their own work entries' });
      }

      const status = row.status || 'draft';
      if (status !== 'submitted') {
        return res.status(409).json({ error: transitionError(action, status) });
      }

      const query = action === 'approve'
        ? `UPDATE work_entries
           SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP,
               reviewed_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'submitted'`
        : `UPDATE work_entries
           SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP,
               reviewed_by = ?, rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'submitted'`;
      const params = action === 'approve'
        ? [req.userEmail, workEntryId]
        : [req.userEmail, reason, workEntryId];

      db.run(query, params, (updateErr) => {
        if (updateErr) {
          console.error('Database error:', updateErr);
          return res.status(500).json({ error: `Failed to ${action} work entry` });
        }
        db.get(
          `SELECT ${workEntryProjection}
           FROM work_entries we
           JOIN clients c ON we.client_id = c.id
           WHERE we.id = ?`,
          [workEntryId],
          (err, updatedEntry) => {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: `Work entry ${action === 'approve' ? 'approved' : 'rejected'} but failed to retrieve` });
            }

            res.json({
              message: `Work entry ${action === 'approve' ? 'approved' : 'rejected'} successfully`,
              workEntry: updatedEntry
            });
          }
        );
      });
    }
  );
}

router.post('/:id/approve', (req, res) => reviewWorkEntry(req, res, 'approve'));

router.post('/:id/reject', (req, res, next) => {
  try {
    const { error, value } = rejectWorkEntrySchema.validate(req.body || {});
    if (error) {
      return next(error);
    }
    return reviewWorkEntry(req, res, 'reject', value.reason || null);
  } catch (error) {
    next(error);
  }
});

// Update work entry
router.put('/:id', (req, res, next) => {
  try {
    const workEntryId = parsePositiveIntParam(req.params.id);
    
    if (workEntryId === null) {
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

        const status = row.status || 'draft';
        if (status === 'approved') {
          return res.status(409).json({ error: transitionError('edit', status) });
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
              `SELECT ${workEntryProjection}
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
  const workEntryId = parsePositiveIntParam(req.params.id);
  
  if (workEntryId === null) {
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

      const status = row.status || 'draft';
      if (status === 'approved') {
        return res.status(409).json({ error: transitionError('delete', status) });
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
