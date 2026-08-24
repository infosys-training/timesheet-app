const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, rejectWorkEntrySchema } = require('../validation/schemas');
const {
  WORK_ENTRY_STATUSES,
  canTransition,
  nextStatus,
  transitionErrorMessage,
  isEditable
} = require('../domain/workEntryStatus');

const router = express.Router();

// All routes require authentication
router.use(authenticateUser);

const WORK_ENTRY_COLUMNS = `we.id, we.client_id, we.user_email, we.hours, we.description, we.date,
           we.status, we.submitted_at, we.reviewed_at, we.reviewed_by, we.rejection_reason,
           we.created_at, we.updated_at, c.name as client_name`;

const PAST_TENSE = {
  submit: 'submitted',
  approve: 'approved',
  reject: 'rejected'
};

// Handles the status transitions: submit (owner), approve and reject (approver)
function transitionHandler(action, { ownerOnly }) {
  return (req, res, next) => {
    const workEntryId = parseInt(req.params.id);

    if (isNaN(workEntryId)) {
      return res.status(400).json({ error: 'Invalid work entry ID' });
    }

    let reason = null;
    if (action === 'reject') {
      const { error, value } = rejectWorkEntrySchema.validate(req.body);
      if (error) {
        return next(error);
      }
      reason = value.reason;
    }

    const db = getDatabase();
    const lookupQuery = ownerOnly
      ? 'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?'
      : 'SELECT id, status FROM work_entries WHERE id = ?';
    const lookupParams = ownerOnly ? [workEntryId, req.userEmail] : [workEntryId];

    db.get(lookupQuery, lookupParams, (err, row) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Work entry not found' });
      }

      const currentStatus = row.status || WORK_ENTRY_STATUSES.DRAFT;

      if (!canTransition(action, currentStatus)) {
        return res.status(409).json({ error: transitionErrorMessage(action, currentStatus) });
      }

      const query = action === 'submit'
        ? `UPDATE work_entries
           SET status = ?, submitted_at = CURRENT_TIMESTAMP, reviewed_at = NULL, reviewed_by = NULL,
               rejection_reason = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        : `UPDATE work_entries
           SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, rejection_reason = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`;
      const params = action === 'submit'
        ? [nextStatus(action), workEntryId]
        : [nextStatus(action), req.userEmail, reason, workEntryId];

      db.run(query, params, function(err) {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: `Failed to ${action} work entry` });
        }

        db.get(
          `SELECT ${WORK_ENTRY_COLUMNS}
           FROM work_entries we
           JOIN clients c ON we.client_id = c.id
           WHERE we.id = ?`,
          [workEntryId],
          (err, updatedRow) => {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: `Work entry ${PAST_TENSE[action]} but failed to retrieve` });
            }

            res.json({
              message: `Work entry ${PAST_TENSE[action]} successfully`,
              workEntry: updatedRow
            });
          }
        );
      });
    });
  };
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
  
  if (status) {
    if (!Object.values(WORK_ENTRY_STATUSES).includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }
    query += ' AND we.status = ?';
    params.push(status);
  }
  
  if (clientId) {
    const clientIdNum = parseInt(clientId);
    if (isNaN(clientIdNum)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    query += ' AND we.client_id = ?';
    params.push(clientIdNum);
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

// Get every submitted work entry awaiting review (approvers only)
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();

  db.all(
    `SELECT ${WORK_ENTRY_COLUMNS}
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = ?
     ORDER BY we.submitted_at ASC, we.date DESC`,
    [WORK_ENTRY_STATUSES.SUBMITTED],
    (err, rows) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      res.json({ workEntries: rows });
    }
  );
});

// Submit own work entry for approval
router.post('/:id/submit', transitionHandler('submit', { ownerOnly: true }));

// Approve a submitted work entry (approvers only)
router.post('/:id/approve', requireApprover, transitionHandler('approve', { ownerOnly: false }));

// Reject a submitted work entry (approvers only)
router.post('/:id/reject', requireApprover, transitionHandler('reject', { ownerOnly: false }));

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
            db.get(
              `SELECT ${WORK_ENTRY_COLUMNS}
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

        if (!isEditable(row.status)) {
          return res.status(409).json({ error: 'An approved work entry can no longer be edited' });
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
              `SELECT ${WORK_ENTRY_COLUMNS}
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
      
      if (!isEditable(row.status)) {
        return res.status(409).json({ error: 'An approved work entry can no longer be deleted' });
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
