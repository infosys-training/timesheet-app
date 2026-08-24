const {
  DRAFT,
  SUBMITTED,
  APPROVED,
  REJECTED,
  WORK_ENTRY_STATUSES,
  DEFAULT_STATUS,
  canTransition,
  canPerformAction,
  isEditable,
  isValidStatus,
  transitionErrorMessage
} = require('../../workflow/workEntryStatus');

describe('Work Entry Status State Machine', () => {
  const VALID_TRANSITIONS = [
    [DRAFT, SUBMITTED],
    [SUBMITTED, APPROVED],
    [SUBMITTED, REJECTED],
    [REJECTED, SUBMITTED]
  ];

  const ALL_TRANSITIONS = WORK_ENTRY_STATUSES.flatMap(from =>
    WORK_ENTRY_STATUSES.map(to => [from, to])
  );

  const REJECTED_TRANSITIONS = ALL_TRANSITIONS.filter(
    ([from, to]) => !VALID_TRANSITIONS.some(([vFrom, vTo]) => vFrom === from && vTo === to)
  );

  test('new entries default to draft', () => {
    expect(DEFAULT_STATUS).toBe(DRAFT);
  });

  test.each(VALID_TRANSITIONS)('should allow %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  test.each(REJECTED_TRANSITIONS)('should reject %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  test('should cover every status pair', () => {
    expect(VALID_TRANSITIONS.length + REJECTED_TRANSITIONS.length).toBe(
      WORK_ENTRY_STATUSES.length * WORK_ENTRY_STATUSES.length
    );
  });

  test('approved is terminal', () => {
    WORK_ENTRY_STATUSES.forEach(to => {
      expect(canTransition(APPROVED, to)).toBe(false);
    });
  });

  describe('canPerformAction', () => {
    const CASES = [
      ['submit', DRAFT, true],
      ['submit', REJECTED, true],
      ['submit', SUBMITTED, false],
      ['submit', APPROVED, false],
      ['approve', SUBMITTED, true],
      ['approve', DRAFT, false],
      ['approve', REJECTED, false],
      ['approve', APPROVED, false],
      ['reject', SUBMITTED, true],
      ['reject', DRAFT, false],
      ['reject', REJECTED, false],
      ['reject', APPROVED, false]
    ];

    test.each(CASES)('%s from %s should be %s', (action, from, expected) => {
      expect(canPerformAction(action, from)).toBe(expected);
    });

    test('should reject unknown actions', () => {
      expect(canPerformAction('archive', DRAFT)).toBe(false);
    });
  });

  describe('isEditable', () => {
    test.each([
      [DRAFT, true],
      [SUBMITTED, true],
      [REJECTED, true],
      [APPROVED, false]
    ])('%s should be editable: %s', (status, expected) => {
      expect(isEditable(status)).toBe(expected);
    });
  });

  describe('isValidStatus', () => {
    test.each(WORK_ENTRY_STATUSES)('%s is a valid status', (status) => {
      expect(isValidStatus(status)).toBe(true);
    });

    test('should reject unknown statuses', () => {
      expect(isValidStatus('pending')).toBe(false);
      expect(isValidStatus(undefined)).toBe(false);
    });
  });

  test('transitionErrorMessage names the action and current status', () => {
    expect(transitionErrorMessage('approve', DRAFT)).toBe(
      "Cannot approve a work entry with status 'draft'"
    );
  });
});
