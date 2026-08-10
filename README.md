# Archive Engine

A TypeScript governance layer for important documents: upload a published document, draft an edit, submit it as a proposed change, review the redline, and approve it into the official published version — with a permanent audit trail.

The project is a small monorepo with an Express API, a React/Vite frontend, a worker process, Prisma/PostgreSQL persistence, and an S3-compatible storage package designed to work with MinIO locally.

## Status

Feature-complete for plain text, Markdown, and Word (`.docx`) documents. The full governance loop works end to end — draft → proposed change → redline review → approve → publish — for text-based source documents, covered by integration tests and exposed in the React frontend. DOCX files use a clean HTML preview and open in the native ONLYOFFICE editor when editing; the edited Word artifact is preserved for publication, while a Markdown extraction remains available for search and redline support. PDF is an export format, not an editable source format.

Deliberately out of scope: PDF editing, rich-text/visual redlines, full-fidelity Word track-changes redlines, collaborative editing, multi-stage approval rules, notifications, folders, and rollback to a prior version.

## Features

- Express API with request IDs and structured error handling
- User registration and login with hashed passwords
- JWT access tokens and refresh-token session storage
- Workspace creation, listing, and per-workspace roles: admins manage membership, reviewers do everything else (a user can be admin in one workspace and reviewer in another)
- Workspace dashboard: member list with contribution counts and recent activity feed
- Document upload, versioning, browser preview, and download for plain text, Markdown, and Word (`.docx`) source files
- Clean HTML DOCX previews plus native ONLYOFFICE Docs Community editing; original and edited DOCX artifacts remain preserved for publication
- PDF export for published Markdown versions; PDF upload/editing is intentionally rejected
- Governance workflow: draft → proposed change → line-diff redline review → approve → publish as a new immutable version; every publish creates a new `DocumentVersion` row
- Edit lock: one active draft or proposed change per document at a time, enforced by a partial unique index rather than application code. `withdraw` returns it to a draft; `discard` closes it for good
- Markdown formatting toolbar (Bold / Italic / Heading / Bullet) for markdown-flavored drafts
- Inline line comments anchored to specific diff lines on a proposed change
- Export as PDF for published plain text and Markdown versions (`markdown-it` + `pdfkit`). Word is excluded: converting it faithfully needs a real converter, and the ONLYOFFICE editor exports to PDF itself
- Authors cannot approve *or* request changes on their own proposed change — a review is a verdict recorded against a reviewer. They get `withdraw` instead, which returns the work to a draft without recording a review. Archiving a document is admin-only
- Postgres full-text search over published versions: generated `tsvector` columns with GIN indexes, `websearch_to_tsquery`, title weighted above body, one result per document, and `ts_headline` snippets returned with inert delimiters so the client renders its own highlights
- Full audit trail covering every governance event (draft, propose, review, publish, withdraw, discard, task, export, comment), with the document named on each entry
- Document tasks: any member can attach a freeform task with an assignee to a document
- React/Vite frontend: workspaces landing page, per-workspace dashboard/documents/search tabs, full-page document view with diff viewer, formatting toolbar, tasks, and version history with author labels
- Prisma schema for users, workspaces, memberships, documents, versions, drafts, proposed changes, reviews, line comments, tasks, blobs, search records, audit logs, sessions, and jobs
- PostgreSQL database with Prisma migrations
- MinIO/S3-compatible blob storage helper package
- Background worker with job claiming, locking, retry state, and graceful shutdown
- Docker Compose setup for PostgreSQL, MinIO, and ONLYOFFICE Docs Community

## Tech Stack

- TypeScript
- Node.js
- Express
- Prisma
- PostgreSQL
- MinIO / S3-compatible storage
- JWT
- bcrypt
- Zod
- Docker Compose

## Monorepo Structure

```text
api/                 Express API service
web/                 React/Vite frontend
web/src/features/    Screens grouped by domain: auth, documents, review, workspaces, tasks
web/src/components/  Shared presentational components and UI primitives
web/src/lib/         Formatting helpers, shared constants and types
web/e2e/             Playwright end-to-end tests
worker/              Background job worker
packages/db/         Prisma schema, migrations, and Prisma client export
packages/storage/    S3-compatible blob storage helpers
docs/product/        Vision, milestones, glossary, and open product questions
docker-compose.yml   Local PostgreSQL and MinIO services
.env.example         Example local environment variables
```

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Start PostgreSQL and MinIO:

```bash
docker compose up -d
```

Generate the Prisma client:

```bash
npm run db:generate
```

Run database migrations:

```bash
npm run db:migrate
```

Start the API, worker, and web frontend together:

```bash
npm run dev
```

This runs all three processes concurrently in one terminal (via `concurrently`) so the worker
can't be forgotten — without it running, uploads and publishes still succeed but search
indexing jobs just pile up and search silently goes stale. Each process can still be run on its
own in a separate terminal when that's more convenient:

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

