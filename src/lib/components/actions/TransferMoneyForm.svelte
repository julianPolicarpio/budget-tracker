<script lang="ts">
	/**
	 * "Transfer money" (Spec A6). A quick form that posts to Today's own page
	 * action (`?/transferMoney`, added to `src/routes/+page.server.ts`) — the
	 * same relative-URL rule the two sibling forms follow (`?/landMoney`,
	 * `?/refundMoney`). A panel form never posts across pages, so this never
	 * reaches `/accounts?/transfer`, even though that action records the same
	 * underlying operation.
	 *
	 * Behaviour is copied from RecordIncomeForm.svelte:
	 *  - a fresh `client_uuid` per submit, regenerated only after a real
	 *    success, so a double-tap or a retry after a dropped connection
	 *    cannot record the same transfer twice;
	 *  - a `fail()` response's typed values survive in `formState` instead
	 *    of vanishing, with per-field error text next to the field that
	 *    caused it — including the 422 whose `field` is `iouReason`, which is
	 *    the whole point of the one-line reason (money leaving Irregulars,
	 *    Buffer or Grow needs a note, nowhere to hide it);
	 *  - the enhance callback never calls `update()`: the form lives in an
	 *    overlay panel on Today, not on the page whose data a reload would
	 *    refresh.
	 *
	 * Invariant 1 (Spec A2 "no-balances rule"): `accounts` is
	 * `Selectable[]` — id/name/hint only. This form never receives, stores,
	 * or displays a balance.
	 */
	import { enhance } from '$app/forms';
	import type { Selectable } from '$lib/actions/context';

	interface Props {
		accounts: readonly Selectable[];
		/** Called once the transfer is actually recorded — the panel closes
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

<form method="POST" action="?/transferMoney" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">From account</span>
		<select name="fromAccountId" required>
			<option value="" disabled selected>Pick the account money leaves</option>
			{#each accounts as account (account.id)}
				<option value={account.id}>{account.name}</option>
			{/each}
		</select>
	</label>
	{#if formState?.field === 'fromAccountId'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">To account</span>
		<select name="toAccountId" required>
			<option value="" disabled selected>Pick the account money lands in</option>
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
	<button class="move-save" type="submit">Record transfer</button>
</form>

<style>
	/* Same tokens as RecordIncomeForm.svelte's ported styles — see that
	   file's comment for why these differ from Today's original inline block. */
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
