<script lang="ts">
	/**
	 * "Create a planned expense" (Spec A6) — posts to Today's own page action
	 * (`?/createPlannedExpense`, added to `src/routes/+page.server.ts`), never
	 * across to `/irregulars?/upsert`. Same relative-URL rule as the two
	 * sibling forms. The panel only ever creates, so no `id` is sent — with
	 * none, the server's upsert branch is the insert branch.
	 *
	 * Behaviour is copied from RecordIncomeForm.svelte: a fresh `client_uuid`
	 * per submit, regenerated only after a real success; the enhance callback
	 * never calls `update()`. The action reports failures as a plain
	 * `{error}` message, so the error renders once under the form.
	 *
	 * `paddingPct` defaults to 25 because that is the documented size of the
	 * underestimate, and the hint says what the number is for instead of
	 * hiding it. `category` is free text: the server normalises it and drops
	 * anything it does not recognise, so this form does not pretend to know
	 * the list.
	 */
	import { enhance } from '$app/forms';

	interface Props {
		/** Called once the planned expense is actually created — the panel
		 * closes itself and returns focus to its trigger. */
		onSaved: () => void;
	}

	let { onSaved }: Props = $props();

	let uuid = $state(crypto.randomUUID());
	let cadence = $state('annual');
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

<form method="POST" action="?/createPlannedExpense" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">Label</span>
		<input name="label" type="text" placeholder="New laptop" autocomplete="off" required />
	</label>
	<label class="field">
		<span class="field-label">Cadence</span>
		<select name="cadence" bind:value={cadence}>
			<option value="one_off">One-off</option>
			<option value="monthly">Monthly</option>
			<option value="quarterly">Quarterly</option>
			<option value="semiannual">Twice a year</option>
			<option value="annual">Yearly</option>
			<option value="every_n_years">Every N years</option>
		</select>
	</label>
	{#if cadence === 'every_n_years'}
		<label class="field">
			<span class="field-label">Every N years</span>
			<input name="cadenceN" type="number" min="1" max="20" />
		</label>
	{/if}
	<label class="field">
		<span class="field-label">Next due</span>
		<input name="nextDueOn" type="date" required />
	</label>
	<label class="field">
		<span class="field-label">Category <span class="opt">(optional)</span></span>
		<input name="category" type="text" autocomplete="off" />
	</label>
	<label class="field">
		<span class="field-label">Estimate</span>
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
		<span class="field-label">Padding %</span>
		<input name="paddingPct" type="number" min="0" max="200" value={25} />
	</label>
	<p class="hint">Extra % set aside in case the real cost runs high.</p>
	{#if formState?.error && !formState?.field}
		<p class="form-err" role="alert">{formState.error}</p>
	{/if}
	<button class="move-save" type="submit">Save it</button>
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

	.hint {
		font-size: 0.8125rem;
		color: var(--ink-muted);
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
