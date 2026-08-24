const { getApproverEmails, isApprover, DEFAULT_APPROVER_EMAILS } = require('../../config/approvers');

describe('Approver configuration', () => {
  const originalApproverEmails = process.env.APPROVER_EMAILS;

  afterEach(() => {
    if (originalApproverEmails === undefined) {
      delete process.env.APPROVER_EMAILS;
    } else {
      process.env.APPROVER_EMAILS = originalApproverEmails;
    }
  });

  test('uses the documented default when the environment variable is unset', () => {
    delete process.env.APPROVER_EMAILS;

    expect(getApproverEmails()).toEqual(DEFAULT_APPROVER_EMAILS);
    expect(isApprover('APPROVER@example.com')).toBe(true);
  });

  test('parses trimmed comma-separated emails case-insensitively', () => {
    process.env.APPROVER_EMAILS = ' First@Example.com, second@example.com , ';

    expect(getApproverEmails()).toEqual(['first@example.com', 'second@example.com']);
    expect(isApprover('FIRST@example.com')).toBe(true);
    expect(isApprover('other@example.com')).toBe(false);
  });
});
