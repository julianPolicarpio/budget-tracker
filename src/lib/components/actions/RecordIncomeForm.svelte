<script lang="ts">
	/**
	 * "Money landed" (A6 op 2), extracted from Today's own inline markup so
	 * the typing bar's action view can render the same form (Task 2c).
	 * Behaviour is preserved exactly from the original `<details class="money-move">`
	 * block in `src/routes/+page.svelte`:
	 *  - a fresh `client_uuid` per submit, regenerated only after a real
	 *    success, so a double-tap or a retry after a dropped connection
	 *    can't insert twice (the server's own UNIQUE constraint is the other
	 *    half of that guarantee — see `?/landMoney` in +page.server.ts);
	 *  - a `fail()` response's typed values survive in `formState` instead
	 *    of vanishing, with per-field error text next to the field that
	 *    caused it.
	 *
	 * Invariant 1 (Spec A2 "no-balances rule"): `accounts` is
	 * `Selectable[]` — id/name/hint only. This form never receives, stores,
	 * or displays a balance.
	 */
	import { enhance } from '$app/forms';
	import type { Selectable } from '$lib/actions/context';

	interface Props {
		accounts: readonly Selectable[];
		/** Called once the arrival is actually recorded — the panel closes
		 * itself and returns focus to its trigger (Spec A2: "Save returns to
		 * the originating page"; Today already is that page). */
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

<form method="POST" action="?/landMoney" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
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
		<span class="field-label">Where it landed</span>
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
	<label class="field">
		<span class="field-label">Note <span class="opt">(optional)</span></span>
		<input name="note" type="text" autocomplete="off" placeholder="What came in?" />
	</label>
	<button class="move-save" type="submit">Record it</button>
</form>

<style>
	/* Same shape as Today's original .money-move fields — ported here rather
	   than kept inline now that the form lives in its own component. Uses
	   the real tokens from src/routes/layout.css; the original inline block
	   referenced --line/--radius/--bg-input/--danger/--accent-contrast,
	   none of which layout.css ever defines, so those declarations were
	   silently inert. */
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
