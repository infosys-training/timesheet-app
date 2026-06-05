---
name: "P1 - Critical Incident"
about: "Complete service outage or data loss affecting all users"
title: "[P1] "
labels: ["incident", "P1-critical", "urgent"]
assignees: ""
---

## Incident Summary

**Status:** Active / Mitigated / Resolved
**Severity:** P1 — Critical (Complete outage or data loss)
**Detected at:** YYYY-MM-DD HH:MM UTC
**Resolved at:** YYYY-MM-DD HH:MM UTC (if applicable)

## Impact

- **Users affected:** All / Percentage
- **Functionality affected:** (e.g., entire application down, data loss)
- **Business impact:** (e.g., all users unable to log time entries)
- **Duration of impact:** 

## Timeline

| Time (UTC) | Event |
|------------|-------|
| HH:MM | Issue first detected |
| HH:MM | Incident declared |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed |
| HH:MM | Service restored |

## Root Cause

<!-- Describe the underlying cause of the incident -->

## Detection

- **How was it detected?** (monitoring alert / user report / health check failure)
- **Alert name (if applicable):** 
- **Time to detect:** 

## Resolution Steps

1. <!-- Step 1 -->
2. <!-- Step 2 -->
3. <!-- Step 3 -->

## Verification

- [ ] Health check endpoint returns 200
- [ ] All API endpoints responding
- [ ] Database read/write operations verified
- [ ] Frontend accessible and functional
- [ ] No error spikes in logs

## Prevention / Follow-up Actions

- [ ] <!-- Action item 1 -->
- [ ] <!-- Action item 2 -->
- [ ] <!-- Action item 3 -->

## Post-Mortem

- **Scheduled for:** YYYY-MM-DD
- **Post-mortem document link:** 

## Communication

- [ ] Stakeholders notified
- [ ] Status page updated
- [ ] Post-mortem shared with team
