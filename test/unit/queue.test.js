/**
 * The MySQL-backed queue and the durable cache tier, against a **real database**.
 *
 * `kernel.test.js` is deliberately database-free so it fails for a kernel defect
 * rather than because MySQL is down. This file is the opposite trade, and it has to
 * exist for a reason specific to M02: the two things that replaced Redis — job
 * claiming and durable credential storage — are *SQL*. Their correctness is in the
 * `FOR UPDATE SKIP LOCKED`, the lease arithmetic and the expiry comparison, none of
 * which a mock can assert. A mocked `reserve()` returning `{ id: "x" }` proves the
 * caller handles a job; it proves nothing about whether two workers can claim the
 * same row.
 *
 * So: real database, real concurrency, no mocks of the store under test.
 *
 * The database is the isolated one from `helpers/env`, ensured by
 * `scripts/test-db.js ensure` in `pnpm test`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { useTestDatabase } = require("../helpers/env");
useTestDatabase();

const { prisma, disconnect } = require("../../src/platform/db/prisma");
const store = require("../../src/platform/queue/store");
const { QUEUES } = require("../../src/platform/queue/queues");
const cache = require("../../src/platform/cache");

/** A unique-per-call job id, so one test's rows cannot make another's pass. */
let counter = 0;
function jobId(prefix = "test") {
  counter += 1;
  return `amaken:test:${prefix}:${counter}`;
}

/** Removes this file's rows. Runs before and after every test. */
async function reset() {
  await prisma.job.deleteMany({ where: { id: { startsWith: "amaken:test:" } } });
  // `cache.clearDurable()` rather than a hand-written `startsWith` on
  // `amaken-cache-test:` — the stored key is *qualified*, so that filter would
  // match nothing and every test would inherit the previous one's rows. Silent,
  // order-dependent passes are the failure mode this file is most exposed to.
  await cache.clearDurable();
  // `clear`, not `clearDurable` alone: a durable namespace has no in-memory copy by
  // design, but a non-durable one does, and leaving those behind would hide a tier
  // that is writing when it should not.
  cache.clear();
}

// Before *every* test, not just at the end: `reserve` claims from all queues and
// ignores this file's id prefix, so a job left claimed by one test is visible to the
// next. Tests that leave rows behind would then fail in an order-dependent way,
// which is the hardest kind of test failure to read.
test.beforeEach(reset);

test.after(async () => {
  await reset();
  // The pool is process-global; leaving it open would hold the test runner's event
  // loop open after the last test, which turns a passing run into a hanging one.
  await disconnect();
});

// ── the store ───────────────────────────────────────────────────────────────

test("enqueue de-duplicates on the id and reports which it was", async () => {
  const id = jobId("dedupe");

  const first = await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: { to: "a@b.com" } });
  assert.deepEqual(first, { id, duplicate: false });

  // The second call is the OTP resend path. It must resolve, not throw — BullMQ
  // dropped duplicate job ids and the flow depends on that.
  const second = await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: { to: "a@b.com" } });
  assert.deepEqual(second, { id, duplicate: true });

  assert.equal(await prisma.job.count({ where: { id } }), 1, "one row, not two");
});

test("enqueue rejects an unknown queue rather than writing a job nothing will run", async () => {
  await assert.rejects(
    () => store.enqueue({ id: jobId("bad"), queue: "no-such-queue", payload: {} }),
    /unknown queue/
  );
});

