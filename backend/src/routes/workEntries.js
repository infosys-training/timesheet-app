const express = require('express');
const { getDatabase } = require('../database/init');
const { authenticateUser, requireApprover } = require('../middleware/auth');
const { workEntrySchema, updateWorkEntrySchema, rejectWorkEntrySchema } = require('../validation/schemas');
const {
  SUBMITTED,
  WORK_ENTRY_STATUSES,
  ACTION_TARGET_STATUS,
  canPerformAction,
  isEditable,
  isValidStatus,
  transitionErrorMessage
} = require('../workflow/workEntryStatus');

const router = express.Router();

const WORK_ENTRY_FIELDS = `we.id, we.client_id, we.hours, we.description, we.date, we.status,
           we.submitted_at, we.reviewed_at, we.reviewed_by, we.rejection_reason,
           we.created_at, we.updated_at, c.name as client_name`;

// All routes require authentication
router.use(authenticateUser);

// Get all work entries for authenticated user (with optional client and status filters)
router.get('/', (req, res) => {
  const { clientId, status } = req.query;
  const db = getDatabase();
  
  let query = `
    SELECT ${WORK_ENTRY_FIELDS}
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
      return res.status(400).json({
        error: `Invalid status filter. Must be one of: ${WORK_ENTRY_STATUSES.join(', ')}`
      });
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
router.get('/pending-approvals', requireApprover, (req, res) => {
  const db = getDatabase();

  db.all(
    `SELECT ${WORK_ENTRY_FIELDS}, we.user_email
     FROM work_entries we
     JOIN clients c ON we.client_id = c.id
     WHERE we.status = ?
     ORDER BY we.submitted_at ASC, we.date DESC`,
    [SUBMITTED],
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
    `SELECT ${WORK_ENTRY_FIELDS}
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

// Create new work entry (always starts in the default status)
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
              `SELECT ${WORK_ENTRY_FIELDS}
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

// Update work entry (blocked once approved)
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
          return res.status(409).json({ error: transitionErrorMessage('update', row.status) });
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
              `SELECT ${WORK_ENTRY_FIELDS}
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

// Apply a status transition and return the updated entry
function applyTransition({ action, workEntryId, res, updates, values, successMessage }) {
  const db = getDatabase();

  const query = `UPDATE work_entries SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

  db.run(query, [...values, workEntryId], function(err) {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: `Failed to ${action} work entry` });
    }

    db.get(
      `SELECT ${WORK_ENTRY_FIELDS}
       FROM work_entries we
       JOIN clients c ON we.client_id = c.id
       WHERE we.id = ?`,
      [workEntryId],
      (err, row) => {
        if (err) {
          console.error('Database error:', err);
          return res.status(500).json({ error: 'Status updated but failed to retrieve work entry' });
        }

        res.json({
          message: successMessage,
          workEntry: row
        });
      }
    );
  });
}

// Look up an entry and verify the requested transition is legal
function loadEntryForTransition({ action, req, res, ownerOnly }, onValid) {
  const workEntryId = parseInt(req.params.id);

  if (isNaN(workEntryId)) {
    res.status(400).json({ error: 'Invalid work entry ID' });
    return;
  }

  const db = getDatabase();

  const query = ownerOnly
    ? 'SELECT id, status FROM work_entries WHERE id = ? AND user_email = ?'
    : 'SELECT id, status FROM work_entries WHERE id = ?';
  const params = ownerOnly ? [workEntryId, req.userEmail] : [workEntryId];

  db.get(query, params, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Work entry not found' });
    }

    if (!canPerformAction(action, row.status)) {
      return res.status(409).json({ error: transitionErrorMessage(action, row.status) });
    }

    onValid(workEntryId, row);
  });
}

// Submit own work entry for approval: draft | rejected -> submitted
router.post('/:id/submit', (req, res) => {
  loadEntryForTransition({ action: 'submit', req, res, ownerOnly: true }, (workEntryId) => {
    applyTransition({
      action: 'submit',
      workEntryId,
      res,
      updates: ['status = ?', 'submitted_at = CURRENT_TIMESTAMP', 'reviewed_at = NULL', 'reviewed_by = NULL', 'rejection_reason = NULL'],
      values: [ACTION_TARGET_STATUS.submit],
      successMessage: 'Work entry submitted for approval'
    });
  });
});

// Approve a submitted work entry (approvers only): submitted -> approved
router.post('/:id/approve', requireApprover, (req, res) => {
  loadEntryForTransition({ action: 'approve', req, res, ownerOnly: false }, (workEntryId) => {
    applyTransition({
      action: 'approve',
      workEntryId,
      res,
      updates: ['status = ?', 'reviewed_at = CURRENT_TIMESTAMP', 'reviewed_by = ?', 'rejection_reason = NULL'],
      values: [ACTION_TARGET_STATUS.approve, req.userEmail],
      successMessage: 'Work entry approved successfully'
    });
  });
});

// Reject a submitted work entry (approvers only): submitted -> rejected
router.post('/:id/reject', requireApprover, (req, res, next) => {
  const { error, value } = rejectWorkEntrySchema.validate(req.body || {});
  if (error) {
    return next(error);
  }

  loadEntryForTransition({ action: 'reject', req, res, ownerOnly: false }, (workEntryId) => {
    applyTransition({
      action: 'reject',
      workEntryId,
      res,
      updates: ['status = ?', 'reviewed_at = CURRENT_TIMESTAMP', 'reviewed_by = ?', 'rejection_reason = ?'],
      values: [ACTION_TARGET_STATUS.reject, req.userEmail, value.reason || null],
      successMessage: 'Work entry rejected'
    });
  });
});

// Delete work entry (blocked once approved)
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
        return res.status(409).json({ error: transitionErrorMessage('delete', row.status) });
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
