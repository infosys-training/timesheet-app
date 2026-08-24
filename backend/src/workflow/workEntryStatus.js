// Work entry approval state machine
//
//   draft ---submit---> submitted ---approve---> approved (terminal)
//                            |
//                          reject
//                            v
//                        rejected ---submit---> submitted

const DRAFT = 'draft';
const SUBMITTED = 'submitted';
const APPROVED = 'approved';
const REJECTED = 'rejected';

const WORK_ENTRY_STATUSES = [DRAFT, SUBMITTED, APPROVED, REJECTED];
const DEFAULT_STATUS = DRAFT;

// Status a given action moves an entry to
const ACTION_TARGET_STATUS = {
  submit: SUBMITTED,
  approve: APPROVED,
  reject: REJECTED
};

const ALLOWED_TRANSITIONS = {
  [DRAFT]: [SUBMITTED],
  [SUBMITTED]: [APPROVED, REJECTED],
  [APPROVED]: [],
  [REJECTED]: [SUBMITTED]
};

// Approved entries are locked: no edits, no deletes, no further transitions
const EDITABLE_STATUSES = [DRAFT, SUBMITTED, REJECTED];

function isValidStatus(status) {
  return WORK_ENTRY_STATUSES.includes(status);
}

function canTransition(fromStatus, toStatus) {
  if (!isValidStatus(fromStatus) || !isValidStatus(toStatus)) {
    return false;
  }
  return ALLOWED_TRANSITIONS[fromStatus].includes(toStatus);
}

function canPerformAction(action, fromStatus) {
  const target = ACTION_TARGET_STATUS[action];
  if (!target) {
    return false;
  }
  return canTransition(fromStatus, target);
}

function isEditable(status) {
  return EDITABLE_STATUSES.includes(status);
}

function transitionErrorMessage(action, fromStatus) {
  return `Cannot ${action} a work entry with status '${fromStatus}'`;
}

module.exports = {
  DRAFT,
  SUBMITTED,
  APPROVED,
  REJECTED,
  WORK_ENTRY_STATUSES,
  DEFAULT_STATUS,
  ACTION_TARGET_STATUS,
  ALLOWED_TRANSITIONS,
  EDITABLE_STATUSES,
  isValidStatus,
  canTransition,
  canPerformAction,
  isEditable,
  transitionErrorMessage
};
