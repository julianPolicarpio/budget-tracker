import { startScheduler } from '$lib/server/jobs';

// One process, one scheduler. Rollover and backup are idempotent and keyed by
// date, so this is safe on every restart (Spec §3).
startScheduler();
