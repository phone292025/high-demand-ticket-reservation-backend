export const RESERVATION_TTL_MS = 5 * 60 * 1000;

export function reservationExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + RESERVATION_TTL_MS);
}

export function formatSqliteDate(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