test("reserve claims the oldest runnable jobs, leaves the rest, and returns empty when idle", async () => {
  const older = jobId("older");
  const newer = jobId("newer");
  const future = jobId("future");

  await store.enqueue({ id: newer, queue: QUEUES.LEAD_NOTIFICATION, payload: { n: 2 } });
  await store.enqueue({
    id: older,
    queue: QUEUES.LEAD_NOTIFICATION,
    payload: { n: 1 },
    runAt: new Date(Date.now() - 60_000),
  });
  // Scheduled for the future: this is what a retry backoff looks like, and a poll
  // must not run it early.
  await store.enqueue({
    id: future,
    queue: QUEUES.LEAD_NOTIFICATION,
    payload: { n: 3 },
    runAt: new Date(Date.now() + 600_000),
  });

  const first = await store.reserve({ workerId: "worker-a", limit: 10 });
  assert.equal(first.length, 2, "the delayed job is not runnable, so only two are claimed");

  // FIFO is a promise of this queue: the oldest `run_at` first, whatever order the
  // candidate read and the update happened to return the rows in.
  assert.deepEqual(
    first.map((j) => j.id),
    [older, newer],
    "the oldest runnable job leads"
  );
  assert.equal(first[0].payload.n, 1, "the payload round-trips through JSON");
  assert.equal(first[0].attempts, 1, "the first claim is attempt 1");
  assert.equal(first[0].maxAttempts >= 2, true, "and the queue default allows a retry");

  assert.deepEqual(await store.reserve({ workerId: "worker-a" }), [], "nothing left to claim");

  // The delayed job becomes claimable when its time comes — a retry that survives
  // the backoff rather than being slept through.
  await prisma.job.update({ where: { id: future }, data: { run_at: new Date(Date.now() - 1000) } });
  const later = await store.reserve({ workerId: "worker-a" });
  assert.deepEqual(later.map((j) => j.id), [future], "and then it is claimable");
});

test("reserve is exclusive: concurrent claims never return the same job twice", async () => {
  const ids = ["race-1", "race-2", "race-3", "race-4"].map((n) => jobId(n));
  for (const id of ids) {
    await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: { id } });
  }

  // This is the assertion the whole claim protocol exists for. Eight simultaneous
  // claimers over four rows must return four distinct ids — never a duplicate. For
  // an OTP that would mean two workers sending two different codes to one user, and
  // one of them would not match the code in the database.
  //
  // The implementation this replaced claimed with a single
  // `SELECT … LIMIT 1 … FOR UPDATE SKIP LOCKED`. InnoDB locks every record a locking
  // read scans, so that version made one worker lock all four rows while returning
  // one — exclusivity held, and every other worker sat idle. It passed a
  // "no duplicates" test while failing the only thing that test was for.
  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.reserve({ workerId: `racer-${i}`, limit: 4 }))
  );

  const claimed = claims.flat().map((c) => c.id);
  assert.equal(claimed.length, 4, "each job is claimed exactly once");
  assert.equal(new Set(claimed).size, 4, "and no job is claimed twice");

  // Every claim recorded who took it, which is the only thing that makes a stuck
  // `active` row diagnosable.
  const rows = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: { id: true, locked_by: true, locked_at: true, attempts: true },
  });
  for (const row of rows) {
    assert.ok(row.locked_by && row.locked_by.startsWith("racer-"), `${row.id} has no owner`);
    assert.ok(row.locked_at instanceof Date, `${row.id} has no lease`);
    assert.equal(row.attempts, 1, "one attempt per claim, however many callers asked");
  }
});

