# Policies Corpus

This directory contains mandatory development policies, security requirements, compliance standards, and process gates.

## 📁 Organization

- `feature-development.md` — Policy for new feature development
- `security-requirements.md` — Security and authentication standards
- `code-review-policy.md` — Mandatory code review process
- `deployment-policy.md` — Deployment procedures and gates
- `data-handling-policy.md` — Data privacy and retention rules

## 🔴 MANDATORY - Agents Must Follow These

Unlike guidelines (which are suggestions), policies are requirements. All development must comply with policies in this directory.

## 🎯 Policy Categories

### Feature Development Policy
Defines how features are created, reviewed, and graduated.

**Key rule:** All new features must pass through defined stages before graduation.

### Security Policy
Defines authentication, authorization, and data protection requirements.

**Key rule:** No code is merged without security review.

### Code Review Policy
Defines who reviews, what's checked, and approval requirements.

**Key rule:** Minimum approvals and automated checks required.

### Deployment Policy
Defines deployment procedures, gates, and rollback strategies.

**Key rule:** No direct production deployments; all through CI/CD with gates.

### Data Handling Policy
Defines data privacy, retention, and compliance.

**Key rule:** All data handling must comply with privacy regulations.

## ⚖️ Policy Enforcement

Agents should:
1. **Identify** applicable policies
2. **Enforce** policies in code generation
3. **Flag** policy violations before approval
4. **Document** policy compliance in commits

## 📝 Creating New Policies

New policies must:
- [ ] Have clear, unambiguous language
- [ ] Define consequences of violation
- [ ] Explain rationale
- [ ] Include examples
- [ ] Be approved by team leadership
- [ ] Be communicated to all developers
