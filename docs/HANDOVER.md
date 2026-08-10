# Archive Engine — where things stand

Written at the end of a long session so you can pick this up cold. Everything below is on
`main`, pushed to `origin/main` at `5f0b3b0`.

---

## 0. The state the app is in

**Short version: the core product works end to end and is demo-ready. It is not deployable, and
it assumes everyone already has an account.**

### Works, and verified by hand

- Sign up, sign in, stay signed in
- Create a workspace; admins add other people to it
- Upload a document — plain text, Markdown or Word. Contents are checked, so a spreadsheet
  renamed to `.docx` is rejected rather than breaking later
- **The full loop:** open a draft, edit it, propose it with a summary, a second person reviews
  the line-by-line diff and comments on specific lines, approves, and a new version is published
- Word documents edit in a real Word editor in the browser (ONLYOFFICE)
- Full-text search across every published version, with matches highlighted
- Version history, downloads, PDF export for Markdown
- Tasks assigned to people on a document, a workspace dashboard, and a complete audit log

An automated test drives the whole governance loop with two real users, so "it works" is
checked on every run rather than remembered.

### Rough edges a demo might hit

- Clicking pagination or re-running a search very quickly can briefly show the previous result
  set — responses aren't cancelled, so a slower one can land last
- Search result ordering is untuned. It ranks title matches above body matches, but that
  weighting has never been tested against more than a handful of documents
- The Markdown editor is a large download and takes a moment the first time it opens

### Not built yet

- **No invitations.** Adding someone to a workspace only works if they have already registered
  themselves. There is no invite email, because there is no email of any kind
- **No password reset.** A forgotten password means a new account
- **No notifications** — you find out something needs review by looking
- **Not deployable.** It runs locally. The background worker has no container image, so there is
  no way to ship it as-is
- PDFs can be stored and read but not edited or proposed against

### What that means practically

It is a working product for a small team on one machine, and a strong demo. It is not something
you could hand to a customer this week — the missing pieces are account plumbing (invites,
resets, email) and deployment, not the document workflow itself.

---

## 1. What the app is

A document archive where changes have to be reviewed before they count.

You upload a document. To change it you open a **draft**, edit it, and **propose** it. Someone
else reviews the diff and approves, which **publishes** a new version. Published versions are
immutable — a change always produces a new one, never edits an old one. Every action is written
to an audit log.

The one-line pitch: *Google Docs version history, but nothing becomes official until someone
else approves it.*

---

## 2. How it's built

| Piece | What it is |
|---|---|
| **API** | Express 5 + Prisma + Postgres 16, on port 3000 |
| **Web** | React 19 + Vite + Zustand + Radix + Tailwind v4, on port 5173 |
| **Worker** | Separate Node process; extracts searchable text in the background |
| **Storage** | MinIO (S3-compatible) for file blobs |
| **Editing** | ONLYOFFICE Document Server in Docker, for Word files |

One repo, npm workspaces: `api`, `web`, `worker`, and shared `packages/db` + `packages/storage`.

### The data model

Four tables carry the product:

- **Document** — the container. Title and workspace. No content of its own.
- **DocumentVersion** — published, immutable content. Numbered per document.
- **DocumentDraft** — unpublished work in progress, pinned to the version it branched from.
- **Review** — a verdict by a reviewer on a draft.

Plus `Workspace`, `Membership`, `LineComment`, `Task`, `AuditLog`, `DocumentSearch`, `Session`,
`Job`.

**The git analogy that lands well:** Document is the repo, DocumentVersion is a commit on main,
DocumentDraft is your working branch, and approving is the merge.

---

## 3. Running it

```bash
docker compose up -d    # Postgres, MinIO, ONLYOFFICE
npm run dev             # API + worker + web together
```

Then http://localhost:5173.

```bash
npm run typecheck   # api + web
npm run test:e2e    # 5 Playwright tests against the real app
cd api && npx vitest run   # 24 API integration tests
```

### Gotchas that will waste your time otherwise

- **Use `npm run dev`, not the individual scripts.** It starts the worker. Without the worker
  nothing gets indexed and search returns nothing, which looks like a broken feature rather than
  an empty index.
- **You need two accounts** to demo the loop — you can't approve your own proposal.
- **Passwords in the dev database are unrecoverable** (bcrypt). Register fresh accounts.
- **Upload a document a few seconds before demoing search**, not during. Indexing is async.

---

## 4. Decisions, and why

These are the ones worth being able to defend.

### Versions are immutable
The whole product is "you can prove what changed and who approved it." If versions were
editable that promise is worthless, so publishing only ever appends.

### One draft per document, enforced by the database
A partial unique index guarantees it — not a check in application code. This deliberately gives
up parallel editing, which eliminates merging entirely. For policy documents people take turns
anyway. **Removed a whole problem rather than solving it.**

### Drafts are pinned to a base version
Your diff is always against what you started from, even if someone else publishes meanwhile.
Otherwise the diff silently changes underneath you.

### Draft and proposal are one row, not two
Originally a unit of work was two rows — a draft and a proposal — each with its own `status`
column. The real state was the *pair*, so every permission check had to read both, and every
bug found came from code that read one and forgot the other. Merged into one row with one
status. **Deleted a category of bug instead of fixing four instances of it.**

### Two roles: admin and reviewer
Everyone in a workspace can approve; only admins manage membership. A third "member" tier was
considered and rejected — membership itself is the control. If you wouldn't let someone approve,
don't invite them.

