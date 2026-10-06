<script lang="ts">
	/**
	 * "Move money between purposes" (Spec A6). The same operation as
	 * TransferMoneyForm.svelte and the same POST target (`?/transferMoney` on
	 * Today's own page) — in this schema a bucket's `kind` IS its purpose
	 * (inflow, bills, spend, irregulars, buffer, grow), so moving between
	 * purposes and moving between accounts is one `recordTransfer()` today.
	 * Spec A2 lists them as two separate actions for the user, so the panel
	 * renders two distinct forms: this one names both sides as purposes and
	 * says so, the other names them as accounts.
	 *
	 * Behaviour is copied from RecordIncomeForm.svelte:
	 *  - a fresh `client_uuid` per submit, regenerated only after a real
	 *    success (double-tap and dropped-connection retries stay idempotent);
	 *  - a `fail()` response's typed values survive in `formState`, with
	 *    per-field error text next to the field that caused it — including
	 *    the 422 whose `field` is `iouReason`;
	 *  - the enhance callback never calls `update()`.
	 *
	 * Invariant 1 (Spec A2 "no-balances rule"): `accounts` is
	 * `Selectable[]` — id/name/hint only. This form never receives, stores,
	 * or displays a balance.
	 */
	import { enhance } from '$app/forms';
	import type { Selectable } from '$lib/actions/context';

	interface Props {
		accounts: readonly Selectable[];
		/** Called once the move is actually recorded — the panel closes
		 * itself and returns focus to its trigger. */
		onSaved: () => void;
	}

	let { accounts, onSaved }: Props = $props();

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

<p class="legend">Move between purposes</p>
<p class="hint">Both sides are purposes — what the money is for — not banks or e-wallets.</p>

<form method="POST" action="?/transferMoney" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">Move from purpose</span>
		<select name="fromAccountId" required>
			<option value="" disabled selected>Pick the purpose money leaves</option>
			{#each accounts as account (account.id)}
				<option value={account.id}>{account.name}</option>
			{/each}
		</select>
	</label>
	{#if formState?.field === 'fromAccountId'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">To purpose</span>
		<select name="toAccountId" required>
			<option value="" disabled selected>Pick the purpose money lands in</option>
			{#each accounts as account (account.id)}
				<option value={account.id}>{account.name}</option>
			{/each}
		</select>
	</label>
	{#if formState?.field === 'toAccountId'}
		<p class="field-err">{formState.error}</p>
	{/if}
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
		<span class="field-label">Moved on <span class="opt">(optional)</span></span>
		<input name="movedOn" type="date" />
	</label>
	<label class="field">
		<span class="field-label">Fee <span class="opt">(optional)</span></span>
		<input name="fee" type="text" inputmode="decimal" autocomplete="off" />
	</label>
	<label class="field">
		<span class="field-label"
			>Reason <span class="opt">(required when money leaves Irregulars, Buffer or Grow)</span></span
		>
		<textarea name="iouReason" rows="2"></textarea>
	</label>
	{#if formState?.field === 'iouReason'}
		<p class="field-err">{formState.error}</p>
	{/if}
	{#if formState?.error && !formState?.field}
		<p class="form-err" role="alert">{formState.error}</p>
	{/if}
	<button class="move-save" type="submit">Record the move</button>
</form>

<style>
	/* Same tokens as RecordIncomeForm.svelte's ported styles — see that
	   file's comment for why these differ from Today's original inline block. */
	.legend {
		font-size: 0.8125rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-muted);
	}

	.hint {
		font-size: 0.8125rem;
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
	.field select,
	.field textarea {
		font: inherit;
		color: var(--ink);
		background: transparent;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		padding: 0.5rem 0.625rem;
		min-height: var(--touch);
	}

	.field textarea {
		resize: vertical;
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
