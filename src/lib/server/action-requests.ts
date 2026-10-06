import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { forUser, schema } from '$lib/server/db';
import type { PanelResult } from './panel-forms';

class DeclinedAction extends Error {
	constructor(readonly result: PanelResult) {
		super('The action was not saved.');
	}
}

function fingerprint(form: FormData): string {
	const fields = [...form.entries()]
		.filter(([name]) => name !== 'clientUuid')
		.map(([name, value]) => [name, String(value)])
		.sort(([nameA, valueA], [nameB, valueB]) =>
			nameA === nameB ? valueA.localeCompare(valueB) : nameA.localeCompare(nameB)
		);
	return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Persist the effect and its receipt in the same SQLite transaction. A retry
 * returns the original receipt; reusing a key for changed input is a conflict.
 */
export function runActionOnce(
	userId: number,
	operation: string,
	requestId: string | null,
	form: FormData,
	apply: () => PanelResult
): PanelResult {
	if (!requestId) return apply();
	const inputHash = fingerprint(form);
	const { db, owns } = forUser(userId);

	try {
		return db.transaction((tx) => {
			const prior = tx
				.select()
				.from(schema.actionRequest)
				.where(
					and(
						owns(schema.actionRequest),
						eq(schema.actionRequest.clientUuid, requestId)
					)
				)
				.get();
			if (prior) {
				if (prior.operation !== operation || prior.inputHash !== inputHash) {
					return {
						fail: [409, { error: 'This save request was already used for different details.' }]
					} as PanelResult;
				}
				return JSON.parse(prior.resultJson) as PanelResult;
			}

			const result = apply();
			if ('fail' in result) throw new DeclinedAction(result);
			tx.insert(schema.actionRequest)
				.values({
					userId,
					clientUuid: requestId,
					operation,
					inputHash,
					resultJson: JSON.stringify(result),
					createdAt: new Date().toISOString()
				})
				.run();
			return result;
		});
	} catch (error) {
		if (error instanceof DeclinedAction) return error.result;
		throw error;
	}
}
