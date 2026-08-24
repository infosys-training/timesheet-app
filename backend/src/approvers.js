function getApproverEmails() {
  return (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = {
  getApproverEmails
};
