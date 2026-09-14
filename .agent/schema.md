# Agent Schema & Type Definitions

This document defines the core types, structures, and required elements that agents must understand and enforce. It provides a fixed foundation while allowing project-specific extensions.

---

## 🏗️ Core Type System

### 1. Artifact Type Definition

**REQUIRED:** Every file or directory must have a type.

```typescript
type ArtifactType =
  | 'schema'           // Type definitions, interfaces
  | 'implementation'   // Logic, services, handlers
  | 'test'             // Test files
  | 'documentation'    // Docs, guides, specs
  | 'configuration'    // Config files, settings
  | 'workflow'         // Process definitions, pipelines
  | 'template'         // Reusable scaffolds
  | 'script'           // Utilities, automations
  | 'data'             // Static data, fixtures
```

### 2. File Metadata (REQUIRED)

Every project file should have this structure:

```typescript
interface FileMetadata {
  // REQUIRED
  type: ArtifactType;
  purpose: string;           // 1-2 sentence description
  owner?: string;            // Team or person responsible
  
  // OPTIONAL
  version?: string;          // Semantic version
  deprecated?: boolean;      // Is this file deprecated?
  replacedBy?: string;       // If deprecated, what replaces it?
  tags?: string[];           // searchable tags
  dependencies?: string[];   // Files this depends on
}
```

**Implementation:** Add metadata as a file header comment:

```typescript
/**
 * @type implementation
 * @purpose User authentication service for JWT validation
 * @owner backend-team
 * @tags auth, jwt, middleware
 * @dependencies ../types/user.ts, ../utils/encryption.ts
 */
```

### 3. Directory Structure Pattern

**REQUIRED:** Directories must follow this pattern:

```
{layer}/
├── {feature}/
│   ├── types.ts              # Type definitions
│   ├── index.ts              # Main export
│   ├── {feature}.service.ts   # Business logic
│   ├── {feature}.handler.ts   # HTTP handlers (if applicable)
│   ├── __tests__/
│   │   ├── {feature}.test.ts
│   │   └── fixtures.ts
│   └── README.md             # Purpose & usage guide
└── index.ts                  # Layer export
```

**OPTIONAL EXTENSIONS:** Projects may add:
- `constants.ts` — Layer-specific constants
- `utils.ts` — Shared utilities
- `.cursor/` — Editor rules for this layer
- `docs/` — Detailed documentation

---

## 📋 Project Structure Requirements

### Layer Definitions (REQUIRED)

Every project must have these layers:

```
src/
├── shared/           # Shared types, constants, utilities
├── core/             # Core business logic
├── features/         # Feature implementations
├── services/         # External integrations
├── handlers/         # Request handlers (API, CLI, etc.)
├── tests/            # Shared test utilities
└── index.ts          # Main export
```

**REQUIRED in each layer:**
- [ ] `README.md` — Layer purpose and structure
- [ ] `index.ts` — Exports public API
- [ ] `types.ts` OR each file exports types

**OPTIONAL in each layer:**
- `constants.ts` — Layer-specific constants
- `utils.ts` — Shared utilities
- `.cursor/` — Editor rules

### Feature File Requirements (REQUIRED)

Every feature must include:

```typescript
// 1. Types (required)
export interface FeatureName { /* ... */ }

// 2. Implementation (required)
export function featureFunction() { /* ... */ }

// 3. Exports (required)
export * from './types';
export * from './index';

// 4. Tests (required)
// Located in __tests__/{feature}.test.ts

// 5. Documentation (required)
// Located in README.md with:
// - Purpose
// - Usage example
// - Configuration
// - Error handling
```

---

## 🔐 Naming Conventions (REQUIRED)

### File Naming

```
{purpose}.{type}.{extension}

Examples:
  user.types.ts              # Types
  user.service.ts            # Service implementation
  user.handler.ts            # HTTP handler
  user.test.ts               # Tests
  user.constants.ts          # Constants
  user.utils.ts              # Utilities
```

### Variable Naming

```typescript
// Classes: PascalCase
class UserService { }

// Functions: camelCase
function getUserById(id: string) { }

// Constants: UPPER_SNAKE_CASE
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_TIMEOUT = 5000;

// Private: prefix with _
private _internalState: string;
```

---

## 📐 Validation Rules (REQUIRED)

### Code Organization Rules

1. **No circular dependencies** — Files must form a DAG (directed acyclic graph)
2. **Single responsibility** — One file, one purpose
3. **Dependency direction** — Always point toward core (features → core, not core → features)
4. **Export control** — Only export public API; keep implementation private

### Type Safety Rules

1. **No `any` type** (except in exceptional cases with `// @ts-ignore` comment)
2. **Strict null checking enabled**
3. **Required types for all parameters**
4. **Explicit return types for functions**

### Test Rules

1. **Test coverage minimum**: 70% (configurable in config.md)
2. **Test naming**: Describe what is being tested
3. **No test skips** (`.skip` or `.todo`) in main branch
4. **Arrange-Act-Assert pattern**

---

## 🔄 Lifecycle Definitions (REQUIRED)

### Feature Lifecycle Stages

```
🔵 DESIGN
   └─ Spec written, type definitions created, no implementation

🟠 EXPERIMENTAL
   └─ Implementation in progress, in feature branch, not merged

🟢 STABLE
   └─ Merged to main, tested, documented

🔴 DEPRECATED
   └─ Marked for removal, replacedBy points to successor
```

### Deprecation Process

1. Mark file with `@deprecated` in header comment
2. Add `replacedBy` field pointing to successor
3. Update all imports to use successor
4. Wait 2 releases before removal
5. Remove with changelog entry

---

## 🎯 Documentation Requirements (REQUIRED)

Every file must include:

### README.md (Required for directories)

```markdown
# Feature Name

## Purpose
Brief description of what this does.

## Usage
```typescript
import { featureFunction } from './feature';
const result = featureFunction();
```

## Configuration
Any configuration options.

## Error Handling
Possible errors and recovery strategies.

## Dependencies
Internal and external dependencies.

## Future Improvements
Planned enhancements.
```

### Code Comments (Required)

```typescript
/**
 * Comprehensive JSDoc comment with:
 * @param - each parameter documented
 * @returns - what it returns
 * @throws - what exceptions it throws
 * @example - usage example
 */
```

---

## 🔍 Custom Extensions

Projects can extend this schema by:

1. Creating `schema-extensions.md` in project root
2. Adding new artifact types
3. Adding new validation rules
4. Adding custom metadata fields

**MUST NOT:**
- Remove required fields
- Remove required sections
- Violate existing validation rules

---

## ✅ Compliance Checklist

Before committing code, verify:

- [ ] All files have type metadata
- [ ] Directory structure follows pattern
- [ ] Naming conventions are consistent
- [ ] No circular dependencies
- [ ] Tests exist and pass
- [ ] Documentation is complete
- [ ] Types are strict (no `any`)
- [ ] No deprecated code used
