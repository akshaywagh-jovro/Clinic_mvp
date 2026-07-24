-- ============================================================
--  Query set for each Retell Custom Function
--  Params shown as $1,$2... (node-postgres / psycopg style).
--  SQLITE: replace $1 with ? and now() with datetime('now').
-- ============================================================


-- ============================================================
-- 1) lookup-patient
--    Verify identity on health card number + DOB TOGETHER.
--    Returns the patient the agent then greets by name.
--    Backend rule: if 0 rows -> "new patient" branch in the flow.
-- ============================================================
SELECT id,
       first_name,
       last_name,
       phone,
       preferred_language,
       allergies,
       chronic_conditions
FROM patients
WHERE health_card_number = $1
  AND date_of_birth      = $2;      -- $2 as 'YYYY-MM-DD'


-- ============================================================
-- 2) check-appointment  (availability + existing appts)
-- ============================================================

-- 2a) OPEN SLOTS — for booking. Filter by optional physician / date.
--     $1 = physician_id (or NULL to search all), $2 = date (or NULL = next 7 days)
SELECT s.id            AS slot_id,
       s.physician_id,
       ph.full_name    AS physician,
       s.start_time,
       s.end_time
FROM appointment_slots s
JOIN physicians ph ON ph.id = s.physician_id
WHERE s.is_booked = FALSE
  AND s.start_time > now()
  AND ($1::int  IS NULL OR s.physician_id = $1)
  AND ($2::date IS NULL OR s.start_time::date = $2)
ORDER BY s.start_time
LIMIT 5;                             -- offer the caller a handful, not 200

-- 2b) A PATIENT'S EXISTING appointments — for "when is my appointment?" / reschedule / cancel
--     $1 = patient_id
SELECT a.id           AS appointment_id,
       a.confirmation_code,
       a.reason,
       a.status,
       s.start_time,
       ph.full_name   AS physician
FROM appointments a
JOIN appointment_slots s ON s.id = a.slot_id
JOIN physicians ph       ON ph.id = a.physician_id
WHERE a.patient_id = $1
  AND a.status = 'booked'
  AND s.start_time > now()
ORDER BY s.start_time;


-- ============================================================
-- 3) book-appointment
--    Run inside a TRANSACTION so the slot can't be double-booked.
--    Params: $1 patient_id, $2 slot_id, $3 reason, $4 urgency, $5 confirmation_code
-- ============================================================
BEGIN;

-- Lock the slot row and confirm it's still open (prevents race / double-book).
SELECT physician_id
FROM appointment_slots
WHERE id = $2 AND is_booked = FALSE
FOR UPDATE;                          -- if 0 rows -> ROLLBACK, tell caller slot was just taken

-- Mark slot taken.
UPDATE appointment_slots
SET is_booked = TRUE
WHERE id = $2;

-- Create the appointment (physician_id pulled from the slot).
INSERT INTO appointments
  (patient_id, physician_id, slot_id, reason, urgency, status, confirmation_code)
SELECT $1, s.physician_id, s.id, $3, $4, 'booked', $5
FROM appointment_slots s
WHERE s.id = $2
RETURNING id, confirmation_code;

COMMIT;


-- ============================================================
-- 4) send-sms
--    Backend calls Twilio first, then logs the result here.
--    Params: $1 appointment_id, $2 to_phone, $3 body, $4 kind,
--            $5 status ('sent'|'failed'), $6 provider_sid
-- ============================================================
INSERT INTO sms_log (appointment_id, to_phone, body, kind, status, provider_sid)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id;

-- Suggested confirmation body your backend composes before sending:
--   "Hi <first_name>, your appointment with <physician> is confirmed for
--    <start_time>. Code: <confirmation_code>. Reply CANCEL to cancel."


-- ============================================================
-- 5) reschedule-appointment
--    = free the old slot, take a new one, repoint the appointment.
--    Run in ONE transaction. Params: $1 appointment_id, $2 new_slot_id
-- ============================================================
BEGIN;

-- Free the old slot.
UPDATE appointment_slots
SET is_booked = FALSE
WHERE id = (SELECT slot_id FROM appointments WHERE id = $1);

-- Claim the new slot (guard against it being taken).
SELECT id FROM appointment_slots
WHERE id = $2 AND is_booked = FALSE
FOR UPDATE;                          -- 0 rows -> ROLLBACK, offer another time

UPDATE appointment_slots
SET is_booked = TRUE
WHERE id = $2;

-- Repoint the appointment to the new slot + physician.
UPDATE appointments a
SET slot_id      = $2,
    physician_id = (SELECT physician_id FROM appointment_slots WHERE id = $2),
    updated_at   = now()
WHERE a.id = $1
RETURNING a.id, a.confirmation_code;

COMMIT;


-- ============================================================
-- 6) cancel-appointment
--    Mark cancelled AND release the slot back to availability.
--    Param: $1 appointment_id
-- ============================================================
BEGIN;

UPDATE appointment_slots
SET is_booked = FALSE
WHERE id = (SELECT slot_id FROM appointments WHERE id = $1);

UPDATE appointments
SET status     = 'cancelled',
    updated_at = now()
WHERE id = $1
RETURNING id, confirmation_code;

COMMIT;


-- ============================================================
--  DASHBOARD helper queries (for the live demo screen)
-- ============================================================

-- Appointments booked today (counter):
SELECT count(*) FROM appointments
WHERE status = 'booked' AND created_at::date = now()::date;

-- Live feed of recent bookings:
SELECT a.confirmation_code, p.first_name, p.last_name,
       ph.full_name AS physician, s.start_time, a.status
FROM appointments a
JOIN patients p          ON p.id = a.patient_id
JOIN appointment_slots s ON s.id = a.slot_id
JOIN physicians ph       ON ph.id = a.physician_id
ORDER BY a.created_at DESC
LIMIT 20;
