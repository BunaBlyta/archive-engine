# Future Enhancements

Deferred items with rationale. Each was considered and deliberately postponed — not forgotten.


## Security

**Two-factor authentication (2FA)**
Natural extension of the auth system. Not needed for portfolio scope but would add a second layer beyond password + tokens.

**Encryption at rest**
MinIO blobs are stored unencrypted. Real PII or sensitive documents should use server-side encryption. Low risk for portfolio use.

**Malware scanning**
Uploaded files are not scanned. Users could upload malicious files. Acceptable for closed workspaces — not acceptable for a public-facing product.


## Infrastructure

**Horizontal scaling**
API and worker cannot scale independently in the current single-server Docker Compose setup. Would require a load balancer and multiple instances.

**Redis for rate limiting and job queue**
Rate limit counters currently reset on restart. Job queue uses Postgres polling. Both would benefit from Redis at scale — but adding Redis means another service to run and maintain.

**Backup strategy**
No automated database or MinIO backups. Data loss risk on VM failure. Unacceptable for production, acceptable for development and portfolio.

**CI/CD pipeline**
Manual deployment via SSH. GitHub Actions would automate type checking, tests, and deployment on merge to main.


## Features

**Soft deletes**
Documents and versions are hard-deleted. Soft deletes (a `deletedAt` timestamp) would allow recovery and better audit trails.

**Test coverage**
Testing was deferred to prioritize building the core system. Planned: integration tests for auth flow, upload pipeline, workspace isolation, and search. Tooling: Vitest + supertest.

**Token reuse**
Refresh token reuse detection could be strengthened with more granular session chain tracing
Rate limiting on auth endpoints (tracked in FUTURE.md)
