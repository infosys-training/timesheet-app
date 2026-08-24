// Work entry approval state machine
const WORK_ENTRY_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

const ALLOWED_TRANSITIONS = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: [],
  rejected: ['submitted']
};

function isValidStatus(status) {
  return WORK_ENTRY_STATUSES.includes(status);
}

function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function isEditable(status) {
  return status !== 'approved';
}

module.exports = {
  WORK_ENTRY_STATUSES,
  ALLOWED_TRANSITIONS,
  isValidStatus,
  canTransition,
  isEditable
};
