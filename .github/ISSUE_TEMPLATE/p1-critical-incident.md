---
name: "P1 - Critical Incident"
about: "Service is completely down or data loss is occurring. Immediate response required."
title: "[P1] "
labels: "incident, P1-critical, urgent"
assignees: ""
---

## Incident Summary

**Severity:** P1 - Critical
**Status:** <!-- Investigating | Identified | Monitoring | Resolved -->
**Incident Commander:** <!-- @username -->

### Description
<!-- Brief description of what is happening -->


### Impact

**Users Affected:** <!-- All users / Specific group / Percentage -->
**Functionality Affected:** <!-- Which features are impacted -->
**Data Loss:** <!-- Yes / No / Unknown - describe if applicable -->
**Revenue Impact:** <!-- Estimated if applicable -->

---

## Timeline

| Time (UTC) | Event |
|------------|-------|
| YYYY-MM-DD HH:MM | Incident detected |
| YYYY-MM-DD HH:MM | Team notified |
| YYYY-MM-DD HH:MM | Investigation started |
| | |

---

## Diagnosis

### Symptoms Observed
- [ ] Backend returning HTTP 500 errors
- [ ] Health check endpoint (`/health`) failing
- [ ] Database connection errors in logs
- [ ] Application process not running
- [ ] Docker container unhealthy / restarting
- [ ] Other: <!-- describe -->

### Logs / Evidence
<!-- Paste relevant log snippets, screenshots, or monitoring alerts -->

```
<!-- paste logs here -->
```

### Root Cause
<!-- Once identified, describe the root cause -->


---

## Resolution

### Immediate Actions Taken
<!-- What was done to restore service -->
1.
2.
3.

### Permanent Fix
<!-- What change is needed to prevent recurrence -->


### Verification Steps
- [ ] Health check passing (`curl http://localhost:3001/health`)
- [ ] Login flow working
- [ ] Client CRUD operations verified
- [ ] Work entry CRUD operations verified
- [ ] Report generation (CSV/PDF) verified
- [ ] Data integrity confirmed

---

## Post-Incident

### Follow-Up Tasks
- [ ] Root cause analysis documented
- [ ] Monitoring gaps addressed
- [ ] Runbook updated
- [ ] Post-incident review scheduled

### Communication
- [ ] Stakeholders notified of incident
- [ ] Status updates posted during incident
- [ ] Resolution communicated to affected users
- [ ] Post-incident report shared with team
