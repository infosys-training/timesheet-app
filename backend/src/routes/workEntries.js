const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const {
  workEntrySchema,
  updateWorkEntrySchema,
  rejectWorkEntrySchema
} = require('../validation/schemas');

const router = express.Router();

const WORK_ENTRY_COLUMNS = `
  we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
  we.status, we.submitted_at, we.reviewed_at, we.reviewed_by,
  we.rejection_reason, we.created_at, we.updated_at, c.name as client_name
`;

function getWorkEntry(db, id, callback) {
  db.get(
    `SELECT ${WORK_ENTRY_COLUMNS}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ?`,
    [id],
    callback
  );
}

function getWorkEntryForUser(db, id, userEmail, callback) {
  db.get(
    `SELECT ${WORK_ENTRY_COLUMNS}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ? AND we.user_email = ?`,
    [id, userEmail],
    callback
  );
}

// All routes require authentication
router.use(authenticateUser);

// Get all pending work entries for approvers. This must be before /:id.
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();

  db.all(
    `SELECT ${WORK_ENTRY_COLUMNS}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
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

// Get all work entries for authenticated user (with optional client/status filters)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  const validStatuses = ['draft', 'submitted', 'approved', 'rejected'];

  let query = `
    SELECT ${WORK_ENTRY_COLUMNS}
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
    if (!validStatuses.includes(status)) {
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
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();

  getWorkEntryForUser(db, workEntryId, req.userEmail, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Work entry not found' });
    }

    res.json({ workEntry: row });
  });
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

        db.run(
          'INSERT INTO work_entries (client_id, user_email, hours, description, date) VALUES (?, ?, ?, ?, ?)',
          [clientId, req.userEmail, hours, description || null, date],
          function(insertErr) {
            if (insertErr) {
              console.error('Database error:', insertErr);
              return res.status(500).json({ error: 'Failed to create work entry' });
            }

            getWorkEntry(db, this.lastID, (retrieveErr, createdEntry) => {
              if (retrieveErr) {
                console.error('Database error:', retrieveErr);
                return res.status(500).json({ error: 'Work entry created but failed to retrieve' });
              }

              res.status(201).json({
                message: 'Work entry created successfully',
                workEntry: createdEntry
              });
            });
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
        return res.status(409).json({ error: `Cannot submit a ${row.status} work entry` });
      }

      db.run(
        `UPDATE work_entries
         SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
             rejection_reason = NULL, reviewed_at = NULL, reviewed_by = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_email = ?`,
        [workEntryId, req.userEmail],
        (updateErr) => {
          if (updateErr) {
            console.error('Database error:', updateErr);
            return res.status(500).json({ error: 'Failed to submit work entry' });
          }

          getWorkEntryForUser(db, workEntryId, req.userEmail, (retrieveErr, entry) => {
            if (retrieveErr) {
              console.error('Database error:', retrieveErr);
              return res.status(500).json({ error: 'Work entry submitted but failed to retrieve' });
            }

            res.json({ message: 'Work entry submitted successfully', workEntry: entry });
          });
        }
      );
    }
  );
});

// Approve a submitted work entry
router.post('/:id/approve', requireApprover, (req, res) => {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();

  db.get(
    'SELECT id, status FROM work_entries WHERE id = ?',
    [workEntryId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }

      if (row.status !== 'submitted') {
        return res.status(409).json({ error: `Cannot approve a ${row.status} work entry` });
      }

      db.run(
        `UPDATE work_entries
         SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = ?, rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [req.userEmail, workEntryId],
        (updateErr) => {
          if (updateErr) {
            console.error('Database error:', updateErr);
            return res.status(500).json({ error: 'Failed to approve work entry' });
          }

          getWorkEntry(db, workEntryId, (retrieveErr, entry) => {
            if (retrieveErr) {
              console.error('Database error:', retrieveErr);
              return res.status(500).json({ error: 'Work entry approved but failed to retrieve' });
            }

            res.json({ message: 'Work entry approved successfully', workEntry: entry });
          });
        }
      );
    }
  );
});

// Reject a submitted work entry
router.post('/:id/reject', requireApprover, (req, res, next) => {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const { error, value } = rejectWorkEntrySchema.validate(req.body);
  if (error) {
    return next(error);
  }

  const db = getDatabase();

  db.get(
    'SELECT id, status FROM work_entries WHERE id = ?',
    [workEntryId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }

      if (row.status !== 'submitted') {
        return res.status(409).json({ error: `Cannot reject a ${row.status} work entry` });
      }

      db.run(
        `UPDATE work_entries
         SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP,
             reviewed_by = ?, rejection_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [req.userEmail, value.reason || null, workEntryId],
        (updateErr) => {
          if (updateErr) {
            console.error('Database error:', updateErr);
            return res.status(500).json({ error: 'Failed to reject work entry' });
          }

          getWorkEntry(db, workEntryId, (retrieveErr, entry) => {
            if (retrieveErr) {
              console.error('Database error:', retrieveErr);
              return res.status(500).json({ error: 'Work entry rejected but failed to retrieve' });
            }

            res.json({ message: 'Work entry rejected successfully', workEntry: entry });
          });
        }
      );
    }
  );
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
          return res.status(409).json({ error: "An approved work entry can't be edited" });
        }

        if (value.clientId) {
          db.get(
            'SELECT id FROM clients WHERE id = ? AND user_email = ?',
            [value.clientId, req.userEmail],
            (clientErr, clientRow) => {
              if (clientErr) {
                console.error('Database error:', clientErr);
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

          db.run(
            `UPDATE work_entries SET ${updates.join(', ')} WHERE id = ? AND user_email = ?`,
            values,
            (updateErr) => {
              if (updateErr) {
                console.error('Database error:', updateErr);
                return res.status(500).json({ error: 'Failed to update work entry' });
              }

              getWorkEntry(db, workEntryId, (retrieveErr, updatedEntry) => {
                if (retrieveErr) {
                  console.error('Database error:', retrieveErr);
                  return res.status(500).json({ error: 'Work entry updated but failed to retrieve' });
                }

                res.json({
                  message: 'Work entry updated successfully',
                  workEntry: updatedEntry
                });
              });
            }
          );
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
        return res.status(409).json({ error: "An approved work entry can't be deleted" });
      }

      db.run(
        'DELETE FROM work_entries WHERE id = ? AND user_email = ?',
        [workEntryId, req.userEmail],
        (deleteErr) => {
          if (deleteErr) {
            console.error('Database error:', deleteErr);
            return res.status(500).json({ error: 'Failed to delete work entry' });
          }

          res.json({ message: 'Work entry deleted successfully' });
        }
      );
    }
  );
});

module.exports = router;
