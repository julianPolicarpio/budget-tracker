<script lang="ts">
	/**
	 * "Fund a planned expense" (Spec A6) — the quick form for adding money to
	 * a set-aside, posting to Today's own page action (`?/fundPlannedExpense`,
	 * added to `src/routes/+page.server.ts`) rather than reaching across to
	 * `/irregulars?/fund`. Same relative-URL rule as the two sibling forms.
	 *
	 * Three of the four money shapes the operation supports are expressible
	 * here, all through the server's own contract:
	 *  - fill the bucket with money that is already in it (`sourceAccountId`
	 *    left blank — assign in place);
	 *  - move money in from another bucket (`sourceAccountId` picked);
	 *  - an amount the server rejects because it exceeds what the source can
	 *    give: the 400/409 carries `rawAmount`, so the typed string is put
	 *    back in the input instead of being silently cleared.
	 *
	 * Behaviour is copied from RecordIncomeForm.svelte: a fresh `client_uuid`
	 * per submit, regenerated only after a real success; the enhance callback
	 * never calls `update()`; `fail()` data drives the per-field error text.
	 *
	 * Invariant 1 (Spec A2 "no-balances rule"): both props are
	 * `Selectable[]` — id/name/hint only. This form never receives, stores,
	 * or displays a balance, and it never decides how much a bucket can give.
	 */
	import { enhance } from '$app/forms';
	import type { Selectable } from '$lib/actions/context';

	interface Props {
		plannedExpenses: readonly Selectable[];
		accounts: readonly Selectable[];
		/** Called once the set-aside is actually recorded — the panel closes
		 * itself and returns focus to its trigger. */
		onSaved: () => void;
	}

	let { plannedExpenses, accounts, onSaved }: Props = $props();

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

{#if plannedExpenses.length === 0}
	<p class="empty">Nothing is planned yet — create a planned expense first.</p>
{:else}
	<form method="POST" action="?/fundPlannedExpense" use:enhance={onEnhance}>
		<input type="hidden" name="clientUuid" value={uuid} />
		<label class="field">
			<span class="field-label">Planned expense</span>
			<select name="irregularId" required>
				<option value="" disabled selected>Pick what you are setting money aside for</option>
				{#each plannedExpenses as expense (expense.id)}
					<option value={expense.id}
						>{expense.name}{expense.hint ? ` — ${expense.hint}` : ''}</option
					>
				{/each}
			</select>
		</label>
		<label class="field">
			<span class="field-label">Bucket to fill</span>
			<select name="accountId" required>
				<option value="" disabled selected>Pick the bucket it is set aside in</option>
				{#each accounts as account (account.id)}
					<option value={account.id}>{account.name}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			<span class="field-label">Also move money from <span class="opt">(optional)</span></span>
			<select name="sourceAccountId">
				<option value="">No — assign money already in the bucket</option>
				{#each accounts as account (account.id)}
					<option value={account.id}>{account.name}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			<span class="field-label">Amount</span>
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
			<span class="field-label">Note <span class="opt">(optional)</span></span>
			<input name="note" type="text" autocomplete="off" />
		</label>
		{#if formState?.error && !formState?.field}
			<p class="form-err" role="alert">{formState.error}</p>
		{/if}
		<button class="move-save" type="submit">Set it aside</button>
	</form>
{/if}

<style>
	/* Same tokens as RecordIncomeForm.svelte's ported styles — see that
	   file's comment for why these differ from Today's original inline block. */
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

	.field-label .opt {
		color: var(--ink-muted);
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

	.field-err,
	.form-err {
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
