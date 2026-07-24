import { query, withTransaction } from './db.js';
import { confirmationCode } from './codes.js';

// Shared response shapes, reused across routes so Swagger docs stay consistent.
// additionalProperties stays true everywhere so nothing a handler returns gets
// silently stripped by Fastify's schema-based serializer.
const errorResponse = {
  type: 'object',
  additionalProperties: true,
  properties: { error: { type: 'string' } },
};
const failureResponse = {
  type: 'object',
  additionalProperties: true,
  properties: { success: { type: 'boolean', example: false }, error: { type: 'string' } },
};

// Fastify plugin: registers the five endpoints Retell calls. Fastify catches
// anything a handler throws and routes it to the error handler (500).
export default async function routes(fastify) {
  // ------------------------------------------------------------------
  // 1) POST /lookup-patient
  //    Verify identity on health card number + DOB together (never card alone).
  // ------------------------------------------------------------------
  fastify.post(
    '/lookup-patient',
    {
      schema: {
        tags: ['Patients'],
        summary: 'Look up a patient by health card number + date of birth',
        description:
          'Verifies identity on health card number AND date of birth together — never the card ' +
          'alone. No match returns `found: false` (not an error) — the "new patient" branch.',
        body: {
          type: 'object',
          additionalProperties: true,
          properties: {
            health_card_number: { type: 'string', example: '1234567890AB' },
            date_of_birth: { type: 'string', format: 'date', example: '1985-03-12' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              found: { type: 'boolean' },
              patient_id: { type: 'integer', example: 1 },
              first_name: { type: 'string', example: 'Sarah' },
              preferred_language: { type: 'string', example: 'en' },
            },
          },
          400: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { health_card_number, date_of_birth } = request.body;
      if (!health_card_number || !date_of_birth) {
        return reply.code(400).send({ error: 'health_card_number and date_of_birth are required' });
      }

      const { rows } = await query(
        `SELECT id, first_name, last_name, preferred_language
           FROM patients
          WHERE health_card_number = $1 AND date_of_birth = $2`,
        [health_card_number, date_of_birth]
      );

      if (rows.length === 0) return { found: false };

      const p = rows[0];
      return {
        found: true,
        patient_id: p.id,
        first_name: p.first_name,
        preferred_language: p.preferred_language,
      };
    }
  );

  // ------------------------------------------------------------------
  // 2) POST /check-appointment
  //    With patient_id  -> that patient's upcoming appointments.
  //    Otherwise        -> open slots to book (optional physician_id / date filters).
  // ------------------------------------------------------------------
  fastify.post(
    '/check-appointment',
    {
      schema: {
        tags: ['Appointments'],
        summary: "Get open slots, or a patient's upcoming appointments",
        description:
          'Send `patient_id` to list that patient\'s upcoming booked appointments. Omit it to ' +
          'search open slots instead, optionally narrowed by `physician_id` and/or `date`.',
        body: {
          type: 'object',
          additionalProperties: true,
          properties: {
            patient_id: { type: 'integer', example: 1, description: 'Set to list existing appointments instead of searching slots' },
            physician_id: { type: 'integer', example: 1, description: 'Optional filter when searching open slots' },
            date: { type: 'string', format: 'date', example: '2026-07-24', description: 'Optional filter when searching open slots' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              appointments: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    appointment_id: { type: 'integer' },
                    confirmation_code: { type: 'string' },
                    reason: { type: 'string' },
                    status: { type: 'string' },
                    start_time: { type: 'string', format: 'date-time' },
                    physician: { type: 'string' },
                  },
                },
              },
              slots: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    slot_id: { type: 'integer' },
                    physician_id: { type: 'integer' },
                    physician: { type: 'string' },
                    start_time: { type: 'string', format: 'date-time' },
                    end_time: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { patient_id, physician_id, date } = request.body;

      if (patient_id) {
        const { rows } = await query(
          `SELECT a.id AS appointment_id, a.confirmation_code, a.reason, a.status,
                  s.start_time, ph.full_name AS physician
             FROM appointments a
             JOIN appointment_slots s ON s.id = a.slot_id
             JOIN physicians ph       ON ph.id = a.physician_id
            WHERE a.patient_id = $1 AND a.status = 'booked' AND s.start_time > now()
            ORDER BY s.start_time`,
          [patient_id]
        );
        return { appointments: rows };
      }

      const { rows } = await query(
        `SELECT s.id AS slot_id, s.physician_id, ph.full_name AS physician,
                s.start_time, s.end_time
           FROM appointment_slots s
           JOIN physicians ph ON ph.id = s.physician_id
          WHERE s.is_booked = FALSE
            AND s.start_time > now()
            AND ($1::int  IS NULL OR s.physician_id = $1)
            AND ($2::date IS NULL OR s.start_time::date = $2)
          ORDER BY s.start_time
          LIMIT 5`,
        [physician_id || null, date || null]
      );
      return { slots: rows };
    }
  );

  // ------------------------------------------------------------------
  // 3) POST /book-appointment
  //    Locks the slot inside a transaction so it can't be double-booked.
  // ------------------------------------------------------------------
  fastify.post(
    '/book-appointment',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Book an open slot for a patient',
        description: 'Fails with 409 if the slot was taken a moment earlier (locked via SELECT … FOR UPDATE).',
        body: {
          type: 'object',
          additionalProperties: true,
          properties: {
            patient_id: { type: 'integer', example: 1 },
            slot_id: { type: 'integer', example: 33, description: 'From check-appointment (open slots search)' },
            reason: { type: 'string', example: 'Annual checkup' },
            urgency: { type: 'string', enum: ['routine', 'urgent', 'same-day'], default: 'routine', example: 'routine' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              success: { type: 'boolean', example: true },
              confirmation_code: { type: 'string', example: '72E47A9G' },
              start_time: { type: 'string', format: 'date-time' },
              physician: { type: 'string', example: 'Dr. Marie Leblanc' },
            },
          },
          400: errorResponse,
          409: failureResponse,
        },
      },
    },
    async (request, reply) => {
      const { patient_id, slot_id, reason, urgency } = request.body;
      if (!patient_id || !slot_id) {
        return reply.code(400).send({ error: 'patient_id and slot_id are required' });
      }

      const result = await withTransaction(async (client) => {
        // Lock the slot row and confirm it's still open (prevents race / double-book).
        const slot = await client.query(
          `SELECT s.physician_id, s.start_time, ph.full_name AS physician
             FROM appointment_slots s
             JOIN physicians ph ON ph.id = s.physician_id
            WHERE s.id = $1 AND s.is_booked = FALSE
            FOR UPDATE OF s`,
          [slot_id]
        );
        if (slot.rows.length === 0) return null; // already taken

        await client.query(`UPDATE appointment_slots SET is_booked = TRUE WHERE id = $1`, [slot_id]);

        const code = confirmationCode();
        const insert = await client.query(
          `INSERT INTO appointments
             (patient_id, physician_id, slot_id, reason, urgency, status, confirmation_code)
           SELECT $1, s.physician_id, s.id, $2, $3, 'booked', $4
             FROM appointment_slots s
            WHERE s.id = $5
           RETURNING confirmation_code`,
          [patient_id, reason || null, urgency || 'routine', code, slot_id]
        );

        return {
          confirmation_code: insert.rows[0].confirmation_code,
          start_time: slot.rows[0].start_time,
          physician: slot.rows[0].physician,
        };
      });

      if (!result) return reply.code(409).send({ success: false, error: 'slot_unavailable' });

      return {
        success: true,
        confirmation_code: result.confirmation_code,
        start_time: result.start_time,
        physician: result.physician,
      };
    }
  );

  // ------------------------------------------------------------------
  // 4) POST /reschedule-appointment
  //    Free the old slot, take a new one, repoint the appointment — one transaction.
  // ------------------------------------------------------------------
  fastify.post(
    '/reschedule-appointment',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Move an existing appointment to a different open slot',
        description: 'Fails with 409 if the new slot was taken a moment earlier, or 404 if the appointment does not exist / is not active.',
        body: {
          type: 'object',
          additionalProperties: true,
          properties: {
            appointment_id: { type: 'integer', example: 1 },
            new_slot_id: { type: 'integer', example: 34, description: 'From check-appointment (open slots search)' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              success: { type: 'boolean', example: true },
              confirmation_code: { type: 'string', example: '72E47A9G' },
              new_start_time: { type: 'string', format: 'date-time' },
            },
          },
          400: errorResponse,
          404: failureResponse,
          409: failureResponse,
        },
      },
    },
    async (request, reply) => {
      const { appointment_id, new_slot_id } = request.body;
      if (!appointment_id || !new_slot_id) {
        return reply.code(400).send({ error: 'appointment_id and new_slot_id are required' });
      }

      const result = await withTransaction(async (client) => {
        // Claim the new slot first (guard against it being taken).
        const claim = await client.query(
          `SELECT start_time FROM appointment_slots WHERE id = $1 AND is_booked = FALSE FOR UPDATE`,
          [new_slot_id]
        );
        if (claim.rows.length === 0) return { error: 'slot_unavailable' };

        // Free the old slot.
        await client.query(
          `UPDATE appointment_slots SET is_booked = FALSE
            WHERE id = (SELECT slot_id FROM appointments WHERE id = $1)`,
          [appointment_id]
        );
        // Take the new slot.
        await client.query(`UPDATE appointment_slots SET is_booked = TRUE WHERE id = $1`, [new_slot_id]);

        // Repoint the appointment to the new slot + physician.
        const upd = await client.query(
          `UPDATE appointments
              SET slot_id = $1,
                  physician_id = (SELECT physician_id FROM appointment_slots WHERE id = $1),
                  updated_at = now()
            WHERE id = $2 AND status = 'booked'
            RETURNING confirmation_code`,
          [new_slot_id, appointment_id]
        );
        if (upd.rows.length === 0) return { error: 'appointment_not_found' };

        return { confirmation_code: upd.rows[0].confirmation_code, new_start_time: claim.rows[0].start_time };
      });

      if (result.error) {
        const status = result.error === 'appointment_not_found' ? 404 : 409;
        return reply.code(status).send({ success: false, error: result.error });
      }

      return {
        success: true,
        confirmation_code: result.confirmation_code,
        new_start_time: result.new_start_time,
      };
    }
  );

  // ------------------------------------------------------------------
  // 5) POST /cancel-appointment
  //    Mark cancelled AND release the slot back to availability.
  // ------------------------------------------------------------------
  fastify.post(
    '/cancel-appointment',
    {
      schema: {
        tags: ['Appointments'],
        summary: 'Cancel an existing appointment',
        description: 'Releases the slot back to availability. Fails with 404 if the appointment does not exist / is not active.',
        body: {
          type: 'object',
          additionalProperties: true,
          properties: {
            appointment_id: { type: 'integer', example: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true,
            properties: {
              success: { type: 'boolean', example: true },
              confirmation_code: { type: 'string', example: '72E47A9G' },
            },
          },
          400: errorResponse,
          404: failureResponse,
        },
      },
    },
    async (request, reply) => {
      const { appointment_id } = request.body;
      if (!appointment_id) {
        return reply.code(400).send({ error: 'appointment_id is required' });
      }

      const result = await withTransaction(async (client) => {
        await client.query(
          `UPDATE appointment_slots SET is_booked = FALSE
            WHERE id = (SELECT slot_id FROM appointments WHERE id = $1)`,
          [appointment_id]
        );
        const upd = await client.query(
          `UPDATE appointments SET status = 'cancelled', updated_at = now()
            WHERE id = $1 AND status = 'booked'
            RETURNING confirmation_code`,
          [appointment_id]
        );
        return upd.rows[0] || null;
      });

      if (!result) return reply.code(404).send({ success: false, error: 'appointment_not_found' });

      return { success: true, confirmation_code: result.confirmation_code };
    }
  );
}
