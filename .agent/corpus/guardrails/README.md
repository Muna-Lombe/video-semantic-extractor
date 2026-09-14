# Guardrails Corpus

This directory documents lessons learned, common pitfalls, solutions discovered through experience, incident postmortems, and performance bottlenecks.

Inspired by "Ralph" — a system that treats context as ephemeral and preserves institutional knowledge in files.

## 📁 Organization

- `lessons-learned.md` — Documented lessons from development
- `common-pitfalls.md` — Problems we've encountered and solutions
- `incident-postmortems/` — Analysis of production incidents
- `performance-bottlenecks.md` — Known performance issues and fixes
- `architecture-decisions.md` — Why we chose certain approaches

## 🎯 Purpose

Before major decisions, check this corpus:
- Have we solved this problem before?
- What did we learn last time?
- What pitfalls should we avoid?
- What were the performance impacts?

## 📝 Contributing

**Add a document here after:**
- Solving a non-trivial bug
- Discovering a gotcha or edge case
- Finding a better pattern
- Resolving a production incident

**Document format:**

```markdown
### Problem Title
**Date Learned:** YYYY-MM-DD  
**Category:** [Docker/Database/Security/Performance/etc.]

⚠️ **Problem:** Description of the issue

✓ **Solution:** How we fixed it

📄 **Affected Files:** List of relevant files

💡 **Prevention:** How to avoid this in the future
```

## 🔄 Context Rotation Strategy

This corpus survives context window rotation by persisting in files. Agents should:
1. Review relevant guardrails before major tasks
2. Add new guardrails after learning
3. Keep decisions documented and linked
