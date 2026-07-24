-- ============================================================
--  AI Clinic Receptionist — MVP Schema (PostgreSQL)
--  Seeded "dummy EMR" for the investor demo.
--  Notes for SQLite are marked with  -- SQLITE:
-- ============================================================

-- ---------- PATIENTS (your dummy EMR record) ----------
CREATE TABLE patients (
    id                 SERIAL PRIMARY KEY,          -- SQLITE: INTEGER PRIMARY KEY AUTOINCREMENT
    health_card_number VARCHAR(20)  NOT NULL UNIQUE,-- OHIP-style number used for identity check
    first_name         VARCHAR(80)  NOT NULL,
    last_name          VARCHAR(80)  NOT NULL,
    date_of_birth      DATE         NOT NULL,
    phone              VARCHAR(20)  NOT NULL,        -- E.164 e.g. +19025551234, used for SMS
    email              VARCHAR(160),
    preferred_language VARCHAR(5)   NOT NULL DEFAULT 'en',  -- 'en' | 'fr'
    allergies          TEXT,                        -- free text, shown on dashboard for "wow"
    chronic_conditions TEXT,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Verify identity on health card + DOB together (never card alone).
CREATE INDEX idx_patients_hc_dob ON patients (health_card_number, date_of_birth);

-- ---------- PHYSICIANS ----------
CREATE TABLE physicians (
    id           SERIAL PRIMARY KEY,
    full_name    VARCHAR(120) NOT NULL,
    specialty    VARCHAR(80)  NOT NULL DEFAULT 'Family Medicine',
    language     VARCHAR(20)  NOT NULL DEFAULT 'en,fr'  -- languages the doc speaks
);

-- ---------- APPOINTMENT SLOTS (the clinic calendar) ----------
-- Pre-seed a week of slots. is_booked flips as the agent books/cancels.
CREATE TABLE appointment_slots (
    id            SERIAL PRIMARY KEY,
    physician_id  INTEGER NOT NULL REFERENCES physicians(id),
    start_time    TIMESTAMPTZ NOT NULL,
    end_time      TIMESTAMPTZ NOT NULL,
    is_booked     BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (physician_id, start_time)
);

CREATE INDEX idx_slots_open ON appointment_slots (start_time) WHERE is_booked = FALSE;
-- SQLITE: drop the WHERE clause (no partial indexes pre-3.8): CREATE INDEX idx_slots_open ON appointment_slots (start_time);

-- ---------- APPOINTMENTS (the booking record) ----------
CREATE TABLE appointments (
    id            SERIAL PRIMARY KEY,
    patient_id    INTEGER NOT NULL REFERENCES patients(id),
    physician_id  INTEGER NOT NULL REFERENCES physicians(id),
    slot_id       INTEGER NOT NULL REFERENCES appointment_slots(id),
    reason        VARCHAR(200),
    urgency       VARCHAR(20) NOT NULL DEFAULT 'routine',  -- routine | urgent | same-day
    status        VARCHAR(20) NOT NULL DEFAULT 'booked',   -- booked | cancelled | completed
    confirmation_code VARCHAR(12) NOT NULL UNIQUE,         -- short code read back to patient
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_appts_patient ON appointments (patient_id, status);

-- ---------- SMS LOG (proves the confirmation text fired; feeds dashboard) ----------
CREATE TABLE sms_log (
    id             SERIAL PRIMARY KEY,
    appointment_id INTEGER REFERENCES appointments(id),
    to_phone       VARCHAR(20) NOT NULL,
    body           TEXT NOT NULL,
    kind           VARCHAR(20) NOT NULL DEFAULT 'confirmation', -- confirmation | reminder | cancellation
    status         VARCHAR(20) NOT NULL DEFAULT 'queued',       -- queued | sent | failed
    provider_sid   VARCHAR(64),                                 -- Twilio message SID
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
