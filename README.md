# repo-strapper.template

A comprehensive repository template with agent definitions, file and structure specifications, development guides, guardrails, schemas, and blueprints. Designed to ensure disciplined, consistent development where agents follow strict architectural and quality paths.

---

## 🎯 Purpose

This template provides a complete framework for **AI-assisted development** that enforces:
- **Consistent structure** — All files follow defined patterns
- **Explicit schemas** — Types and definitions are clear and extensible
- **Institutional knowledge** — Lessons learned persist in organized corpus
- **Mandatory policies** — Critical rules are enforced, not suggested
- **Custom configurations** — Teams can adapt behavior to their goals

Instead of chaotic, ad-hoc development, every agent follows a defined path.

---

## 📁 Directory Structure

```
.
├── .agent/                       # Complete agent framework (new)
│   ├── README.md                 # System overview and usage
│   ├── config.md                 # User-customizable behavior & templates
│   ├── schema.md                 # Type definitions & structure requirements
│   └── corpus/                   # Organized knowledge base
│       ├── design/               # Architecture patterns & decisions
│       ├── development/          # Code patterns & workflows
│       ├── knowledge/            # Domain concepts & specifications
│       ├── qa/                   # Quality standards & reviews
│       ├── testing/              # Test strategies & frameworks
│       ├── guardrails/           # Lessons learned & incidents
│       └── policies/             # Mandatory rules & gates
└── [your-project-files]
```

---

## 🚀 What's New: `.agent/` Directory

The `.agent/` directory is the complete framework for agent-guided development. It contains everything an AI agent needs to understand and follow your project's development philosophy.

### Core Components

#### 1. **`.agent/README.md`** — System Overview
A complete guide to the agent system explaining:
- The three-pillar architecture (Definitions, Configurations, Corpus)
- How agents use each component
- File evolution strategy
- Integration points

**Use this to:** Understand how the agent system works and how all pieces fit together.

---

#### 2. **`.agent/config.md`** — User Configuration & Templates
Customizable settings that define your team's development approach.

**Contains:**
- **Default behavior** — Language, formatting, architecture choice (monorepo, microservices, etc.)
- **User-defined templates** — Recurring patterns (Feature workflow, API endpoint template, DB migration template)
- **Style presets** — Conservative (enterprise), Agile (startup), Bleeding Edge (research), or custom
- **Team customization** — Team name, product goals, blocked patterns, preferred patterns

**Example configuration:**
```markdown
# Language choice
LANGUAGE=typescript

# Architecture philosophy
ARCHITECTURE=monorepo

# Development workflow
WORKFLOW=github-flow
TEST_REQUIRED=strict

# Team customization
TEAM=platform-team
PRODUCT=workflow-builder
```

**Use this to:** Define how YOUR team builds, what patterns you prefer, what anti-patterns to avoid.

---

#### 3. **`.agent/schema.md`** — Type System & Structure Definitions
The authoritative definition of how code is organized and typed.

**Defines:**
- **Artifact types** — schema, implementation, test, documentation, configuration, workflow, template, script, data
- **File metadata** — REQUIRED fields every file should declare (type, purpose, owner, tags, dependencies)
- **Directory structure pattern** — Standard layout for features and layers
- **Layer definitions** — shared/, core/, features/, services/, handlers/, tests/
- **Naming conventions** — Files (kebab-case), classes (PascalCase), functions (camelCase), constants (UPPER_SNAKE_CASE)
- **Validation rules** — No circular dependencies, single responsibility, dependency direction, export control
- **Type safety rules** — No `any`, strict null checking, explicit return types
- **Lifecycle stages** — 🔵 DESIGN → 🟠 EXPERIMENTAL → 🟢 STABLE → 🔴 DEPRECATED
- **Documentation requirements** — README.md structure, JSDoc comments, file headers

**Example file structure:**
```typescript
/**
 * @type implementation
 * @purpose User authentication service for JWT validation
 * @owner backend-team
 * @tags auth, jwt, middleware
 * @dependencies ../types/user.ts, ../utils/encryption.ts
 */

export interface AuthConfig { /* ... */ }

export function validateJWT(token: string): AuthResult {
  // implementation
}
```

**Use this to:** Understand what every file should look like, how to organize code, naming rules.

---

#### 4. **`.agent/corpus/`** — Knowledge Organization

A structured, searchable knowledge base organized by development aspect. Every document here survives context rotation and serves as institutional memory.

##### **`.agent/corpus/design/`** — Architecture & Decisions
Pattern libraries, architecture principles, technology decisions, scalability guidelines.

**Documents:**
- Architecture patterns used in the project
- System design guidelines
- Technology choices and rationale (e.g., "Why PostgreSQL + pgvector for embeddings?")
- Performance and scalability considerations
- Integration patterns

