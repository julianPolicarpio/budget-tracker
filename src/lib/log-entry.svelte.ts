/**
 * The log entry, shared by both shells (Spec §5.6, task A4b).
 *
 * Today has two interaction models — a resident thumb-first form on mobile
 * (§8.0b.4: the nightly log happens in bed) and a summoned overlay on desktop
 * (§8.0b.2: nothing may compete with the hero). They share this state and the
 * submit handler below, so there is exactly one save path. Forking it would
 * mean two places to keep the idempotency key, the reset and the validation
 * in step, and they would drift.
 *
 * Two entry shapes live here on purpose:
 *
 *   - `LogEntry` is the NEW typed-entry field this task builds: one string,
 *     resolved client-side by `entry-parser.ts`'s `parseEntry()` against a
 *     `ParseContext` fetched once at page load (no network round trip per
 *     keystroke, per that module's own design note).
 *   - `TripEntry` is the OLD amount/category/planned form, kept verbatim for
 *     the one case A4a's router does not cover: `commitResolvedEntry()` has
 *     no trip fields at all (no `tripId`, no local-vs-home amount), so a
 *     trip in progress still logs through the pre-A4 path. Wiring trips into
 *     the typed router is out of this task's scope — see A4b's report.
 */

import type { SubmitFunction } from '@sveltejs/kit';
import { parseEntry, type ParseContext, type ParsedEntry } from './entry-parser';
import type { CategoryKey } from './categories';
import * as outbox from './outbox';

export type PlannedFlag = '' | '0' | '1';

// ───────────────────────────────────────────────────────────────────────────
// The new typed entry (this task).
// ───────────────────────────────────────────────────────────────────────────

export type CommitmentMode = '' | 'same' | 'same_essential' | 'varies';

export class LogEntry {
	/** What the user typed, verbatim — e.g. "kape 65". Sans-serif on screen;
	 * the resolution line beneath it is what turns mono (Spec §5.6's split). */
	text = $state('');
	/** `transaction` only. */
	planned = $state<PlannedFlag>('');
	/** `new_commitment` only — the three-way question's answer. */
	commitmentMode = $state<CommitmentMode>('');
	/** Idempotency key — a double submit is a repeat, not a second purchase. */
	clientUuid = $state('');

	/**
	 * Set once, the moment a category chip answers an `ask_category` question
	 * this session (Spec §5.9 step 1). Carried to the server as hidden fields
	 * so `answerWord()` can persist `label_map` BEFORE the save re-resolves
	 * the text — and overlaid onto the LIVE resolution locally (`resolveLive`
	 * below) so the P/U row appears immediately, with no round trip to wait
	 * on. Harmless if the typed word later changes: the overlay only ever
	 * matches on this exact word, same as a real `label_map` row would.
	 */
	taughtWord = $state('');
	taughtEnglish = $state('');
	taughtRoot = $state<CategoryKey | ''>('');

	constructor() {
		this.clientUuid = newUuid();
	}

	/** Answers this session's open `ask_category` question (Spec §5.9). */
	teach(word: string, english: string, root: CategoryKey): void {
		this.taughtWord = word;
		this.taughtEnglish = english;
		this.taughtRoot = root;
	}

	reset(): void {
		this.text = '';
		this.planned = '';
		this.commitmentMode = '';
		this.taughtWord = '';
		this.taughtEnglish = '';
		this.taughtRoot = '';
		this.clientUuid = newUuid();
	}
}

/**
 * The live resolution, run purely in the browser (A4a's whole point). Layers
 * this session's just-taught word over the server-supplied `ParseContext` so
 * answering the category question resolves to a transaction immediately,
 * without waiting on a save round trip.
 */
export function resolveLive(entry: LogEntry, ctx: ParseContext, minorUnits: number): ParsedEntry {
	const learned = entry.taughtWord
		? {
				...ctx.learned,
				[entry.taughtWord]: {
					english: entry.taughtEnglish,
					root: entry.taughtRoot as CategoryKey,
					leafId: null
				}
			}
		: ctx.learned;
	return parseEntry(entry.text, { ...ctx, learned }, minorUnits);
}

/**
 * Which action row a resolved kind gets (Spec §5.6's table — "chosen by
 * kind, not merely disabled"). `existing_commitment` splits in two here
 * because a fixed subscription and a varying irregular act differently even
 * though they share one `RecordKind`.
 */
