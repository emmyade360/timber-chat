// Running many async jobs without letting them all start at once.
//
// The reconnect path is the reason this exists. Reconciling ran four requests
// per conversation through a bare `Promise.all`, so an account with two hundred
// chats opened eight hundred parallel requests every time a phone changed cell
// tower -- enough to exhaust the browser's connection pool, time itself out,
// and reconnect into the same storm again.

/**
 * Map over `items` with at most `limit` jobs in flight, preserving order.
 *
 * Rejections are returned rather than thrown, because every caller here is
 * doing best-effort catch-up work: one conversation failing to backfill must
 * not abandon the other hundred and ninety-nine.
 */
export async function mapWithLimit(items, limit, job) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;

  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { ok: true, value: await job(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  const size = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}
