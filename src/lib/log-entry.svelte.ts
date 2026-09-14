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