**Use before:** Making architectural decisions, designing new systems, choosing technologies.

---

##### **`.agent/corpus/development/`** — Code Patterns & Workflows
Implementation guides, code style conventions, scaffolding templates, common workflows.

**Documents:**
- Code style conventions and best practices
- Step-by-step implementation guides (e.g., "How to create a new API endpoint")
- Scaffolding templates for features, services, handlers
- Development workflows and processes
- Common implementation patterns

**Example template:**
```markdown
### Template: New Feature Workflow

1. Create feature directory: `src/features/{feature-name}/`
2. Create types file: `types.ts` (define interfaces)
3. Create implementation: `index.ts` (core logic)
4. Create tests: `__tests__/index.test.ts`
5. Create documentation: `README.md`
```

**Use when:** Starting a new feature, implementing a service, writing handlers.

---

##### **`.agent/corpus/knowledge/`** — Domain & Business Logic
Domain model documentation, feature specifications, business rules, integration guides.

**Documents:**
- Core business concepts and entities
- Feature requirements and specifications
- Business rules that constrain implementation
- Integration points with external systems
- Data model and relationships

**Use before:** Implementing features, working with external APIs, applying business rules.

---

##### **`.agent/corpus/qa/`** — Quality Standards & Reviews
Code review checklists, quality metrics, performance benchmarks, accessibility requirements.

**Documents:**
- Quality standards your code must meet
- Code review guidelines and checklist
- Performance targets and benchmarks
- Accessibility requirements (WCAG compliance, etc.)
- Security review checklist

**Use before:** Submitting code for review, optimizing performance.

---

##### **`.agent/corpus/testing/`** — Test Strategies & Frameworks
Testing approaches, test patterns, test fixtures, automation setup.

**Documents:**
- Overall testing strategy (unit/integration/e2e balance)
- Unit test patterns and naming conventions
- Integration test approaches
- Shared test data and fixtures
- Test automation and CI/CD setup

**Use when:** Writing tests, setting up test data, debugging test failures.

---

##### **`.agent/corpus/guardrails/`** — Lessons & Incidents
Documented lessons learned, common pitfalls, incident postmortems, performance bottlenecks.

**Inspired by Ralph** — a system where context is ephemeral but knowledge persists in files.

**Documents:**
- Problems we've solved and how
- Common pitfalls and solutions
- Production incident analysis
- Performance issues discovered and fixed
- Architecture decisions explained

**Example guardrail:**
```markdown
### ⚠️ Wrangler Must Bind to 0.0.0.0 in Docker

**Problem:** Cloudflared can't reach Wrangler on 127.0.0.1 in containers

**Solution:**
const isDocker = process.env.COOLIFY_CONTAINER_NAME !== undefined;
if (isDocker) {
  wranglerArgs.push('--ip', '0.0.0.0');
}

**File:** packages/backend/src/services/wrangler-dev.service.ts
**Date Learned:** 2026-01-15
```

**Use before:** Major decisions, integrating complex systems, scaling.

---

##### **`.agent/corpus/policies/`** — Mandatory Rules & Gates
REQUIRED policies that govern all development. Unlike guidelines, policies are enforced.

**Documents:**
- Feature development policy (how features graduate from experimental → stable)
- Security requirements and authentication standards
- Mandatory code review process
- Deployment procedures and gates
- Data handling and privacy policies

**Example policy:**
```markdown
### Policy: All New Features Start in Experimental

Before writing ANY implementation code in main packages, 
every new feature must be documented and registered in 
packages/experimental-features/<feature-name>/.

Graduation criteria (all required):
- Complete spec (README + docs/)
- No architectural blockers
- Product sign-off
- Implementation plan / tickets created
```

**CRITICAL:** Agents must follow these unconditionally.

---

## 🔄 How Agents Use This System

### On Initialization
1. Read `.agent/README.md` to understand the system
2. Read `.agent/config.md` to understand team preferences
3. Scan `.agent/corpus/policies/` for mandatory requirements

### During Development
1. Reference `.agent/corpus/design/` for architecture
2. Reference `.agent/corpus/development/` for patterns
3. Check `.agent/corpus/guardrails/` before major decisions
4. Follow `.agent/corpus/policies/` unconditionally

### On Task Completion
1. Update `.agent/corpus/guardrails/` with new lessons
2. Update `.agent/corpus/development/` with reusable patterns
3. Update `.agent/config.md` if adding new templates

---

## 📊 Complete Feature Breakdown

### `.agent/` System Components

