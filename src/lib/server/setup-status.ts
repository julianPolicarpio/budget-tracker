/**
 * What is still unset, for the door badge.
 *
 * These live on the DOOR rather than on Today, deliberately. §8.1 closes
 * Today's widget list — "the pressure to add 'just the Spend balance' will be
 * constant and must lose every time" — and a setup reminder is exactly the
 * kind of reasonable-sounding addition that list exists to refuse.
 *
 * The accepted cost is that a badge nobody opens the door to see does nothing.
 * That is why setup asks for a bills figure up front rather than leaving the
 * first band to depend on this.
 */
import { and, gt } from 'drizzle-orm';
import { forUser } from './db';
import * as schema from './db/schema';
import { listIncomeSources } from './income';

export interface SetupTodo {
	/** Only the one source setup created — a second job, a side income. */
	incomeSources: boolean;
	/** Every account still reads zero: no balance has ever been asserted. */
	balances: boolean;
	/** Nothing in subscriptions, so the bills figure is still the rough one. */
	commitments: boolean;
	count: number;
}

export function setupTodo(userId: number): SetupTodo {
	const { db, owns } = forUser(userId);

	const incomeSources = listIncomeSources(userId).length < 2;

	const funded = db
		.select({ id: schema.account.id })
		.from(schema.account)
		.where(and(owns(schema.account), gt(schema.account.balanceMinor, 0)))
		.get();

	const commitment = db
		.select({ id: schema.subscription.id })
		.from(schema.subscription)
		.where(owns(schema.subscription))
		.get();

	const todo = {
		incomeSources,
		balances: funded === undefined,
		commitments: commitment === undefined
	};

	return { ...todo, count: Object.values(todo).filter(Boolean).length };
}