**Production note:** `npm run dev` is a local convenience only. It is not added to
`docker-compose.yml` because there is no Dockerfile for the worker yet, and mounting host
`node_modules` into a container would break Prisma's platform-specific query engine binaries.
Building a proper worker container image is the production answer for keeping it running
continuously, and is out of scope for now.

## Tests

```bash
npm run typecheck   # api and web
cd api && npx vitest run          # 26 integration tests against a real Postgres
npm run test:e2e                  # 6 Playwright tests driving the real UI
```

The API tests are integration tests, not unit tests: they run against the database and object
storage from `docker compose`, so they exercise the transactions, the partial unique index and
the migrations rather than mocks of them.

The Playwright suite covers the whole governance loop — an author edits a document, proposes the
change, a second person reviews the diff and approves, and version 2 appears — plus search
highlighting and the rule that draft controls never appear to someone who cannot use them. It
spawns the worker itself, because search results only exist once a version has been indexed.

## Environment Variables

```text
DATABASE_URL=postgresql://archive:archive_password@localhost:5433/archive_db

MINIO_ENDPOINT=http://localhost:9000
MINIO_ROOT_USER=archive_minio
MINIO_ROOT_PASSWORD=archive_minio_secret
MINIO_BUCKET=archive-blobs

PORT=3000

JWT_ACCESS_SECRET=your_access_token_secret
JWT_REFRESH_SECRET=your_refresh_token_secret

ONLYOFFICE_URL=http://localhost:8080
EDITOR_PUBLIC_API_URL=http://host.docker.internal:3000
ONLYOFFICE_JWT_SECRET=your_onlyoffice_jwt_secret
```

The values in `.env.example` are placeholders for local development. Do not commit real secrets.

## API Overview

Current route groups include:

```text
GET  /health/db
POST /v1/auth/register
POST /v1/auth/login
POST /v1/auth/refresh
POST /v1/auth/logout
GET  /v1/workspaces
POST /v1/workspaces
GET  /v1/workspaces/:workspaceId/members
POST /v1/workspaces/:workspaceId/members
GET  /v1/workspaces/:workspaceId/dashboard
GET  /v1/workspaces/:workspaceId/audit-logs
GET  /v1/workspaces/:workspaceId/documents
POST /v1/workspaces/:workspaceId/documents
GET  /v1/workspaces/:workspaceId/documents/search
GET  /v1/workspaces/:workspaceId/documents/:documentId
PATCH  /v1/workspaces/:workspaceId/documents/:documentId
DELETE /v1/workspaces/:workspaceId/documents/:documentId  (admin only)
GET  /v1/workspaces/:workspaceId/documents/:documentId/versions/:version/download
GET  /v1/workspaces/:workspaceId/documents/:documentId/versions/:version/export-pdf
POST /v1/workspaces/:workspaceId/documents/:documentId/drafts
GET  /v1/workspaces/:workspaceId/documents/:documentId/drafts/:draftId
GET  /v1/workspaces/:workspaceId/documents/:documentId/drafts/:draftId/editor-config
POST /v1/workspaces/:workspaceId/documents/:documentId/drafts/:draftId/editor/force-save
PATCH /v1/workspaces/:workspaceId/documents/:documentId/drafts/:draftId
GET  /v1/workspaces/:workspaceId/documents/:documentId/versions/:version/editor-config
POST /v1/workspaces/:workspaceId/documents/:documentId/drafts/:draftId/propose
GET  /v1/workspaces/:workspaceId/documents/:documentId/proposed-changes/:proposedChangeId
POST /v1/workspaces/:workspaceId/documents/:documentId/proposed-changes/:proposedChangeId/reviews
POST /v1/workspaces/:workspaceId/documents/:documentId/drafts/:draftId/discard
POST /v1/workspaces/:workspaceId/documents/:documentId/proposed-changes/:proposedChangeId/withdraw
POST /v1/workspaces/:workspaceId/documents/:documentId/proposed-changes/:proposedChangeId/abandon
POST /v1/workspaces/:workspaceId/documents/:documentId/proposed-changes/:proposedChangeId/comments
GET  /v1/workspaces/:workspaceId/documents/:documentId/tasks
POST /v1/workspaces/:workspaceId/documents/:documentId/tasks
PATCH /v1/workspaces/:workspaceId/documents/:documentId/tasks/:taskId
```

The protected workspace routes expect a bearer access token:

```text
Authorization: Bearer <access-token>
```

## Notes

This project is intended to demonstrate product and system design for a document governance workflow: versioned/audited data modeling, a redline diff engine, draft/proposed-change state machines, and role-based access control. It is not production-ready yet.

Before production use, it would need production secret management, deployment configuration, encryption at rest, and a full security review. Basic rate limiting, security headers (helmet), and `trust proxy` configuration are in place — see `api/src/app.ts` and `api/src/middleware/rateLimit.ts`. See [future.md](future.md) for deferred items and rationale.
