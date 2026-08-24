const DEFAULT_APPROVER_EMAILS = ['approver@example.com'];

function getApproverEmails() {
  const configuredEmails = process.env.APPROVER_EMAILS;

  if (!configuredEmails) {
    return DEFAULT_APPROVER_EMAILS;
  }

  return configuredEmails
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isApprover(email) {
  return getApproverEmails().includes(email.trim().toLowerCase());
}

module.exports = {
  DEFAULT_APPROVER_EMAILS,
  getApproverEmails,
  isApprover
};
