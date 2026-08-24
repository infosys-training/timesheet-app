// Work entry approval state machine
//
//   draft ---- submit ----> submitted ---- approve ----> approved (terminal)
//                              |
//                              ---------- reject -----> rejected
//   rejected -- submit ----> submitted

const WORK_ENTRY_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

const DEFAULT_STATUS = 'draft';

const TRANSITIONS = {
  submit: { from: ['draft', 'rejected'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'approved' },
  reject: { from: ['submitted'], to: 'rejected' }
};

// Approved entries are immutable, every other status may still be changed
const EDITABLE_STATUSES = ['draft', 'submitted', 'rejected'];

function isValidStatus(status) {
  return WORK_ENTRY_STATUSES.includes(status);
}

function canTransition(action, currentStatus) {
  const transition = TRANSITIONS[action];
  return Boolean(transition) && transition.from.includes(currentStatus);
}

function nextStatus(action) {
  return TRANSITIONS[action].to;
}

function isEditable(status) {
  return EDITABLE_STATUSES.includes(status);
}

function transitionErrorMessage(action, currentStatus) {
  const allowed = TRANSITIONS[action].from.join(', ');
  return `Cannot ${action} a work entry with status '${currentStatus}'. Allowed statuses: ${allowed}`;
}

module.exports = {
  WORK_ENTRY_STATUSES,
  DEFAULT_STATUS,
  EDITABLE_STATUSES,
  TRANSITIONS,
  isValidStatus,
  canTransition,
  nextStatus,
  isEditable,
  transitionErrorMessage
};
