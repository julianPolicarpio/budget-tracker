<script lang="ts">
	/**
	 * "Money back" (A6 op 8), extracted from Today's own inline markup so the
	 * typing bar's action view can render the same form (Task 2c). Behaviour is
	 * preserved exactly from the original `<details class="money-move">`
	 * block in `src/routes/+page.svelte`:
	 *  - a fresh `client_uuid` per submit, regenerated only after a real
	 *    success (see `?/refundMoney` in +page.server.ts for the server-side
	 *    half of that dedupe guarantee);
	 *  - a `fail()` response's typed values survive in `formState`, with
	 *    per-field error text next to the field that caused it;
	 *  - no note field — the original form never had one, even though the
	 *    `?/refundMoney` action accepts one; not invented here.
	 *
	 * One deliberate difference from the original: the expense picker's
	 * label text now comes straight from `refundable[].name`, which
	 * `$lib/actions/context.ts` already formats as "<date> · <category>
	 * (<note>) · <amount>" using the raw ISO date rather than Today's
	 * `dayLabel()` weekday format. That is the point of Spec A6's "duplicate
	 * accounting code across routes" — this candidate list is now the one
	 * shared definition Today and the panel both read, rather than Today
	 * keeping its own query and its own formatting for the same rows.
	 *
	 * Original also only rendered this form at all when `refundCandidates`
	 * was non-empty. The catalogue's "Record a refund" entry has no such
	 * conditional — Spec A7 groups are stable and always listed — so an
	 * empty `refundable` is now handled here as an honest empty state
	 * instead of an unreachable required <select> with nothing to pick.
	 *
	 * Invariant 1 (Spec A2 "no-balances rule"): `accounts` is
	 * `Selectable[]` — id/name/hint only. `refundable`'s `name` carries an
	 * already-recorded expense amount, which Spec A2 explicitly allows
	 * ("Show entered amounts... without leaking precise available-to-spend
	 * totals") and `context.ts`'s module doc calls out as the one sanctioned
	 * exception — never a balance or a remaining figure.
	 */
	import { enhance } from '$app/forms';
	import type { Selectable } from '$lib/actions/context';

	interface Props {
		refundable: readonly Selectable[];
		accounts: readonly Selectable[];
		/** Called once the refund is actually recorded — the panel closes
		 * itself and returns focus to its trigger. */
		onSaved: () => void;
	}

	let { refundable, accounts, onSaved }: Props = $props();

	let uuid = $state(crypto.randomUUID());
	let formState = $state<Record<string, unknown> | null>(null);

	const onEnhance = () => {
		formState = null;
		return async ({ result }: { result: Record<string, unknown> }) => {
			if (result.type === 'failure') {
				formState = (result.data ?? {}) as Record<string, unknown>;
			} else {
				uuid = crypto.randomUUID();
				onSaved();
			}
		};
	};
</script>

{#if refundable.length === 0}
	<p class="empty">No recent expense to refund yet — log the original spend first.</p>
{:else}
	<form method="POST" action="?/refundMoney" use:enhance={onEnhance}>
		<input type="hidden" name="clientUuid" value={uuid} />
		<label class="field">
			<span class="field-label">Which expense</span>
			<select name="originalTxnId" required>
				<option value="" disabled selected>Pick the expense</option>
				{#each refundable as candidate (candidate.id)}
					<option value={candidate.id}>{candidate.name}</option>
				{/each}
			</select>
		</label>
		{#if formState?.field === 'expense'}
			<p class="field-err">{formState.error}</p>
		{/if}
		<label class="field">
			<span class="field-label">Amount refunded</span>
			<input
				name="amount"
				type="text"
				inputmode="decimal"
				autocomplete="off"
				required
				value={formState?.field === 'amount' && formState?.rawAmount ? formState.rawAmount : ''}
				aria-invalid={formState?.field === 'amount' ? 'true' : undefined}
			/>
		</label>
		{#if formState?.field === 'amount'}
			<p class="field-err">{formState.error}</p>
		{/if}
		<label class="field">
			<span class="field-label">Where the money goes</span>
			<select name="accountId" required>
				<option value="" disabled selected>Pick a bucket</option>
				{#each accounts as account (account.id)}
					<option value={account.id}>{account.name}</option>
				{/each}
			</select>
		</label>
		{#if formState?.field === 'accountId'}
			<p class="field-err">{formState.error}</p>
		{/if}
		<button class="move-save" type="submit">Record the refund</button>
	</form>
{/if}

<style>
	/* Same tokens as RecordIncomeForm.svelte's ported styles — see that
	   file's comment for why these differ from the original inline block. */
	.empty {
		font-size: 0.875rem;
		color: var(--ink-muted);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.field-label {
		font-size: 0.8125rem;
		color: var(--ink-secondary);
	}

	.field input,
	.field select {
		font: inherit;
		color: var(--ink);
		background: transparent;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		padding: 0.5rem 0.625rem;
		min-height: var(--touch);
	}

	.field input[aria-invalid='true'] {
		border-color: var(--status-critical);
	}

	.field-err {
		font-size: 0.8125rem;
		color: var(--status-critical);
	}

	.move-save {
		font: inherit;
		border: 0;
		border-radius: 0.375rem;
		background: var(--accent-solid);
		color: #fff;
		padding: 0.625rem 1rem;
		min-height: var(--touch);
		cursor: pointer;
	}
</style>
