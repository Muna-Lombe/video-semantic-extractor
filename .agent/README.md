# Agent Configuration & Development Guidelines

This directory contains the complete framework for AI agent development, including definitions, guardrails, schemas, and a structured knowledge corpus. Every element is organized to ensure consistent, guided development.

## 📁 Directory Structure

```
.agent/
├── README.md              # This file - explains the complete system
├── config.md              # Agent behavior configuration and user-defined templates
├── schema.md              # Type definitions and structure schemas
└── corpus/                # Organized knowledge base
    ├── design/            # Design patterns, architecture guidelines
    ├── development/       # Development practices, code patterns
    ├── knowledge/         # Domain knowledge, business logic
    ├── qa/                # Quality assurance, testing strategies
    ├── testing/           # Test frameworks, test specifications
    ├── guardrails/        # Lessons learned, common pitfalls
    └── policies/          # Mandatory rules and processes
```

## 🎯 Core Concepts

This agent system is built on three pillars:

### 1. **Definitions** (schema.md)
Fixed, required type definitions that provide the foundation. Users expand these but cannot remove core elements.

### 2. **Configurations** (config.md)
User-defined settings for product-specific behavior, development style, and workflow orchestration.

### 3. **Corpus** (corpus/)
Organized, searchable knowledge base organized by aspect of development.

---

## 📖 File Descriptions

### `README.md` - System Overview
**This file.** Describes the overall organization and how to use the agent system.

### `config.md` - User Configuration
- Agent behavior rules and customization
- Product-specific style guides
- User-defined templates for common patterns
- Workflow orchestration settings
- Team/org-level defaults

**When to update:**
- After defining team coding standards
- When establishing product-specific patterns
- When onboarding new team members
- When changing development workflow

### `schema.md` - Type Definitions
- Base type declarations for agent actions
- File and directory structure definitions
- Required fields and optional extensions
- Naming conventions and patterns
- Validation rules

**When to update:**
- When introducing a new artifact type
- When expanding architecture patterns
- When adding new development practices

### `corpus/` - Knowledge Organization

Each subdirectory represents a development aspect:

#### `design/`
- Architecture patterns and principles
- System design guidelines
- Technology decisions and rationale
- Scalability considerations

#### `development/`
- Code style and conventions
- Development workflows
- Scaffolding templates
- Common implementation patterns

#### `knowledge/`
- Domain-specific knowledge
- Business logic documentation
- Feature specifications
- Integration points

#### `qa/`
- Quality standards and metrics
- Code review checklists
- Performance benchmarks
- Accessibility requirements

#### `testing/`
- Unit testing strategies
- Integration testing approaches
- Test data and fixtures
- Test automation frameworks

#### `guardrails/`
- Documented lessons learned
- Common pitfalls and solutions
- Incident postmortems
- Performance bottlenecks

#### `policies/`
- Mandatory development rules
- Security requirements
- Compliance standards
- Process gates and checkpoints

---

## 🚀 How Agents Use This System

### On Initialization
1. Read `schema.md` to understand required artifact types
2. Read `config.md` to understand product-specific rules
3. Scan `corpus/policies/` for mandatory requirements

### During Development
1. Reference `corpus/design/` for architecture decisions
2. Reference `corpus/development/` for code patterns
3. Check `corpus/guardrails/` before major decisions
4. Follow `corpus/policies/` rules strictly

### On Task Completion
1. Update `corpus/guardrails/` with new lessons
2. Update `corpus/development/` with patterns if reusable
3. Update `config.md` if adding new templates

---

## 📋 File Creation Checklist

When creating a new rule document in `corpus/`:

- [ ] Add clear title with emoji indicator
- [ ] Include problem statement or motivation
- [ ] Provide concrete solution/pattern
- [ ] List affected files or components
- [ ] Include date learned/created
- [ ] Add examples where helpful
- [ ] Link to related documents
- [ ] Include "when to use" and "when not to use"

---

## 🔄 Evolution Strategy

This system evolves through:
1. **Experience**: Lessons from actual development become guardrails
2. **Patterns**: Repeated solutions become policies
3. **Standards**: Proven patterns become requirements in schema

Maintain this repo as the single source of truth for "how we build here."