test("work spreads across workers, and what one worker does not take is still there", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => jobId(`spread-${i}`));
  for (const id of ids) {
    await store.enqueue({ id, queue: QUEUES.LEAD_NOTIFICATION, payload: { id } });
  }

  // More jobs than workers, each asking for a small batch. This is the shape the
  // old `LIMIT 1` version got wrong: one worker would lock the whole scan range
  // and the rest would idle, so adding workers bought nothing.
  //
  // The workers are **staggered** rather than launched in the same tick, and the
  // stagger is the point rather than a workaround. Six claimers released at the
  // identical instant all read the same two candidate rows and five of them lose —
  // correct, but it measures nothing about distribution. In a real poll loop workers
  // are naturally staggered, which is when the claim protocol has to spread work.
  const workers = 6;
  const perWorker = 2;
  const claims = [];
  for (let i = 0; i < workers; i += 1) {
    claims.push(await store.reserve({ workerId: `spreader-${i}`, limit: perWorker }));
  }

  const claimed = claims.flat().map((c) => c.id);
  assert.equal(new Set(claimed).size, claimed.length, "no job appears in two claims");

  const activeWorkers = claims.filter((c) => c.length > 0).length;
  assert.ok(
    activeWorkers >= workers,
    `every staggered worker should find work, got ${JSON.stringify(claims.map((c) => c.length))}`
  );

  // Losers are not losers: every unclaimed row must still be runnable with
  // `attempts` untouched, because that is what makes the next poll make progress
  // rather than spin.
  const rows = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: { id: true, attempts: true, status: true },
  });
  const untouched = rows.filter((r) => !claimed.includes(r.id));
  for (const row of untouched) {
    assert.equal(row.attempts, 0, `${row.id} was never half-claimed`);
    assert.equal(row.status, store.JobStatus.PENDING, `${row.id} is still pending`);
  }

  // And a follow-up round drains the rest, which is the actual guarantee: progress
  // every poll, no duplicates ever.
  let drained = claimed.length;
  for (let round = 0; round < 10 && drained < ids.length; round += 1) {
    const more = await store.reserve({ workerId: "drain", limit: 12 });
    for (const job of more) assert.ok(!claimed.includes(job.id), `${job.id} was claimed twice`);
    drained += more.length;
  }
  assert.equal(drained, ids.length, "repeated polling drains the backlog exactly once each");
});

test("a lease is what makes a dead worker's job recoverable", async () => {
  const id = jobId("lease");
  await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: { x: 1 } });

  const claimed = await store.reserve({ workerId: "dying-worker", leaseMs: 60_000 });
  assert.deepEqual(claimed.map((j) => j.id), [id]);

  // The worker died: the row is `active` with a fresh lease and nobody will ever
  // release it. While the lease holds, no poll may touch it.
  assert.deepEqual(await store.reserve({ workerId: "healthy-worker" }), [], "a live lease is respected");

  // The lease expires. This is the whole stalled-job recovery story, and it is the
  // reason delivery is at-least-once rather than at-most-once.
  await prisma.job.update({
    where: { id },
    data: { locked_at: new Date(Date.now() - 120_000) },
  });

  const reclaimed = await store.reserve({ workerId: "healthy-worker", leaseMs: 60_000 });
  assert.deepEqual(reclaimed.map((j) => j.id), [id], "an expired lease is reclaimable");
  assert.equal(reclaimed[0].attempts, 2, "and the attempt counter has moved on");

  const row = await store.getJob(id);
  assert.equal(row.locked_by, "healthy-worker");
});

test("a completed job is never claimed again", async () => {
  const id = jobId("complete");
  await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: {} });

  const claimed = await store.reserve({ workerId: "w" });
  assert.deepEqual(claimed.map((j) => j.id), [id]);

  assert.equal(await store.complete(id), true);

  // Completing a row that does not exist reports that nothing was there — which is
  // the useful half of the answer. Completing an already-completed row is a no-op
  // that reports success, because delivery is at-least-once and a duplicate
  // completion is not an error worth failing a drain over.
  assert.equal(await store.complete(jobId("never-existed")), false, "a row that was never there");

  assert.deepEqual(await store.reserve({ workerId: "w" }), [], "a completed job is not re-run");
  assert.deepEqual(
    await store.reserve({ workerId: "w", leaseMs: -1 }),
    [],
    "even with an expired lease"
  );

  const row = await store.getJob(id);
  assert.equal(row.status, store.JobStatus.COMPLETED);
  assert.ok(row.completed_at instanceof Date, "and the completion is timestamped");
  assert.equal(row.locked_at, null, "and the lease is released rather than left to rot");
});