export type ActionKind =
	| 'none' // empty / need_word — nothing typed yet worth acting on
	| 'question' // ask_kind / ask_category — the chips themselves ARE the resolution
	| 'transaction'
	| 'existing_fixed'
	| 'existing_varying'
	| 'new_commitment'
	| 'transfer';

export function actionKindFor(resolved: ParsedEntry): ActionKind {
	switch (resolved.kind) {
		case 'empty':
		case 'need_word':
			return 'none';
		case 'ask_kind':
		case 'ask_category':
			return 'question';
		case 'transaction':
			return 'transaction';
		case 'transfer':
			return 'transfer';
		case 'new_commitment':
			return 'new_commitment';
		case 'existing_commitment':
			return resolved.commitment.kind === 'subscription' ? 'existing_fixed' : 'existing_varying';
	}
}

/**
 * The consequence tag — last on the resolution line, always rendered as
 * TEXT (never colour alone, per A4b's accessibility requirement). `null`
 * while the kind is still an open question: there is no consequence to
 * state until it is answered.
 */
export function consequenceText(resolved: ParsedEntry): string | null {
	switch (resolved.kind) {
		case 'transaction':
			return "today's spend";
		case 'existing_commitment':
		case 'new_commitment':
			return "not today's spend";
		case 'transfer':
			return "doesn't change today";
		default:
			return null;
	}
}

export function questionText(resolved: ParsedEntry): string | null {
	if (resolved.kind === 'ask_category') return 'New word — which of the eight?';
	if (resolved.kind === 'ask_kind') return 'One-off, or does it repeat?';
	return null;
}

/**
 * `ask_kind`'s "Just this once" answer (Spec §5.6 rule 4). Rule 4 fires on a
 * bare bill-word with no cadence; stripping that word out of the TEXT and
 * re-running the same `parseEntry()` is what actually resolves the question
 * — rule 4 no longer matches, so routing falls through to rule 5 (guess the
 * category freely, or ask which of the eight).
 *
 * This regex mirrors entry-parser.ts's private `BILL_WORD` rather than
 * importing it: that module owns the ROUTING decision, this only edits the
 * typed text so the same router can reclassify it. If the router's bill-word
 * list ever changes, this one needs the matching edit.
 */
const BILL_WORD_UI = /\b(bill|subscription|renews|plan)\b/i;

export function answerAskOnce(raw: string): string {
	return raw.replace(BILL_WORD_UI, ' ').trim().replace(/\s+/g, ' ');
}

export type CadenceWord = 'weekly' | 'fortnightly' | 'monthly' | 'yearly';

/**
 * `ask_kind`'s "It repeats" answer. Appending a cadence word is what moves
 * the text from rule 4 (bare bill word, ask) to rule 3 (cadence word,
 * `new_commitment`) on the next parse — same mechanism as "Just this once"
 * above, just adding a word instead of removing one.
 */
export function answerAskRepeats(raw: string, cadence: CadenceWord): string {
	return `${raw.trim()} ${cadence}`;
}

function newUuid(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

/**
 * The one save path for the typed entry. `getResolved` is read at SUBMIT
 * time (not when this factory runs), so it must be a live accessor — a
 * `$derived` read through a closure — matching the resolution that was on
 * screen when the tap happened.
 */
export function logSubmit(
	entry: LogEntry,
	getResolved: () => ParsedEntry,
	onSaved?: (s: ParsedEntry) => void
): SubmitFunction {
	return () => {
		const saved = getResolved();
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') {
				entry.reset();
				onSaved?.(saved);
			}
		};
	};
}

/**
 * The offline-safe save path (Spec §6, task A5) — what `+page.svelte` and
 * `LogOverlay.svelte` actually wire the typed-entry form to now, in place of
 * `logSubmit` above. `logSubmit` itself is left exactly as it was (it is
 * still directly imported and tested by name in `log-entry.test.ts`); this
 * is a second, separate factory rather than a rewrite of the first.
 *
 * The owner's own words are the spec here: *"i need it to log fast but the
 * web is not loading fast enough and the data signal is not reliable."* So
 * the outbox write and the field clear happen BEFORE the network is even
 * asked — `outbox.enqueue()` is fired without awaiting it, `entry.reset()`
 * runs the same tick, and only THEN does `use:enhance`'s own fetch get
 * dispatched (SvelteKit calls this factory synchronously and only builds the
 * request after it returns — see `node_modules/@sveltejs/kit/src/runtime/
 * app/forms.js`'s `handle_submit`). Whether that fetch takes 40ms or never
 * resolves at all, the field has already cleared.
 *
 * `result.type === 'error'` is what a dead connection actually produces from
 * `enhance` (a thrown fetch is caught there and turned into that result,
 * never left to reject) — deliberately NOT passed to `update()`, because the
 * default fallback for an 'error' result navigates to the nearest error
 * boundary, which is exactly wrong for "no signal, try again later". The row
 * `outbox.enqueue()` wrote simply stays queued; nothing else has to happen.
 */
