const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, rejectionSchema } = require('../validation/schemas');

const router = express.Router();
const statuses = ['draft', 'submitted', 'approved', 'rejected'];
const transitionRules = {
  submit: { draft: 'submitted', rejected: 'submitted' },
  approve: { submitted: 'approved' },
  reject: { submitted: 'rejected' }
};
const editableStatuses = ['draft', 'rejected'];
const workEntryColumns = `
  we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
  we.status, we.submitted_at, we.reviewed_at, we.reviewed_by,
  we.rejection_reason, we.created_at, we.updated_at, c.name as client_name
`;

function transitionError(action, status) {
  return `Cannot ${action} work entry with status "${status}"`;
}

function getNextStatus(action, status) {
  return transitionRules[action][status];
}

function sendWorkEntry(db, id, res, message, retrievalError, responseStatus = 200) {
  db.get(
    `SELECT ${workEntryColumns}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: retrievalError });
      }
      res.status(responseStatus).json({ message, workEntry: row });
    }
  );
}

function handleTransition(action, req, res) {
  const workEntryId = parseInt(req.params.id);
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  const ownerScoped = action === 'submit';
  const lookupQuery = ownerScoped
    ? 'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?'
    : 'SELECT id, status FROM work_entries WHERE id = ?';
  const lookupParams = ownerScoped ? [workEntryId, req.userEmail] : [workEntryId];

  db.get(lookupQuery, lookupParams, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!row) return res.status(404).json({ error: 'Work entry not found' });

    const nextStatus = getNextStatus(action, row.status);
    if (!nextStatus) {
      return res.status(409).json({ error: transitionError(action, row.status) });
    }

    let query;
    let params;
    if (action === 'submit') {
      query = `UPDATE work_entries
               SET status = ?, submitted_at = CURRENT_TIMESTAMP,
                   reviewed_at = NULL, reviewed_by = NULL, rejection_reason = NULL
               WHERE id = ? AND user_email = ? AND status = ?`;
      params = [nextStatus, workEntryId, req.userEmail, row.status];
    } else if (action === 'approve') {
      query = `UPDATE work_entries
               SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
                   rejection_reason = NULL
               WHERE id = ? AND status = ?`;
      params = [nextStatus, req.userEmail, workEntryId, row.status];
    } else {
      query = `UPDATE work_entries
               SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
                   rejection_reason = ?
               WHERE id = ? AND status = ?`;
      params = [nextStatus, req.userEmail, req.body.reason || null, workEntryId, row.status];
    }

    db.run(query, params, updateErr => {
      if (updateErr) {
        console.error('Database error:', updateErr);
        return res.status(500).json({ error: `Failed to ${action} work entry` });
      }
      const transitionName = action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : 'rejected';
      const message = `Work entry ${transitionName} successfully`;
      const retrievalError = `Work entry ${transitionName} but failed to retrieve`;
      sendWorkEntry(db, workEntryId, res, message, retrievalError);
    });
  });
}

// All routes require authentication
router.use(authenticateUser);

// Keep this route before /:id so "pending-approvals" is not parsed as an ID.
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();
  db.all(
    `SELECT ${workEntryColumns}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = 'submitted'
     ORDER BY we.submitted_at ASC, we.date ASC`,
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
    SELECT ${workEntryColumns}
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
    `SELECT ${workEntryColumns}
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
            sendWorkEntry(db, this.lastID, res, 'Work entry created successfully', 'Work entry created but failed to retrieve', 201);
          }
        );
      }
    );
  } catch (error) {
    next(error);
  }
});

router.post('/:id/submit', (req, res) => handleTransition('submit', req, res));
router.post('/:id/approve', requireApprover, (req, res) => handleTransition('approve', req, res));
router.post('/:id/reject', requireApprover, (req, res, next) => {
  const { error, value } = rejectionSchema.validate(req.body || {});
  if (error) return next(error);
  req.body = value;
  handleTransition('reject', req, res);
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
      'SELECT we.id, we.status FROM work_entries we WHERE we.id = ? AND we.user_email = ?',
      [workEntryId, req.userEmail],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!row) {
          return res.status(404).json({ error: 'Work entry not found' });
        }

        if (row.status && !editableStatuses.includes(row.status)) {
          return res.status(409).json({ error: `Cannot edit work entry with status "${row.status}"` });
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
            sendWorkEntry(db, workEntryId, res, 'Work entry updated successfully', 'Work entry updated but failed to retrieve');
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
    'SELECT we.id, we.status FROM work_entries we WHERE we.id = ? AND we.user_email = ?',
    [workEntryId, req.userEmail],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }

      if (row.status && !editableStatuses.includes(row.status)) {
        return res.status(409).json({ error: `Cannot delete work entry with status "${row.status}"` });
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
