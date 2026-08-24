const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const {
  workEntrySchema,
  updateWorkEntrySchema,
  reviewWorkEntrySchema,
  WORK_ENTRY_STATUSES
} = require('../validation/schemas');

const router = express.Router();

// Approval state machine: which statuses each action may be applied to
const TRANSITIONS = {
  submit: { to: 'submitted', from: ['draft', 'rejected'] },
  approve: { to: 'approved', from: ['submitted'] },
  reject: { to: 'rejected', from: ['submitted'] }
};

// Statuses that still allow the owner to edit or delete an entry
const EDITABLE_STATUSES = ['draft', 'submitted', 'rejected'];

const WORK_ENTRY_COLUMNS = `
    SELECT we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
           we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.review_note,
           we.created_at, we.updated_at, c.name as client_name
    FROM work_entries we
    JOIN clients c ON we.client_id = c.id
`;

// All routes require authentication
router.use(authenticateUser);

// Get all work entries for authenticated user (with optional client and status filters)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  
  let query = `${WORK_ENTRY_COLUMNS}
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
    if (!WORK_ENTRY_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
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

// Get every submitted entry awaiting review (approvers only)
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();

  db.all(
    `${WORK_ENTRY_COLUMNS}
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

// Get specific work entry
router.get('/:id', (req, res) => {
  const workEntryId = parseInt(req.params.id);
  
  if (isNaN(workEntryId)) {
    return res.status(400).json({ error: 'Invalid work entry ID' });
  }
  
  const db = getDatabase();
  
  db.get(
    `${WORK_ENTRY_COLUMNS}
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
              `${WORK_ENTRY_COLUMNS}
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

        if (row.status && !EDITABLE_STATUSES.includes(row.status)) {
          return res.status(409).json({ error: 'Approved work entries cannot be edited' });
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
              `${WORK_ENTRY_COLUMNS}
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

      if (row.status && !EDITABLE_STATUSES.includes(row.status)) {
        return res.status(409).json({ error: 'Approved work entries cannot be deleted' });
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

// Submit own entry for approval: draft | rejected -> submitted
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

      if (!TRANSITIONS.submit.from.includes(row.status)) {
        return res.status(409).json({ error: `Cannot submit a work entry with status '${row.status}'` });
      }

      db.run(
        `UPDATE work_entries
         SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP, reviewed_at = NULL,
             reviewed_by = NULL, review_note = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_email = ?`,
        [workEntryId, req.userEmail],
        function(err) {
          if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Failed to submit work entry' });
          }

          respondWithWorkEntry(db, res, workEntryId, 'Work entry submitted for approval');
        }
      );
    }
  );
});

// Approve a submitted entry (approvers only): submitted -> approved
router.post('/:id/approve', requireApprover, reviewWorkEntry('approve', 'Work entry approved'));

// Reject a submitted entry (approvers only): submitted -> rejected
router.post('/:id/reject', requireApprover, reviewWorkEntry('reject', 'Work entry rejected'));

function reviewWorkEntry(action, successMessage) {
  const { from, to } = TRANSITIONS[action];

  return (req, res, next) => {
    try {
      const workEntryId = parseInt(req.params.id);

      if (isNaN(workEntryId)) {
        return res.status(400).json({ error: 'Invalid work entry ID' });
      }

      const { error, value } = reviewWorkEntrySchema.validate(req.body || {});
      if (error) {
        return next(error);
      }

      const db = getDatabase();

      // Approvers review entries owned by other users, so this lookup is not user scoped
      db.get(
        'SELECT id, status, user_email FROM work_entries WHERE id = ?',
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

          if (!from.includes(row.status)) {
            return res.status(409).json({ error: `Cannot ${action} a work entry with status '${row.status}'` });
          }

          db.run(
            `UPDATE work_entries
             SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?,
                 review_note = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [to, req.userEmail, value.note || null, workEntryId],
            function(err) {
              if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: `Failed to ${action} work entry` });
              }

              respondWithWorkEntry(db, res, workEntryId, successMessage);
            }
          );
        }
      );
    } catch (error) {
      next(error);
    }
  };
}

function respondWithWorkEntry(db, res, workEntryId, message) {
  db.get(
    `${WORK_ENTRY_COLUMNS}
     WHERE we.id = ?`,
    [workEntryId],
    (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Work entry updated but failed to retrieve' });
      }

      res.json({ message, workEntry: row });
    }
  );
}

module.exports = router;
