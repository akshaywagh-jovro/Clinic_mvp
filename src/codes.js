import crypto from 'crypto';

// Unambiguous alphabet (no 0/O, 1/I) — this code gets read aloud to a patient.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 8 chars from a 32-symbol alphabet ≈ 1.1e12 combinations, so collisions on the
// UNIQUE confirmation_code column are negligible for the demo.
export function confirmationCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}