| Component | Purpose | Usage | Frequency |
|-----------|---------|-------|-----------|
| README.md | System overview | Reference | Daily |
| config.md | Team customization | Set up once, update rarely | Onboarding + quarterly |
| schema.md | Type definitions | Reference during development | Every feature |
| corpus/design/ | Architecture patterns | New systems/architecture | Quarterly review |
| corpus/development/ | Code patterns | Implementing features | Daily |
| corpus/knowledge/ | Domain/business logic | Feature implementation | Daily |
| corpus/qa/ | Quality standards | Before code review | Every commit |
| corpus/testing/ | Test strategies | Writing tests | Daily |
| corpus/guardrails/ | Lessons learned | Before major decisions | As needed |
| corpus/policies/ | Mandatory rules | Every development cycle | Daily |

---

## 🎯 Key Principles

### 1. Schema-First Development
All code is structured and typed according to `.agent/schema.md`. This ensures consistency across the project.

### 2. Configuration-Driven
Behavior is customizable in `.agent/config.md`. Different teams, products, and goals have different configurations without changing core schemas.

### 3. Knowledge-Driven
Every decision, lesson, and pattern is documented in `.agent/corpus/`. This survives context rotation and prevents repeated mistakes.

### 4. Policy-Driven
Critical rules are in `.agent/corpus/policies/` and are MANDATORY, not optional guidelines.

### 5. Externally Guided
Agents don't guess or improvise—they follow explicit definitions, configurations, and policies.

---

## 🚀 Getting Started

### 1. Customize Configuration
Edit `.agent/config.md`:
- Choose your language, framework, and architecture
- Select or create a style preset
- Add team-specific templates
- Define blocked and preferred patterns

### 2. Review Policies
Read `.agent/corpus/policies/` to understand mandatory requirements.

### 3. Explore Corpus
Browse `.agent/corpus/` to understand:
- Your team's design principles
- Common development patterns
- Quality standards
- Past lessons and decisions

### 4. Start Development
Follow patterns in `.agent/corpus/development/` for new features.

### 5. Add Knowledge
After solving problems, add guardrails to `.agent/corpus/guardrails/`.

---

## 📖 Example: Creating a New Feature

1. **Check `.agent/config.md`** — What templates apply?
2. **Read `.agent/corpus/development/`** — What pattern should I follow?
3. **Check `.agent/corpus/guardrails/`** — Have we solved this before?
4. **Follow `.agent/schema.md`** — Structure the feature correctly
5. **Implement** — Write code following `.agent/corpus/development/` patterns
6. **Test** — Use patterns from `.agent/corpus/testing/`
7. **Review** — Check `.agent/corpus/qa/` review checklist
8. **Add guardrails** — Document lessons for next time

---

## 🔐 Policy Enforcement

Some rules are MANDATORY (in `.agent/corpus/policies/`):
- Feature development must follow graduation stages
- Security requirements are non-negotiable
- Code review is required
- Deployments follow gates
- Data handling complies with privacy rules

Agents should flag violations of these policies before approval.

---

## 💡 Design Inspiration

This system draws from several proven approaches:

- **Ralph Technique** — Context-ephemeral knowledge persistence through files
- **Schema-First Design** — Types and definitions as source of truth
- **Conway's Law** — Structure matches communication patterns
- **Domain-Driven Design** — Business concepts in code
- **Architectural Decision Records** — Why, not just what

---

## 🤝 Contributing to This Template

### Adding to Corpus

When you discover something worth documenting:

1. **Lessons learned** → Add to `.agent/corpus/guardrails/`
2. **Useful patterns** → Add to `.agent/corpus/development/`
3. **Architecture decisions** → Add to `.agent/corpus/design/`
4. **Business rules** → Add to `.agent/corpus/knowledge/`

### Updating Configuration

When your team establishes new standards:

1. Update `.agent/config.md` with new preferences
2. Document in comments why this preference exists
3. Provide template examples

### Evolving Schema

When your system grows:

1. Extend `.agent/schema.md` (don't remove required fields)
2. Create `schema-extensions.md` if major changes
3. Communicate changes to team

---

## 📚 Additional Resources

- `.agent/README.md` — System overview and usage patterns
- `.agent/config.md` — Configuration and team customization
- `.agent/schema.md` — Complete type system and structure definitions
- `.agent/corpus/*/README.md` — Each corpus section has detailed guidance

---

## ✨ Summary

This repository template provides:
- ✅ **Explicit structures** — No guessing how to organize code
- ✅ **Extensible schemas** — Define requirements, allow customization
- ✅ **Reusable templates** — Common patterns ready to go
- ✅ **Institutional memory** — Lessons persist across context windows
- ✅ **Policy enforcement** — Mandatory rules are non-negotiable
- ✅ **Configuration flexibility** — One template, many configurations

**Result:** AI agents (and humans!) can develop consistently, efficiently, and effectively—following proven paths, learning from past decisions, and building on established patterns.
