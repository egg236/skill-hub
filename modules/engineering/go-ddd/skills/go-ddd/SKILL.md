---
name: go-ddd
description: Guides Go feature work with DDD layers — domain, application use-cases, and adapters. Use when adding or changing Go business logic.
---

# Go DDD

## Goal
Keep business rules in the domain, orchestrate in application use-cases, and push I/O to adapters. This module is a **demo** for skill-hub — adapt names to the target repo.

## Layout (suggested)
```text
internal/
  domain/          # entities, value objects, domain services, repository ports
  application/     # use-cases / commands / queries
  adapters/        # http, db, messaging, clocks, UUIDs
cmd/               # composition root / main
```

## Rules of thumb
1. **Domain has no framework imports** (no gin/echo/sql driver, no ORM tags as source of truth).
2. Express invariants on aggregates; prefer small value objects over primitive obsession.
3. Repository **interfaces** live next to the domain that needs them; implementations live in adapters.
4. Application layer: one use-case = one entrypoint; transaction boundary starts here.
5. Adapters translate DTOs ↔ domain; never leak transport types into domain.
6. Tests: domain pure unit tests first; use-cases with fakes; adapters with integration tests when useful.

## When changing code
1. Name the aggregate / use-case you touch.
2. Put new business rules in domain (or explain why they cannot live there).
3. Keep handlers thin: parse → call use-case → map errors/status.
4. Do not introduce a shared "models" dump that mixes DB and API shapes.

## Out of scope
Frontend, infra-as-code, and unrelated refactors.