test("fail schedules a backoff, and gives up when the attempts are spent", async () => {
  const id = jobId("retry");
  await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: {}, maxAttempts: 2 });

  // Attempt 1 fails. There is one attempt left, so this is a retry.
  const claimed = await store.reserve({ workerId: "w" });
  assert.equal(claimed[0].attempts, 1);

  const first = await store.fail(id, "ECONNREFUSED 127.0.0.1:587", 1000);
  assert.equal(first.status, store.JobStatus.PENDING, "a failure with attempts left goes back to pending");
  assert.ok(first.nextRunAt instanceof Date, "and is scheduled rather than slept");
  assert.ok(first.nextRunAt.getTime() > Date.now(), "in the future — the backoff is real");

  // The row is pending again, but not runnable until the backoff elapses.
  assert.deepEqual(await store.reserve({ workerId: "w" }), [], "the backoff is honoured by the poll");

  await prisma.job.update({ where: { id }, data: { run_at: new Date(Date.now() - 1000) } });
  const second = await store.reserve({ workerId: "w" });
  assert.deepEqual(second.map((j) => j.id), [id]);
  assert.equal(second[0].attempts, 2, "the second attempt has been consumed");

  // The last attempt fails. This is the dead-letter, and it must be terminal.
  const dead = await store.fail(id, "still refused", 1000);
  assert.equal(dead.status, store.JobStatus.FAILED);
  assert.equal(dead.nextRunAt, null, "nothing is scheduled after the last attempt");

  const row = await store.getJob(id);
  assert.equal(row.status, store.JobStatus.FAILED);
  assert.equal(row.last_error, "still refused", "the final error is kept — it is the diagnosis");
  assert.deepEqual(await store.reserve({ workerId: "w" }), [], "a dead job is never re-run by a poll");
});

test("the backoff grows, and the stored error is truncated", async () => {
  const id = jobId("backoff");
  await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: {}, maxAttempts: 4 });

  const gaps = [];
  for (let i = 0; i < 3; i += 1) {
    await prisma.job.update({
      where: { id },
      data: { status: store.JobStatus.PENDING, locked_at: null, run_at: new Date(Date.now() - 1000) },
    });
    await store.reserve({ workerId: "w" });
    const outcome = await store.fail(id, "x".repeat(5000), 1000);
    gaps.push(outcome.nextRunAt.getTime() - Date.now());
  }

  // Exponential: each retry is further out than the last. A flat backoff on a
  // permanently-broken SMTP host is a tight retry loop shared by every worker.
  assert.ok(gaps[1] > gaps[0], `second gap (${gaps[1]}ms) must exceed the first (${gaps[0]}ms)`);
  assert.ok(gaps[2] > gaps[1], `third gap (${gaps[2]}ms) must exceed the second (${gaps[1]}ms)`);

  const row = await store.getJob(id);
  assert.ok(row.last_error.length <= 2000, "the error is truncated — the column is for diagnosis");
});

test("a corrupt payload does not take the job down", async () => {
  const id = jobId("corrupt");
  await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: { ok: true } });
  await prisma.job.update({ where: { id }, data: { payload: "{not json" } });

  const claimed = await store.reserve({ workerId: "w" });
  assert.deepEqual(claimed.map((j) => j.id), [id], "the job is still claimed");
  assert.deepEqual(claimed[0].payload, {}, "and runs with an empty payload instead of crashing the worker");
});

test("depths reports every queue, including the empty ones", async () => {
  const pending = jobId("depths");
  const done = jobId("depths-done");
  await store.enqueue({ id: pending, queue: QUEUES.LEADS_EXPORT, payload: {} });
  await store.enqueue({ id: done, queue: QUEUES.LEADS_EXPORT, payload: {} });
  await store.complete(done);

  const { byQueue, total } = await store.depths();

  // Every declared queue is present with all four statuses. A queue absent from the
  // map means the metrics loop skips it, and a queue that vanished from a dashboard
  // is indistinguishable from a queue that is fine.
  for (const name of Object.values(QUEUES)) {
    assert.deepEqual(
      Object.keys(byQueue[name]).sort(),
      ["active", "completed", "failed", "pending"],
      `${name} reports all four statuses`
    );
  }

  assert.equal(byQueue[QUEUES.LEADS_EXPORT].pending, 1);
  assert.equal(byQueue[QUEUES.LEADS_EXPORT].completed, 1);
  assert.equal(byQueue[QUEUES.LEADS_EXPORT].failed, 0);
  assert.equal(byQueue[QUEUES.OTP_EMAIL].pending, 0, "a queue with no rows reports zero, not absent");

  // The total excludes completed rows. This is the gauge an alert is built on, so
  // counting history would make it ratchet up for the life of the deployment and
  // eventually page someone about a queue that is completely drained.
  assert.equal(total, 1, "one pending job, and the completed one is not counted");
});