### Authors can't approve *or* request changes on their own proposal
A review is a verdict recorded against a reviewer. An author entering one makes the review
history unreadable as evidence of who actually scrutinised the change. Authors get an
authorship verb instead — **withdraw**, which returns the work to a draft and records no review.
Commenting on your own proposal is still allowed, because it records no verdict.

### Word review is text-level review — deliberately
Word files can't be redlined directly, so the diff is computed from extracted text. Building a
real DOCX diff (or wiring up ONLYOFFICE's compare feature) was **considered and rejected** — it
is a large project for a format represented by one test file in the repo.

Instead, two guards make the limitation safe:
1. **A proposal that changes no reviewable text is rejected**, so a reviewer can never open a
   proposal and see an empty redline.
2. **Changes the redline can't show are named.** The `.docx` is a zip; hashing the entries the
   text extraction misses — headers, footers, comments, notes, images, styles — lets the review
   page say *"Also changed: footer, images."* Tracked changes and table layout live inside the
   main document part and are explicitly **not** claimed.

### Postgres full-text search, not substring matching
Search used `ILIKE '%query%'` ordered by index time. That meant no ranking, no word semantics
("policies" missed "policy"), no possible index because of the leading wildcard, one duplicate
result per version, and no title matching at all. Now: generated `tsvector` columns with GIN
indexes, `websearch_to_tsquery`, `ts_rank` with title weighted 5×, `DISTINCT ON` to collapse
versions, and `ts_headline` snippets.

### A job queue in Postgres, not Redis
A table with a status and a locked-at column, claimed with an atomic conditional update. Less
to run and less to go wrong at this scale.

### Content-addressed blobs
Files are stored by the SHA-256 of their contents, so identical uploads are stored once and
deduplication is free.

### Rate limits are strict in production and high in development
A single test run registers a dozen users. A limit that a normal dev loop exhausts is a limit
someone eventually deletes.

---

## 5. The Next.js detour — and why it was scrapped

A full Next.js frontend was built over the same API: App Router, server components, server
actions, middleware auth, URL-driven search. It reached feature parity and is preserved on the
local `next-frontend` branch (not pushed).

**It was scrapped because the design drifted.** It was built fresh rather than ported, so it
looked like a different product, and matching it back to the Vite app screen by screen was more
work than it was worth.

**The analysis is still worth keeping**, because it is a good answer to "why didn't you use
Next?":

- Uploads are 25 MB; serverless request bodies cap far below that
- The ONLYOFFICE callback does CPU-heavy conversion inside a request
- The search indexer is a polling worker that needs a real long-running process
- It wouldn't even reduce the process count

One genuinely interesting problem was solved there and is worth being able to describe: the API
issues 15-minute access tokens with a *rotating* refresh cookie, and Next can't set cookies
during a server-component render — so the token exchange has to happen in middleware, which
can.

---

## 6. What was fixed this session

**Security**
- A hardcoded fallback for the ONLYOFFICE signing secret, which signed both the file-access and
  save tokens — anyone with repo access could forge either
- Required env vars now validated at boot instead of failing on the first request
- Rate limiting, helmet, `trust proxy` (audit logs were recording the proxy's IP, not the user's)
- Upload type was decided by filename alone — rename anything to `.docx` and it was stored as a
  Word document. Contents are now verified
- Task completion restricted to the assignee, creator, or an admin

**Correctness**
- **Double publish.** Two concurrent approvals could both publish, producing two versions from
  one proposal. The status transition is now a conditional update that acts as the lock
- Draft ownership and state enforced on every mutation
- **ONLYOFFICE saving had never worked.** The callback check expected claims Document Server
  never sends — it signs its own callback body. Found by reading the container's logs after a
  test of mine gave a false positive
- Drafts could become unreachable: invisible in the API, with no way to discard them, while
  still blocking new ones

**Frontend**
- **The session silently died after 15 minutes.** Tokens were only fetched at boot. Now a
  13-minute timer plus a single-flight 401 retry
- An error boundary, so a render error no longer blanks the page
- Form labels weren't associated with inputs — thirteen fields were unlabelled for screen
  readers
- Search snippets were rendering raw marker characters

**Tests**
- 24 API integration tests, and 5 new Playwright tests including the full loop: author edits,
  proposes, reviewer approves, version 2 appears

---

## 7. What's left

**Real bugs, unfixed**
- `loadDocuments` and `runSearch` have no request cancellation, so fast pagination or a quickly
  refined search can render a stale response
- Thirteen `useEffect`s with no cleanup — navigating away mid-load still writes state

**Not verified by anything**
- Search ranking: the 5× title weight is a guess untested beyond a handful of documents, and
  the GIN index won't be chosen by the planner until the corpus is larger

**Deployment**
- The worker has no container image. It's the only piece that can't be deployed as-is

**Quality, not bugs**
- The editor bundle is 611 kB; `App.tsx` is 2,855 lines

---

## 8. If you're explaining this work

Lead with three stories rather than a feature list:

1. **The race condition** — two reviewers approving at once produced two versions; fixed by
   making the status change itself the guard, so a second transaction matches zero rows
2. **The data model** — one class of bug traced to state living in two rows, fixed by merging
   them rather than patching instances
3. **The debugging one** — Word saving failed silently; a test of ours passed because it was
   built around our own assumptions, and the answer was in the document server's logs

Include the third even though it starts with being wrong. That is the one that reads as
judgement rather than luck.

The most transferable lesson from the whole session: **nearly every real problem surfaced when
something was checked rather than reported.** A test that only confirms its own assumptions, a
typecheck that compiles nothing, search markers shipped without the frontend that understood
them — all found by running the thing, not by reading it.
