-- ============================================================
--  Seed data for the demo (PostgreSQL)
-- ============================================================

INSERT INTO physicians (full_name, specialty, language) VALUES
  ('Dr. Marie Leblanc',  'Family Medicine', 'en,fr'),
  ('Dr. James Chen',     'Family Medicine', 'en');

INSERT INTO patients
  (health_card_number, first_name, last_name, date_of_birth, phone, email, preferred_language, allergies, chronic_conditions)
VALUES
  ('1234567890AB', 'Sarah',   'Thompson', '1985-03-12', '+19025551001', 'sarah.t@example.com',  'en', 'Penicillin',      'Hypertension'),
  ('2345678901CD', 'Luc',     'Gagnon',   '1972-11-30', '+19025551002', 'luc.g@example.com',    'fr', 'None known',      'Type 2 Diabetes'),
  ('3456789012EF', 'Aisha',   'Khan',     '1990-07-08', '+19025551003', 'aisha.k@example.com',  'en', 'Shellfish',       NULL),
  ('4567890123GH', 'Robert',  'Nguyen',   '1968-01-22', '+19025551004', NULL,                   'en', 'None known',      'Asthma'),
  ('5678901234IJ', 'Chloe',   'Bouchard', '2001-05-17', '+19025551005', 'chloe.b@example.com',  'fr', 'Latex',           NULL);

-- Generate a week of 30-min slots (9:00–16:30) for both physicians, starting tomorrow.
-- PostgreSQL generate_series makes this one statement.
INSERT INTO appointment_slots (physician_id, start_time, end_time)
SELECT p.id,
       slot_start,
       slot_start + INTERVAL '30 minutes'
FROM physicians p
CROSS JOIN generate_series(
    date_trunc('day', now()) + INTERVAL '1 day' + INTERVAL '9 hours',
    date_trunc('day', now()) + INTERVAL '7 day'  + INTERVAL '16 hours 30 minutes',
    INTERVAL '30 minutes'
) AS slot_start
-- keep only 9:00–16:30 window on each day
WHERE EXTRACT(HOUR FROM slot_start) BETWEEN 9 AND 16;

-- SQLITE has no generate_series by default — seed slots from your backend
-- with a small loop instead, or insert them explicitly.
