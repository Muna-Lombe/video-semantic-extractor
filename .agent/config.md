# Agent Configuration

This file contains default agent behavior settings and user-defined templates. Customize these to match your product's development philosophy and goals.

## 🎯 Default Behavior

### Code Style & Conventions
```md
# Define your defaults (comment these and uncomment your choice)

# Language: Choose your primary language(s)
# LANGUAGE=typescript
# LANGUAGE=python
# LANGUAGE=go
# LANGUAGE=rust

# Formatting: Choose your code formatter
# FORMATTER=prettier  # JavaScript/TypeScript
# FORMATTER=black     # Python
# FORMATTER=gofmt     # Go
# FORMATTER=rustfmt   # Rust

# Naming Conventions: Choose your preference
# NAMING=camelCase    # JavaScript/TypeScript
# NAMING=snake_case   # Python, Go
# NAMING=PascalCase   # Rust, C#
```

### Architecture Philosophy
```md
# Choose your architectural patterns
# ARCHITECTURE=monolithic     # Single codebase, single deployment
# ARCHITECTURE=microservices  # Distributed services
# ARCHITECTURE=monorepo       # Single repo, multiple packages
# ARCHITECTURE=domain-driven  # DDD principles
```

### Development Workflow
```md
# Define your development workflow
# WORKFLOW=trunk-based      # Continuous integration to main
# WORKFLOW=gitflow          # Feature branches → develop → main
# WORKFLOW=github-flow      # Feature branches → main with PR

# Testing requirement level
# TEST_REQUIRED=strict      # All code must have tests
# TEST_REQUIRED=moderate    # New features require tests
# TEST_REQUIRED=minimal     # Tests encouraged but optional
```

---

## 📋 User-Defined Templates

Create templates for recurring patterns in your product. These become shortcuts for common development tasks.

### Example 1: Feature Development Template
```md
### Template: New Feature Workflow

**Steps:**
1. Create feature directory: `src/features/{feature-name}/`
2. Create types file: `types.ts` (define interfaces)
3. Create implementation: `index.ts` (core logic)
4. Create tests: `__tests__/index.test.ts`
5. Create documentation: `README.md`
6. Export from main: `src/index.ts`

**Files to create:**
- `src/features/{feature-name}/types.ts`
- `src/features/{feature-name}/index.ts`
- `src/features/{feature-name}/__tests__/index.test.ts`
- `src/features/{feature-name}/README.md`

**Configuration points:**
- Adjust test framework based on FORMATTER setting
- Adjust naming based on NAMING convention
```

### Example 2: API Endpoint Template
```md
### Template: New API Endpoint

**Pattern:**
```typescript
// File: src/routes/{resource}.ts
export const {resource}Routes = new Hono()
  .get('/', handler)        // List
  .post('/', handler)       // Create
  .get('/:id', handler)     // Get one
  .put('/:id', handler)     // Update
  .delete('/:id', handler); // Delete
```

**Security checklist:**
- [ ] Authentication middleware
- [ ] Authorization checks
- [ ] Input validation
- [ ] Rate limiting
- [ ] Error handling
```

### Example 3: Database Migration Template
```md
### Template: Database Schema Change

**Process:**
1. Define change in `schema.ts` (ORM schema)
2. Generate migration: `drizzle-kit generate`
3. Review migration file
4. Test locally
5. Document breaking changes
6. Deploy with rollback plan

**Files affected:**
- `src/db/schema.ts` (source of truth)
- `migrations/{timestamp}_description.sql` (generated)
```

---

## 🎨 Style Presets

Choose or create a preset for your team:

### Preset: Conservative (Enterprise)
```md
CODE_STYLE=strict
TEST_COVERAGE=85%
TYPE_CHECKING=strict
DOCUMENTATION=comprehensive
REVIEW_PROCESS=2-approvers
```

### Preset: Agile (Startup)
```md
CODE_STYLE=moderate
TEST_COVERAGE=70%
TYPE_CHECKING=moderate
DOCUMENTATION=essential-only
REVIEW_PROCESS=1-approver
```

### Preset: Bleeding Edge (Research)
```md
CODE_STYLE=experimental
TEST_COVERAGE=variable
TYPE_CHECKING=loose
DOCUMENTATION=live-docs
REVIEW_PROCESS=async-feedback
```

### Custom Preset
```md
# Create your own by copying a preset and modifying values
```

---

## 🔧 Team Customization

### Your Team Name & Goals
```md
TEAM=your-team-name
PRODUCT=your-product-name
GOALS=
  - Goal 1: Brief description
  - Goal 2: Brief description
  - Goal 3: Brief description
```

### Blocked Patterns (Things we explicitly don't do)
```md
BLOCKED_PATTERNS:
  - Pattern 1: Why we avoid it
  - Pattern 2: Why we avoid it
```

### Preferred Patterns (Things we always use)
```md
PREFERRED_PATTERNS:
  - Pattern 1: Why we prefer it
  - Pattern 2: Why we prefer it
```

---

## 📝 How to Use This File

1. **On project initialization**: Uncomment and customize the defaults
2. **Add team templates**: Document your recurring patterns
3. **Choose a preset**: Or define your own
4. **Reference during development**: When starting a new task, check relevant template
5. **Keep updated**: Add new templates as patterns emerge

---

## ⚙️ Integration with Agent System

Agents should:
- Read this file at startup
- Apply configured defaults automatically
- Suggest relevant templates for tasks
- Flag violations of BLOCKED_PATTERNS
- Enforce PREFERRED_PATTERNS consistently