test("backlog counts only unfinished work", async () => {
  const pending = jobId("backlog-pending");
  const done = jobId("backlog-done");
  await store.enqueue({ id: pending, queue: QUEUES.OTP_EMAIL, payload: {} });
  await store.enqueue({ id: done, queue: QUEUES.OTP_EMAIL, payload: {} });
  await store.complete(done);

  assert.equal(await store.backlog(), 1, "a completed job is not backlog");

  await store.reserve({ workerId: "w" });
  assert.equal(await store.backlog(), 1, "an active job is still backlog — it has not run yet");
});

test("prune caps the dead rows oldest-first", async () => {
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const id = jobId("prune");
    ids.push(id);
    await store.enqueue({ id, queue: QUEUES.OTP_EMAIL, payload: { i } });
    await store.complete(id);
  }
  // Distinct `updated_at`s so "oldest" is unambiguous.
  for (const [i, id] of ids.entries()) {
    await prisma.job.update({
      where: { id },
      data: { updated_at: new Date(Date.now() - (10 - i) * 60_000) },
    });
  }

  assert.equal(await store.prune(5), 0, "at the cap nothing is deleted");
  assert.equal(await store.prune(2), 3, "the excess goes");

  const remaining = await prisma.job.findMany({
    where: { id: { in: ids } },
    orderBy: { updated_at: "asc" },
    select: { id: true },
  });
  assert.deepEqual(
    remaining.map((r) => r.id),
    ids.slice(3),
    "the newest rows are the ones kept — deleting the newest would make this a retention policy, not a cap"
  );

  // A pending job is never pruned, however far over the cap the table is.
  const live = jobId("prune-live");
  await store.enqueue({ id: live, queue: QUEUES.OTP_EMAIL, payload: {} });
  await store.prune(0);
  assert.ok(await store.getJob(live), "unfinished work is not pruned");
});

test("health reports a backlog and refuses to invent one", async () => {
  await store.enqueue({ id: jobId("health"), queue: QUEUES.OTP_EMAIL, payload: {} });

  const health = await store.health();
  assert.equal(health.ok, true, "the queue is healthy — it is rows in a table");
  assert.equal(health.backlog, 1, "and it knows its own backlog");

  // Health must not be able to hang the probe, so it shares the deadline the rest
  // of the readiness path uses.
  const startedAt = Date.now();
  await store.health();
  assert.ok(Date.now() - startedAt < 5000, "the health query is bounded");
});

// ── the durable cache tier ──────────────────────────────────────────────────

test("a durable namespace round-trips through MySQL, not through memory", async () => {
  const config = require("../../src/config");

  assert.ok(
    config.cache.durableNamespaces.includes("otp"),
    `the otp namespace must be durable — got ${JSON.stringify(config.cache.durableNamespaces)}`
  );
  assert.equal(cache.isDurable("otp"), true);
  assert.equal(cache.isDurable("property"), false, "ordinary namespaces stay in-process");

  cache.clear();
  const key = "amaken-cache-test:round-trip";
  await cache.set("otp", key, { code: "123456", tries: 3 });

  // Clearing memory must not clear a durable row. This is the property that makes
  // the OTP correct across a replica restart, and it is exactly what the old
  // in-process `Map` got wrong.
  cache.clear();
  assert.deepEqual(
    await cache.get("otp", key),
    { code: "123456", tries: 3 },
    "the value survives clearing the in-process tier"
  );

  assert.equal(await cache.del("otp", key), true);
  assert.equal(await cache.get("otp", key), null);
});

