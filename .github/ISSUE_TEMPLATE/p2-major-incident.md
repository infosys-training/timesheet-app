---
name: "P2 - Major Incident"
about: "Service is degraded. Key functionality impaired but workarounds may exist."
title: "[P2] "
labels: "incident, P2-major"
assignees: ""
---

## Incident Summary

**Severity:** P2 - Major
**Status:** <!-- Investigating | Identified | Monitoring | Resolved -->
**Assigned To:** <!-- @username -->

### Description
<!-- Brief description of what is happening -->


### Impact

**Users Affected:** <!-- Subset of users / Specific workflows -->
**Functionality Affected:** <!-- Which features are degraded -->
**Workaround Available:** <!-- Yes / No - describe if yes -->

---

## Timeline

| Time (UTC) | Event |
|------------|-------|
| YYYY-MM-DD HH:MM | Issue detected |
| YYYY-MM-DD HH:MM | Investigation started |
| | |

---

## Diagnosis

### Symptoms Observed
- [ ] Elevated API response times
- [ ] Intermittent HTTP 500 errors
- [ ] Report generation (PDF/CSV) failing
- [ ] Authentication flow partially broken
- [ ] Rate limiting affecting legitimate users
- [ ] CORS errors for certain origins
- [ ] Memory usage elevated / growing
- [ ] Other: <!-- describe -->

### Logs / Evidence
<!-- Paste relevant log snippets, metrics, or screenshots -->

```
<!-- paste logs here -->
```

### Root Cause
<!-- Once identified, describe the root cause -->


---

## Resolution

### Actions Taken
1.
2.
3.

### Workaround Applied
<!-- If a temporary workaround was used, describe it here -->


### Permanent Fix
<!-- What change is needed to prevent recurrence -->


### Verification Steps
- [ ] Affected functionality restored
- [ ] Performance returned to normal levels
- [ ] No error spike in logs
- [ ] Health check passing

---

## Post-Incident

### Follow-Up Tasks
- [ ] Root cause documented
- [ ] Permanent fix deployed
- [ ] Monitoring improved
- [ ] Runbook updated if applicable

### Communication
- [ ] Team notified of degradation
- [ ] Status updates provided
- [ ] Resolution communicated
