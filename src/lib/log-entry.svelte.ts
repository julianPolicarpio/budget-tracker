/**
 * The log entry, shared by both shells.
 *
 * Today has two interaction models — a resident thumb-first form on mobile
 * (§8.0b.4: the nightly log happens in bed) and a summoned overlay on desktop
 * (§8.0b.2: nothing may compete with the hero). They share this state and the
 * submit handler below, so there is exactly one save path. Forking it would
 * mean two places to keep the idempotency key, the reset and the validation in
 * step, and they would drift.
 */

import type { SubmitFunction } from '@sveltejs/kit';

export type PlannedFlag = '' | '0' | '1';

export interface EntrySnapshot {
	amount: string;
	category: string;
	planned: PlannedFlag;
}

export class LogEntry {
	amount = $state('');
	category = $state('');
	planned = $state<PlannedFlag>('');
	/** Idempotency key — a double submit is a repeat, not a second purchase. */
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

	snapshot(): EntrySnapshot {
		return { amount: this.amount, category: this.category, planned: this.planned };
	}

	reset(): void {
		this.amount = '';
		this.category = '';
		this.planned = this.defaultPlanned;
		this.clientUuid = newUuid();
	}
}

function newUuid(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

/**
 * The one save path. Captures what was entered before the reset clears it, so
 * the desktop toast can name it back.
 */
export function logSubmit(entry: LogEntry, onSaved?: (s: EntrySnapshot) => void): SubmitFunction {
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
