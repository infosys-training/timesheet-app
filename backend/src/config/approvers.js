function isApproverEmail(email) {
  const approverEmails = (process.env.APPROVER_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return approverEmails.includes((email || '').trim().toLowerCase());
}

module.exports = {
  isApproverEmail
};
