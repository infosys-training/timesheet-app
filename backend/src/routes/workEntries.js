const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, reviewSchema } = require('../validation/schemas');
const { isValidStatus, canTransition, isEditable, WORK_ENTRY_STATUSES } = require('../domain/workEntryStatus');

const router = express.Router();

const WORK_ENTRY_COLUMNS = `we.id, we.client_id, we.hours, we.description, we.date,
           we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.review_note,
           we.created_at, we.updated_at, c.name as client_name`;

// All routes require authentication
router.use(authenticateUser);

// Fetch a work entry (with client name) regardless of owner
function fetchWorkEntry(db, workEntryId, callback) {
  db.get(
    `SELECT ${WORK_ENTRY_COLUMNS}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.id = ?`,
    [workEntryId],
    callback
  );
}

// Load an existing entry's id/status before acting on it, answering 400/404/500 directly
function loadWorkEntry(req, res, { ownerScoped }, handler) {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }

  const db = getDatabase();
  const query = ownerScoped
    ? 'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?'
    : 'SELECT id, status FROM work_entries WHERE id = ?';
  const params = ownerScoped ? [workEntryId, req.userEmail] : [workEntryId];

  db.get(query, params, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Work entry not found' });
    }

    handler(db, row, workEntryId);
  });
}

// Re-read an entry after a write so responses always carry the client name
function respondWithWorkEntry(res, db, workEntryId, message, retrieveError) {
  fetchWorkEntry(db, workEntryId, (err, updated) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: retrieveError });
    }

    res.json({ message, workEntry: updated });
  });
}

// Get all work entries for authenticated user (with optional client filter)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  
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
    if (!isValidStatus(status)) {
      return res.status(400).json({ error: `Status must be one of: ${WORK_ENTRY_STATUSES.join(', ')}` });
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

// Get all submitted work entries awaiting review (approvers only)
router.get('/pending', requireApprover, (req, res) => {
  const db = getDatabase();

  db.all(
    `SELECT ${WORK_ENTRY_COLUMNS}, we.user_email
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = 'submitted'
     ORDER BY we.submitted_at ASC, we.id ASC`,
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

// Get specific work entry
router.get('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    `SELECT ${WORK_ENTRY_COLUMNS}
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
            fetchWorkEntry(db, this.lastID, (err, row) => {
                if (err) {
                  console.error('Database error:', err);
                  return res.status(500).json({ error: 'Work entry created but failed to retrieve' });
                }

                res.status(201).json({
                  message: 'Work entry created successfully',
                  workEntry: row
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

    loadWorkEntry(req, res, { ownerScoped: true }, (db, row) => {
      if (!isEditable(row.status)) {
        return res.status(409).json({ error: 'Approved work entries can no longer be edited' });
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

          respondWithWorkEntry(
            res,
            db,
            workEntryId,
            'Work entry updated successfully',
            'Work entry updated but failed to retrieve'
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
  loadWorkEntry(req, res, { ownerScoped: true }, (db, row, workEntryId) => {
    if (!isEditable(row.status)) {
      return res.status(409).json({ error: 'Approved work entries can no longer be deleted' });
    }

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

// Submit own work entry for approval (draft | rejected -> submitted)
router.post('/:id/submit', (req, res) => {
  loadWorkEntry(req, res, { ownerScoped: true }, (db, row, workEntryId) => {
    if (!canTransition(row.status, 'submitted')) {
      return res.status(409).json({
        error: `Cannot submit a work entry with status '${row.status}'`
      });
    }

    db.run(
      `UPDATE work_entries
       SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
           reviewed_at = NULL, reviewed_by = NULL, review_note = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_email = ?`,
      [workEntryId, req.userEmail],
      (err) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Failed to submit work entry' });
        }

        respondWithWorkEntry(
          res,
          db,
          workEntryId,
          'Work entry submitted for approval',
          'Work entry submitted but failed to retrieve'
        );
      }
    );
  });
});

// Review a submitted work entry (approvers only)
function reviewWorkEntry(targetStatus, successMessage) {
  const action = targetStatus === 'approved' ? 'approve' : 'reject';

  return (req, res, next) => {
    const { error, value } = reviewSchema.validate(req.body || {});
    if (error) {
      return next(error);
    }

    // Approvers review entries owned by other users, so this lookup is not scoped by email
    loadWorkEntry(req, res, { ownerScoped: false }, (db, row, workEntryId) => {
      if (!canTransition(row.status, targetStatus)) {
        return res.status(409).json({
          error: `Cannot ${action} a work entry with status '${row.status}'`
        });
      }

      db.run(
        `UPDATE work_entries
         SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, review_note = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [targetStatus, req.userEmail, value.note || null, workEntryId],
        (err) => {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: `Failed to ${action} work entry` });
          }

          respondWithWorkEntry(
            res,
            db,
            workEntryId,
            successMessage,
            'Work entry reviewed but failed to retrieve'
          );
        }
      );
    });
  };
}

router.post('/:id/approve', requireApprover, reviewWorkEntry('approved', 'Work entry approved'));
router.post('/:id/reject', requireApprover, reviewWorkEntry('rejected', 'Work entry rejected'));

module.exports = router;
