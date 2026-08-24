const {
  STATUS,
  normalizeStatus,
  canTransition,
  isEditable
} = require('../../workflow/workEntryStatus');

describe('Work Entry Status State Machine', () => {
  describe('normalizeStatus', () => {
    test('should default missing status to draft', () => {
      expect(normalizeStatus(undefined)).toBe(STATUS.DRAFT);
      expect(normalizeStatus(null)).toBe(STATUS.DRAFT);
      expect(normalizeStatus('')).toBe(STATUS.DRAFT);
    });

    test('should keep known statuses untouched', () => {
      expect(normalizeStatus(STATUS.SUBMITTED)).toBe(STATUS.SUBMITTED);
      expect(normalizeStatus(STATUS.APPROVED)).toBe(STATUS.APPROVED);
      expect(normalizeStatus(STATUS.REJECTED)).toBe(STATUS.REJECTED);
    });
  });

  describe('canTransition - allowed transitions', () => {
    test.each([
      [STATUS.DRAFT, STATUS.SUBMITTED],
      [STATUS.SUBMITTED, STATUS.APPROVED],
      [STATUS.SUBMITTED, STATUS.REJECTED],
      [STATUS.REJECTED, STATUS.SUBMITTED]
    ])('should allow %s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });

    test('should treat a missing status as draft', () => {
      expect(canTransition(undefined, STATUS.SUBMITTED)).toBe(true);
    });
  });

  describe('canTransition - rejected transitions', () => {
    test.each([
      [STATUS.DRAFT, STATUS.DRAFT],
      [STATUS.DRAFT, STATUS.APPROVED],
      [STATUS.DRAFT, STATUS.REJECTED],
      [STATUS.SUBMITTED, STATUS.DRAFT],
      [STATUS.SUBMITTED, STATUS.SUBMITTED],
      [STATUS.APPROVED, STATUS.DRAFT],
      [STATUS.APPROVED, STATUS.SUBMITTED],
      [STATUS.APPROVED, STATUS.APPROVED],
      [STATUS.APPROVED, STATUS.REJECTED],
      [STATUS.REJECTED, STATUS.DRAFT],
      [STATUS.REJECTED, STATUS.APPROVED],
      [STATUS.REJECTED, STATUS.REJECTED]
    ])('should reject %s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    });

    test('should reject unknown statuses', () => {
      expect(canTransition('archived', STATUS.SUBMITTED)).toBe(false);
      expect(canTransition(STATUS.DRAFT, 'archived')).toBe(false);
    });
  });

  describe('isEditable', () => {
    test('should allow editing until the entry is approved', () => {
      expect(isEditable(undefined)).toBe(true);
      expect(isEditable(STATUS.DRAFT)).toBe(true);
      expect(isEditable(STATUS.SUBMITTED)).toBe(true);
      expect(isEditable(STATUS.REJECTED)).toBe(true);
    });

    test('should block editing an approved entry', () => {
      expect(isEditable(STATUS.APPROVED)).toBe(false);
    });
  });
});
