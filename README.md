# Archive Engine

A TypeScript backend prototype for a document archive system with workspaces, authentication, document versioning, blob storage, background jobs, audit logs, and search-indexing foundations.

The project is structured as a small monorepo with an Express API, a worker process, Prisma/PostgreSQL persistence, and an S3-compatible storage package designed to work with MinIO locally.

## Status

This repository is a backend prototype and work in progress. The core data model, authentication/session flow, workspace membership logic, storage package, and worker foundation are present. A production UI and complete document upload/search workflows are not finished yet.

## Features

- Express API with request IDs and structured error handling
- User registration and login with hashed passwords
- JWT access tokens and refresh-token session storage
- Workspace creation, listing, and membership management
- Role-based workspace membership checks
- Prisma schema for users, workspaces, memberships, documents, versions, blobs, search records, audit logs, sessions, and jobs
- PostgreSQL database with Prisma migrations
- MinIO/S3-compatible blob storage helper package
- Background worker foundation with job claiming, locking, retry state, and graceful shutdown
- Docker Compose setup for PostgreSQL and MinIO

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
worker/              Background job worker
packages/db/         Prisma schema, migrations, and Prisma client export
packages/storage/    S3-compatible blob storage helpers
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

Start the API:

```bash
npm run dev:api
```

Start the worker in a second terminal:

```bash
npm run dev:worker
```

## Environment Variables

```text
DATABASE_URL=postgresql://user:password@localhost:5433/archive

MINIO_ENDPOINT=http://localhost:9000
MINIO_ROOT_USER=your_minio_access_key
MINIO_ROOT_PASSWORD=your_minio_secret_key
MINIO_BUCKET=archive-blobs

PORT=3000

JWT_ACCESS_SECRET=your_access_token_secret
JWT_REFRESH_SECRET=your_refresh_token_secret
```

The values in `.env.example` are placeholders for local development. Do not commit real secrets.

## API Overview

Current route groups include:

```text
GET  /health/db
POST /jobs/ping
GET  /jobs/latest
POST /v1/auth/register
POST /v1/auth/login
POST /v1/auth/refresh
POST /v1/auth/logout
POST /v1/workspaces
GET  /v1/workspaces
POST /v1/workspaces/:workspaceId/members
```

The protected workspace routes expect a bearer access token:

```text
Authorization: Bearer <access-token>
```

## Notes

This project is intended to demonstrate backend architecture and system design for an archive/document-management service. It is not production-ready yet.

Before production use, it would need a completed upload/download API, stronger validation coverage, automated tests, production secret management, rate limiting, deployment configuration, and full security review.
