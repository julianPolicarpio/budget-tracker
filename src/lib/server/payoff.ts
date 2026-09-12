/**
 * The payoff price switch (Spec §6.3, Method Part IV debt sub-rule).
 *
 * You have a mathematically optimal order (highest rate first — avalanche) and
 * a motivationally optimal one (smallest balance first — snowball). Brown &
 * Lahey found the ascending arrangement produced significantly faster work
 * through post-subgoal motivation: finishing a small chunk raises self-efficacy
 * for the next (F12). The authors also caveat that interest differentials can
 * offset the gain.
 *
 * So this is not a doctrine. It computes what the motivation costs, and then
 * you choose knowingly. All three numbers are always shown.
 */

export interface DebtInput {
	id: number;
	label: string;
	balanceMinor: number;
	aprBp: number;
	minPaymentMinor: number;
}

export interface Simulation {
	order: number[];
	months: number;
	totalInterestMinor: number;
	/** True when minimums never clear the interest — the plan does not terminate. */
	stalled: boolean;
	cleared: { id: number; label: string; month: number }[];
}

/** Beyond this the plan is not a plan. 50 years. */
const MAX_MONTHS = 600;

/**
 * Standard amortisation: each month pay minimums on all, throw everything
 * remaining at the head of the order, and roll a cleared debt's payment into
 * the next one.
 */
export function simulate(
	debts: DebtInput[],
	monthlyExtraMinor: number,
	orderBy: (a: DebtInput, b: DebtInput) => number
): Simulation {
	const queue = [...debts].sort(orderBy);
	const order = queue.map((d) => d.id);
	const balances = new Map(queue.map((d) => [d.id, d.balanceMinor]));
	const cleared: Simulation['cleared'] = [];

	let totalInterestMinor = 0;
	let months = 0;

	while (months < MAX_MONTHS) {
		const live = queue.filter((d) => (balances.get(d.id) ?? 0) > 0);
		if (live.length === 0) break;
		months++;

		// Interest first, on the balance carried into the month.
		for (const d of live) {
			const balance = balances.get(d.id)!;
			const interest = Math.round((balance * d.aprBp) / (10_000 * 12));
			balances.set(d.id, balance + interest);
			totalInterestMinor += interest;
		}

		// Minimums, then everything left over at the head of the queue. A cleared
		// debt frees its minimum into the same pot, which is the snowball roll.
		let pot = monthlyExtraMinor;
		for (const d of live) pot += d.minPaymentMinor;

		for (const d of live) {
			if (pot <= 0) break;
			const balance = balances.get(d.id)!;
			if (balance <= 0) continue;

			const pay = Math.min(pot, balance);
			balances.set(d.id, balance - pay);
			pot -= pay;

			if (balance - pay <= 0) cleared.push({ id: d.id, label: d.label, month: months });
		}

		// Nothing moved: the minimums do not cover the interest.
		const stillOwed = queue.reduce((sum, d) => sum + Math.max(0, balances.get(d.id) ?? 0), 0);
		if (stillOwed > 0 && pot === monthlyExtraMinor && months > 1) {
			const paidAnything = live.some((d) => (balances.get(d.id) ?? 0) < d.balanceMinor);
			if (!paidAnything) return { order, months, totalInterestMinor, stalled: true, cleared };
		}
	}

	const stalled = months >= MAX_MONTHS;
	return { order, months, totalInterestMinor, stalled, cleared };
}

export type PayoffMode = 'snowball' | 'hybrid' | 'avalanche';

export interface PayoffPlan {
	mode: PayoffMode;
	order: number[];
	rationale: string;
	avalanche: Simulation;
	snowball: Simulation;
	hybrid: Simulation;
	/** What the snowball order costs over the avalanche, in interest. */
	priceMinor: number;
	monthsCost: number;
}

const byApr = (a: DebtInput, b: DebtInput) => b.aprBp - a.aprBp;
const byBalance = (a: DebtInput, b: DebtInput) => a.balanceMinor - b.balanceMinor;

/**
 * Price the motivation, then choose.
 *
 * Under one period of Spend, buy it — it is cheap and the effect is real and
 * measured. Over that, optimise, but still carve out one exception: clear the
 * single smallest balance first regardless, to bank one subgoal completion
 * (F12), then switch to strict avalanche.
 */
export function payoffPlan(
	debts: DebtInput[],
	monthlyExtraMinor: number,
	spendAllocationMinor: number
): PayoffPlan | null {
	const live = debts.filter((d) => d.balanceMinor > 0);
	if (live.length === 0) return null;

	const avalanche = simulate(live, monthlyExtraMinor, byApr);
	const snowball = simulate(live, monthlyExtraMinor, byBalance);

	const priceMinor = snowball.totalInterestMinor - avalanche.totalInterestMinor;
	const monthsCost = snowball.months - avalanche.months;

	// Smallest balance first, then strict avalanche on the rest.
	const smallest = [...live].sort(byBalance)[0];
	const rest = live.filter((d) => d.id !== smallest.id).sort(byApr);
	const hybridOrder = [smallest, ...rest];
	const hybrid = simulate(hybridOrder, monthlyExtraMinor, () => 0);

	if (priceMinor <= spendAllocationMinor) {
		return {
			mode: 'snowball',
			order: snowball.order,
			rationale:
				'The extra interest is less than one period of Spend. Buy the motivation — ' +
				'finishing a small balance raises self-efficacy for the next one, and that ' +
				'effect is real and measured.',
			avalanche,
			snowball,
			hybrid,
			priceMinor,
			monthsCost
		};
	}

	const hybridPrice = hybrid.totalInterestMinor - avalanche.totalInterestMinor;
	return {
		mode: hybridPrice <= spendAllocationMinor ? 'hybrid' : 'avalanche',
		order: hybridPrice <= spendAllocationMinor ? hybrid.order : avalanche.order,
		rationale:
			hybridPrice <= spendAllocationMinor
				? 'Snowball costs more than one period of Spend, so this clears the smallest ' +
					'balance first for one subgoal completion and then optimises. The price of ' +
					'that one completion is in the table below.'
				: 'Both motivational orders cost more than a period of Spend here. Optimise — ' +
					'but the other two costs are below, and buying the motivation anyway is a ' +
					'legitimate choice as long as you can see what it costs.',
		avalanche,
		snowball,
		hybrid,
		priceMinor,
		monthsCost
	};
}
