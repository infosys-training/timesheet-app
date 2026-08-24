function getApproverEmails() {
  return new Set(
    (process.env.APPROVER_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isApproverEmail(email) {
  return getApproverEmails().has(String(email).trim().toLowerCase());
}

module.exports = {
  isApproverEmail
};