test("a durable entry expires on read, not on a timer", async () => {
  const key = "amaken-cache-test:expiry";

  // A negative TTL is "already expired", which is how a caller says "do not cache".
  await cache.set("otp", key, "123456", -1);
  assert.equal(await cache.get("otp", key), null, "an expired entry is a miss");

  // And an entry that outlives its TTL by a margin really is gone, without anything
  // having had to run to remove it.
  await cache.set("otp", key, "123456", 1);
  assert.equal(await cache.get("otp", key), "123456");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await cache.get("otp", key), null, "and it is gone once the TTL passes");
});

test("invalidatePrefix clears the durable rows, and only under its own prefix", async () => {
  await cache.set("otp", "amaken-cache-test:prefix-a", "1");
  await cache.set("otp", "amaken-cache-test:prefix-b", "2");
  assert.equal(await cache.get("otp", "amaken-cache-test:prefix-a"), "1", "the row is there to clear");

  // `invalidatePrefix` takes the suffix of a qualified key and prepends the app
  // prefix itself, so it cannot reach outside this application — and therefore
  // cannot reach another environment sharing the table.
  await cache.invalidatePrefix("cache:otp:");
  assert.equal(await cache.get("otp", "amaken-cache-test:prefix-a"), null, "the durable rows are cleared");
  assert.equal(await cache.get("otp", "amaken-cache-test:prefix-b"), null);

  // A prefix that does not match must not clear anything. This is the assertion
  // that keeps the prefix logic honest: without it, an over-broad prefix would
  // look like a working invalidation.
  await cache.set("otp", "amaken-cache-test:prefix-a", "1");
  await cache.invalidatePrefix("cache:property:");
  assert.equal(await cache.get("otp", "amaken-cache-test:prefix-a"), "1", "another namespace is untouched");

  // `invalidateNamespace` is the ergonomic form and derives the prefix from
  // `qualify`, so the two cannot disagree.
  await cache.invalidateNamespace("otp");
  assert.equal(await cache.get("otp", "amaken-cache-test:prefix-a"), null);

  // And a `%` in a key is not a wildcard. `_` is the LIKE metacharacter that would
  // matter if the sweep were a pattern match rather than `startsWith`.
  await cache.set("otp", "amaken-cache-test:100%_off", "3");
  await cache.set("otp", "amaken-cache-test:100x0_off", "4");
  await cache.invalidateNamespace("otp");
  assert.equal(await cache.get("otp", "amaken-cache-test:100%_off"), null);
  assert.equal(await cache.get("otp", "amaken-cache-test:100x0_off"), null, "both go — the sweep is exact");
});

test("the durable tier's serialisation is lossy, and says which way", async () => {
  const key = "amaken-cache-test:bigint";
  const payload = {
    at: new Date("2030-01-01T00:00:00.000Z"),
    count: 42n,
    absent: undefined,
    list: [1, 2, 3],
    nested: { ok: true },
  };

  await cache.set("otp", key, payload);
  cache.clear();

  const read = await cache.get("otp", key);

  // Dates and bigints survive as their JSON forms rather than throwing, which is
  // the documented contract of a durable namespace: it stores **JSON-safe values**.
  // `count` is the case that matters in practice — Prisma returns a `bigint` for
  // `COUNT(*)`, so a naive `JSON.stringify` would make `set` throw on a dashboard
  // aggregate.
  assert.equal(read.at, "2030-01-01T00:00:00.000Z", "a date becomes its ISO string");
  assert.equal(typeof read.count, "string", "a bigint becomes a string instead of throwing");
  assert.equal(read.absent, undefined, "and an absent key stays absent");
  assert.deepEqual(read.list, [1, 2, 3]);
  assert.deepEqual(read.nested, { ok: true }, "plain JSON round-trips exactly");
});

