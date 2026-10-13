# ADR 0004 — JSDoc + `checkJs` typecheck ratchet, not a TypeScript migration

- **Status:** Accepted
- **Date:** 2026-09-29
- **Deciders:** Backend team
- **Recorded by:** [M01 — Core kernel](../milestones/M01-core-kernel.md); enforced in [M08](../milestones/M08-delivery-ops.md)

## Context

The backend was TypeScript and was converted to plain `.js`. `tsconfig.json`, `tsc`, `tsx` and
every `@types/*` package were deleted in the conversion. The stated reason was that the type
annotations had drifted far enough from reality that the checker was failing on files nobody could
fix in the same commit.

What was actually lost:

| Lost | Consequence today |
|---|---|
| Any compile-time check | `node --check` parses; it cannot see a typo in an object key or a wrong arity |
| A local `tsx watch` | `node --watch` only restarts on files Node can parse, so a syntax error surfaces as a boot failure rather than a watch error |
| `@types/express` | Express 4's `Request`/`Response` are untyped, so `req.user`, `res.ok` and `req.query` are invisible to any checker |
| `strict` null checking | `const page = Number(req.query.page) \|\| 1` type-checks fine and still reads `"abc"` as `NaN` |

Revisiting TypeScript is the obvious response, and it was rejected once already
([ADR 0001](0001-modular-monolith.md)). But "no static safety at all" is the wrong end of the
range, and the honest problem is not the language — it is that a checker applied uniformly to
5,200 lines of unannotated JavaScript produces thousands of errors on day one, which gets the
checker switched off again. That is what happened the first time.

## Decision

**Keep plain CommonJS. Add static checking incrementally, from the outside in, with two
overlapping configs so the codebase gets strictly more checked over time and never less.**

Two files, both `noEmit`:

### `tsconfig.json` — the gate

Covers only the code written *after* this decision:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "checkJs": true,
    "noEmit": true,
    "target": "ES2023",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": [
    "src/config/**/*",
    "src/core/**/*",
    "src/platform/**/*",
    "src/bootstrap/**/*",
    "src/shared/**/*",
    "src/modules/**/*",
    "src/app.js",
    "src/server.js"
  ]
}
```

**Blocking.** Zero tolerance: a `tsc --noEmit` failure fails CI.

### `tsconfig.legacy.json` — the ratchet

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "strict": false },
  "include": ["src/routes/**/*", "src/services/**/*", "src/middleware/**/*"]
}
```

**Advisory only.** Not in CI's blocking path. Its job is to *report*, so that when a service is
migrated in M03-M06 its error count is visible before and after. `src/lib/` is gone as of M01;
`src/routes`, `src/services` and `src/middleware` are the whole remainder. **When it reaches zero
errors, delete it.** A config that has been green for a release is a config nobody reads.

### The ratchet rule

> Any file already inside the gate must stay inside the gate. Any file brought into the gate must
> be error-free when it arrives.

There is no third bucket and no per-file opt-out. The gate's `include` list is the definition of
"code written after M01", so the two configs never overlap by accident.

### What "typed" means here

`checkJs` infers from JSDoc, and inference over an untyped dependency is where it gets expensive:
`skipLibCheck: true` and `types: []` keep `@types/node` and nothing else, and Express is handled
with hand-written declaration stubs in `src/types/` rather than by installing `@types/express`
across the codebase. Four dependencies — express, prom-client, pino, supertest — need a stub; the
rest are plain JS with their own typings or are structurally trivial.

## Consequences

**Accepted costs**

- Two config files to keep in sync, and a disagreement between them is a real hazard. Mitigated by
  `tsconfig.legacy.json` extending the other, so it inherits and only overrides `strict`.
- JSDoc annotations are not enforced by any editor today. Nothing stops a new file shipping without
  them, which makes `strict` complain about implicit `any` and fail the gate. That is the intended
  pressure.
- Type errors are reported at the *shape* level. `checkJs` will not catch that `Property.price` is
  a `VarChar(100)` being compared as a number ([M00 finding
  #10](../milestones/M00-safety-net.md)) — no type system sees that. M05's data migration does.
- `@types/node` alone means `process`, `Buffer` and the stream types are available and Express is
  not. The stub files are real maintenance.

**Gains**

- `src/core/`, `src/config/`, `src/platform/`, `src/app.js` and `src/server.js` — every primitive
  M01 introduces — are checked in strict mode from the first commit. The kernel does not rot.
- Legacy errors are visible and countable, so "we improved" is measurable rather than asserted.
- The exit door stays open. If the team later decides to convert, `checkJs` errors are exactly the
  work list, and the gate's `include` list is the conversion order.
- No build step, no `dist/`, no `tsx`. `src/` is still what runs. Preserved
  ([ADR 0001](0001-modular-monolith.md), [`docs/README.md`](../README.md)).

**Not decided here**

- Whether the gate runs in CI before or after `node --test`. [M08](../milestones/M08-delivery-ops.md)
  sequences the whole pipeline; this ADR only fixes *what* is checked and *how strictly*.
- Whether `src/shared/` (pure functions, no I/O) survives as a directory or is deleted as an empty
  concept. It has no files yet.

**Rejected**

| Option | Why not |
|---|---|
| Convert to TypeScript now | The project that already failed once. Nine modules, an entangled model graph and a frozen API contract is the worst possible time to start it. M00/M01 delivered more risk reduction per hour. |
| One `tsconfig.json` over `src/`, `strict: true`, and fix the errors | Day one produces a diff of thousands of errors against a frozen HTTP contract, and the natural response is to raise `strict` back to `false`. The second failure, and the last one. |
| `checkJs` with `strict: false` everywhere | Type-checks that cannot find a null dereference, which is the class of bug that actually reaches production in an Express handler. The strictness is the point. |
| ESLint only | `pnpm lint` cannot run today and is fixed in M08. Type *shapes* are not a lint concern; `no-undef` catches typos, not a mistyped service contract. |
| Keep `checkJs` advisory everywhere | Then nothing is blocking and the checker is allowed to rot. The gate/advisory split is what makes both halves useful. |

## Revisit when

- `tsconfig.legacy.json` reaches zero errors → delete it and make its `include` list part of the
  gate. This is the expected end state by M06.
- The stub files in `src/types/` grow past what JSDoc can carry, or a third team member wants
  `.ts` files → reconsider conversion, with the gate's error list as the work backlog.