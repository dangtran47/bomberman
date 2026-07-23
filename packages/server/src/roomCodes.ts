/**
 * Room-code registry: maps 4-letter join codes to internal Colyseus roomIds.
 * Module-level because rooms register/release themselves across the process.
 */

const CODE_LENGTH = 4;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_ATTEMPTS = 1000;

const codeToRoomId = new Map<string, string>();

export function generateCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return code;
}

/** Allocates an unused code for the given roomId, retrying on collisions. */
export function registerRoomCode(roomId: string, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode(random);
    if (!codeToRoomId.has(code)) {
      codeToRoomId.set(code, roomId);
      return code;
    }
  }
  throw new Error('unable to allocate a unique room code');
}

export function releaseRoomCode(code: string): void {
  codeToRoomId.delete(code.toUpperCase());
}

export function lookupRoomId(code: string): string | undefined {
  return codeToRoomId.get(code.toUpperCase());
}

/** Test helper. */
export function clearRoomCodes(): void {
  codeToRoomId.clear();
}
