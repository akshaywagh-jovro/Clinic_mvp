# Clinic Receptionist API

Backend service for the **AI Clinic Receptionist** demo. It exposes the endpoints that
[Retell](https://www.retellai.com/) calls mid-conversation (as *Custom Functions*) to look up
a patient, check availability, and book / reschedule / cancel appointments against an
Azure PostgreSQL "dummy EMR".

Built with **Fastify** + **node-postgres (`pg`)**. Minimal on purpose — one small handler per
endpoint, mapping directly to the SQL in [`sql/functions.sql`](sql/functions.sql). Comes with
interactive Swagger docs, so you don't need to hand-craft requests to try it — see
[Interactive API docs](#interactive-api-docs) below.

---

## Endpoints

All are `POST`, accept JSON, and return JSON. Mounted at the root.

| Endpoint | Retell sends | Returns |
|---|---|---|
| `/lookup-patient` | `health_card_number`, `date_of_birth` | `found`, `patient_id`, `first_name`, `preferred_language` |
| `/check-appointment` | `patient_id` **or** `physician_id` / `date` | `appointments[]` (if `patient_id`) **or** open `slots[]` |
| `/book-appointment` | `patient_id`, `slot_id`, `reason`, `urgency` | `success`, `confirmation_code`, `start_time`, `physician` |
| `/reschedule-appointment` | `appointment_id`, `new_slot_id` | `success`, `confirmation_code`, `new_start_time` |
| `/cancel-appointment` | `appointment_id` | `success`, `confirmation_code` |

Plus `GET /health` → `{ "status": "ok" }` for uptime checks.

**Identity rule:** `lookup-patient` matches on health card number **and** date of birth
together — never the card alone. No match returns `{ "found": false }` (a normal "new patient"
outcome, not an error), so the Retell flow can branch on it.

**Booking safety:** `book`, `reschedule`, and `cancel` each run inside a single transaction and
lock the slot row (`SELECT … FOR UPDATE`) before taking it, so two callers can't grab the same
slot. If the slot was taken a moment earlier, you get `409 { "success": false, "error": "slot_unavailable" }`.

**Retell payload shape:** Retell sends custom-function arguments either at the top level or
nested under an `args` object. A small `preHandler` hook flattens `args` onto the body, so both
shapes work without any change to the handlers.

---

## Project structure

```
.
├── src/
│   ├── server.js   # Fastify app: swagger, hooks, health check, route + error wiring
│   ├── routes.js   # the five endpoints (one handler each, with docs schema)
│   ├── db.js       # pg connection pool + withTransaction() helper
│   └── codes.js    # confirmation-code generator
├── sql/
│   ├── schema.sql      # tables + indexes
│   ├── seed.sql        # demo physicians, patients, and a week of slots
│   └── functions.sql   # reference: the query behind each endpoint
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
└── package.json
```

---

## Setup

### 1. Prerequisites
- Node.js **20+**
- Access to the Azure PostgreSQL instance (the `psql` client helps for loading schema/seed)

### 2. Install
```bash
npm install
```

### 3. Configure the database connection
```bash
cp .env.example .env
```
Then edit `.env` and set `PGPASSWORD` (host, user, and database are pre-filled for the demo):

```env
PGHOST=jovro-postgres-demo.postgres.database.azure.com
PGPORT=5432
PGUSER=jovrodemo
PGPASSWORD=your-password-here
PGDATABASE=postgres
PGSSL=true
```

> SSL is on by default because Azure PostgreSQL requires it. You can instead provide a single
> `DATABASE_URL` (see `.env.example`).

### 4. Load the schema + seed data (first time only)
```bash
psql "host=jovro-postgres-demo.postgres.database.azure.com port=5432 dbname=postgres user=jovrodemo sslmode=require" -f sql/schema.sql
psql "host=jovro-postgres-demo.postgres.database.azure.com port=5432 dbname=postgres user=jovrodemo sslmode=require" -f sql/seed.sql
```
`psql` will prompt for the password. The seed creates 2 physicians, 5 patients, and a week of
30-minute slots starting tomorrow.

### 5. Run
```bash
npm run dev     # auto-restart on file changes
# or
npm start
```
Server listens on `http://localhost:3000` (override with `PORT`).

---

## Run with Docker

Use this instead of step 5 above if you're deploying to a VM. Steps 1–4 (clone, `.env`,
schema/seed) still apply — Docker just replaces `npm start`. The database itself is **not**
containerized; it's the same external Azure PostgreSQL instance either way.

### 1. Prerequisites
- [Docker Engine](https://docs.docker.com/engine/install/) installed on the VM (includes the
  `docker compose` plugin on any reasonably current install)
- `.env` present in the project root (same file as local setup — see step 3 above)

### 2. Build and start
```bash
docker compose up -d --build
```
This builds the image from the `Dockerfile` and starts a container named `clinicmvp-api-1`,
mapping port 3000 and loading `.env` into the container's environment.

### 3. Check it's healthy
```bash
docker compose ps          # STATUS column should say "healthy" after ~10s
docker compose logs -f api # follow logs; Ctrl+C to stop watching (container keeps running)
curl http://localhost:3000/health
```

### 4. Stop / restart
```bash
docker compose down        # stop and remove the container
docker compose restart     # restart without rebuilding
docker compose up -d --build   # rebuild after pulling new code (git pull first)
```

### Firewall gotcha: Azure Postgres only allows known IPs

Azure PostgreSQL's firewall allowlists by **source IP**, and a container's outbound traffic
doesn't always look like it's coming from the host machine — on some setups (notably Docker
Desktop on Mac) containers egress through a different IP than the host itself. On a plain Linux
VM this is normally *not* an issue (Docker's default bridge network NATs container traffic out
through the VM's own IP), but if `/lookup-patient` or any DB-touching endpoint hangs and then
times out instead of returning JSON, check this first:

1. Confirm the VM's outbound IP: `curl https://api.ipify.org` (run this on the VM, outside Docker)
2. In the Azure Portal, go to the PostgreSQL server → **Networking** → firewall rules, and make
   sure that IP (or the VM's subnet, if using VNet integration) is allowed.
3. Re-test: `curl -X POST http://localhost:3000/lookup-patient -H 'Content-Type: application/json' -d '{"health_card_number":"1234567890AB","date_of_birth":"1985-03-12"}'`

### Exposing it to Retell

Retell needs a **public HTTPS URL**. The container itself only serves plain HTTP on port 3000 —
for a real deployment, put a reverse proxy (nginx, Caddy, or Azure's own Application Gateway/
Front Door) in front of it to terminate TLS, rather than exposing port 3000 directly.

---

## Interactive API docs

Open **http://localhost:3000/docs** in a browser. This is the easiest way to use the API if
you don't want to write curl commands by hand:

1. Click an endpoint (e.g. `POST /book-appointment`) to expand it.
2. Click **"Try it out"**.
3. The request body is pre-filled with a realistic example (seeded demo data) — edit any field.
4. Click **"Execute"** to send the request and see the real response right there.

Each endpoint's description also explains what it does and what the possible responses mean
(success, "slot already taken", "not found", etc.). The raw OpenAPI spec (if you need it for
another tool) is at `http://localhost:3000/docs/json`.

---

## Try it (curl)

```bash
# Health
curl localhost:3000/health

# 1. Look up a seeded patient (Sarah Thompson)
curl -X POST localhost:3000/lookup-patient \
  -H 'Content-Type: application/json' \
  -d '{"health_card_number":"1234567890AB","date_of_birth":"1985-03-12"}'
# -> {"found":true,"patient_id":1,"first_name":"Sarah","preferred_language":"en"}

# 2a. Open slots to book (optionally filter by physician_id / date)
curl -X POST localhost:3000/check-appointment \
  -H 'Content-Type: application/json' -d '{}'
# -> {"slots":[{"slot_id":1,"physician":"Dr. Marie Leblanc","start_time":"..."}, ...]}

# 3. Book one of those slots
curl -X POST localhost:3000/book-appointment \
  -H 'Content-Type: application/json' \
  -d '{"patient_id":1,"slot_id":1,"reason":"Annual checkup","urgency":"routine"}'
# -> {"success":true,"confirmation_code":"K7QX9M2A","start_time":"...","physician":"Dr. Marie Leblanc"}

# 2b. Check that patient's upcoming appointments
curl -X POST localhost:3000/check-appointment \
  -H 'Content-Type: application/json' -d '{"patient_id":1}'

# 4. Reschedule to another open slot
curl -X POST localhost:3000/reschedule-appointment \
  -H 'Content-Type: application/json' \
  -d '{"appointment_id":1,"new_slot_id":2}'

# 5. Cancel
curl -X POST localhost:3000/cancel-appointment \
  -H 'Content-Type: application/json' -d '{"appointment_id":1}'
```

---

## Wiring into Retell

For each Custom Function in Retell, point the webhook URL at the matching endpoint (e.g.
`https://<your-host>/book-appointment`) and define the function parameters to match the
"Retell sends" column above. Retell needs a **public HTTPS URL**, so for local testing expose
the port with a tunnel (e.g. `ngrok http 3000`) or deploy the service.

---

## Note on the "6th" function

The endpoint spec header mentions "six" but lists five bookable actions. The sixth item in
[`sql/functions.sql`](sql/functions.sql) is **`send-sms`**, which logs a Twilio confirmation
text to the `sms_log` table. It is intentionally **not** built here: it isn't in the endpoint
contract, and it needs Twilio credentials to be meaningful. Drop-in when ready — send via
Twilio, then `INSERT INTO sms_log (...)` — ideally called right after a successful booking.