export function offlineLogSubmit(
	entry: LogEntry,
	getResolved: () => ParsedEntry,
	userId: number,
	onSaved?: (s: ParsedEntry) => void,
	onQueueChanged?: () => void
): SubmitFunction {
	return () => {
		const saved = getResolved();
		const snapshot = {
			userId,
			text: entry.text,
			planned: entry.planned,
			commitmentMode: entry.commitmentMode,
			taughtWord: entry.taughtWord,
			taughtEnglish: entry.taughtEnglish,
			taughtRoot: entry.taughtRoot,
			clientUuid: entry.clientUuid
		};

		// Queue, then clear — both synchronous from the caller's point of
		// view; the IndexedDB write itself is async, but nothing here waits
		// on it before the field goes blank.
		const queued = outbox
			.enqueue(snapshot)
			.catch((err) => {
				// IndexedDB failing at all (quota, private-mode restrictions) is
				// rare enough that surfacing it to the console is enough — the
				// field has already cleared and there is no queued row to show
				// for it, which is the one case this design does not cover.
				console.error('[split] failed to queue offline entry', err);
				return null;
			})
			.finally(() => onQueueChanged?.());
		entry.reset();

		return async ({ result, update }) => {
			if (result.type === 'success') {
				await update({ reset: false });
				const row = await queued;
				if (row) await outbox.remove(row.id).finally(() => onQueueChanged?.());
				onSaved?.(saved);
				return;
			}
			if (result.type === 'failure') {
				/*
				 * An online rejection. The row STAYS queued — the entry is real and
				 * discarding it would lose money the user typed — but the reason is
				 * recorded on it, because some rejections are permanent.
				 *
				 * A wrong ORIGIN, or a word the server wants answered, will refuse
				 * the identical replay every time. Without this the only symptom is
				 * a count that never goes down while everything looks fine, which
				 * is exactly how two entries sat refused for a day.
				 */
				const row = await queued;
				const why =
					(result.data as { error?: string } | undefined)?.error ?? 'The server refused it.';
				if (row) await outbox.markFailed(row.id, why).finally(() => onQueueChanged?.());
				await update({ reset: false });
			}
			// 'error' (no network at all): do nothing. See doc comment above.
		};
	};
}

// ───────────────────────────────────────────────────────────────────────────
// The OLD amount/category/planned entry — trips only (see module doc above).
// ───────────────────────────────────────────────────────────────────────────

export interface TripSnapshot {
	amount: string;
	category: string;
	planned: PlannedFlag;
}

export class TripEntry {
	amount = $state('');
	category = $state('');
	planned = $state<PlannedFlag>('');
	clientUuid = $state('');

	readonly defaultPlanned: PlannedFlag;

	constructor(defaultPlanned: PlannedFlag = '') {
		this.defaultPlanned = defaultPlanned;
		this.planned = defaultPlanned;
		this.clientUuid = newUuid();
	}

	get ready(): boolean {
		return this.amount.trim() !== '' && this.category !== '' && this.planned !== '';
	}

	snapshot(): TripSnapshot {
		return { amount: this.amount, category: this.category, planned: this.planned };
	}

	reset(): void {
		this.amount = '';
		this.category = '';
		this.planned = this.defaultPlanned;
		this.clientUuid = newUuid();
	}
}

/**
 * The trip form's save path — unchanged from before A4b beyond the rename
 * (was `LogEntry/logSubmit`). Captures what was entered before the reset
 * clears it, so the desktop toast can name it back.
 */
export function tripSubmit(entry: TripEntry, onSaved?: (s: TripSnapshot) => void): SubmitFunction {
	return () => {
		const saved = entry.snapshot();
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') {
				entry.reset();
				onSaved?.(saved);
			}
		};
	};
}