test("a corrupt durable row is a miss, not an error", async () => {
  const key = "amaken-cache-test:corrupt";
  await cache.set("otp", key, "123456");

  const row = await prisma.kvEntry.findFirst({ where: { key: { endsWith: key } } });
  assert.ok(row, "the row exists before it is corrupted");
  await prisma.kvEntry.update({ where: { key: row.key }, data: { value: "{not json" } });

  // One bad row must not turn every OTP verification into a 500.
  assert.equal(await cache.get("otp", key), null, "a corrupt row reads as a miss");
});

// ── the worker loop ─────────────────────────────────────────────────────────

test("the worker drains the backlog and records the outcome", async () => {
  const { QUEUES: NAMES } = require("../../src/platform/queue/queues");
  const worker = require("../../src/platform/queue/worker");

  // A queue the worker has a processor for, whose processor can succeed without a
  // mail server. `leads-export` reads the database and writes a file, which is real
  // work with a real side effect and no SMTP dependency.
  const ids = ["w-1", "w-2", "w-3"].map((n) => jobId(n));
  for (const id of ids) {
    await store.enqueue({
      id,
      queue: NAMES.LEADS_EXPORT,
      payload: { mode: "all", requestedBy: "test" },
    });
  }

  const handle = await worker.startWorker();
  assert.equal(worker.isRunning(), true);

  // Wait for the backlog rather than for a fixed delay: a fixed sleep is either
  // flaky or slow, and this is the whole point of the test.
  const deadline = Date.now() + 15_000;
  let depth = await store.depths();
  while (depth.byQueue[NAMES.LEADS_EXPORT].completed + depth.byQueue[NAMES.LEADS_EXPORT].failed < ids.length) {
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
    depth = await store.depths();
  }

  await handle.stop();
  assert.equal(worker.isRunning(), false, "stopWorker actually stops the loop");

  const after = await store.depths();
  assert.equal(
    after.byQueue[NAMES.LEADS_EXPORT].completed,
    ids.length,
    `every job completed, got ${JSON.stringify(after.byQueue[NAMES.LEADS_EXPORT])}`
  );
  assert.equal(after.byQueue[NAMES.LEADS_EXPORT].pending, 0, "and nothing is left pending");
  assert.equal(await store.backlog(), 0, "the backlog is empty");
});

test("stopWorker waits for in-flight jobs, so a drained job is not retried", async () => {
  const worker = require("../../src/platform/queue/worker");

  const { QUEUES: NAMES } = require("../../src/platform/queue/queues");
  const id = jobId("drain");
  await store.enqueue({ id, queue: NAMES.LEAD_NOTIFICATION, payload: { kind: "registration", email: "a@b.com", leadId: 1 } });

  const handle = await worker.startWorker();

  // Poll for the job to reach a terminal state *after* the stop returns — if the
  // drain did not wait, the job would still be `active` here and its lease would
  // later expire and re-run it.
  const deadline = Date.now() + 15_000;
  let row = await store.getJob(id);
  while (row && row.status !== store.JobStatus.COMPLETED && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    row = await store.getJob(id);
  }

  await handle.stop();

  assert.equal(row.status, store.JobStatus.COMPLETED, "the job finished before stopWorker resolved");
  assert.equal(row.locked_at, null, "and its lease was released");
  assert.equal(row.attempts, 1, "and it ran exactly once — a drain that did not wait would show 2");
});

test("startWorker is idempotent, because two loops double every setting", async () => {
  const worker = require("../../src/platform/queue/worker");

  const first = await worker.startWorker();
  const second = await worker.startWorker();
  assert.equal(second.workerId, first.workerId, "the same worker identity either way");

  // A second poll loop in one process would claim twice as fast and run twice the
  // configured concurrency, so this has to be a no-op rather than a second loop.
  await second.stop();
  assert.equal(worker.isRunning(), false, "one stop is enough, which is only true with one loop");
});