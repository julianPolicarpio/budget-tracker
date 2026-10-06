<script lang="ts">
	/**
	 * "Add a debt" (A6 quick path), posting the Today page's `?/addDebt`
	 * action. No `id` field: the panel always creates a new debt, never
	 * revises one.
	 *
	 * Money arrives as raw text and is parsed server-side (`parseMoney`),
	 * same as every other money input in this directory. Every failure this
	 * action can produce — including the 409 "not initialised yet" — is
	 * unfielded `{ error }`, so there is exactly one error slot: form level.
	 */
	import { enhance } from '$app/forms';

	interface Props {
		/** Called once the debt is actually recorded — the panel closes itself. */
		onSaved: () => void;
	}

	let { onSaved }: Props = $props();

	let formState = $state<Record<string, unknown> | null>(null);
	let uuid = $state(crypto.randomUUID());

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

<form method="POST" action="?/addDebt" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">Name</span>
		<input name="label" type="text" autocomplete="off" required placeholder="Card, loan…" />
	</label>
	<label class="field">
		<span class="field-label">Balance owed</span>
		<input name="balance" type="text" inputmode="decimal" autocomplete="off" required />
	</label>
	<label class="field">
		<span class="field-label">Minimum payment</span>
		<input name="minPayment" type="text" inputmode="decimal" autocomplete="off" required />
	</label>
	<label class="field">
		<span class="field-label">APR % <span class="opt">(0–500)</span></span>
		<input name="apr" type="number" step="0.1" min="0" max="500" required />
	</label>
	{#if formState?.error}
		<p class="form-err" role="alert">{formState.error}</p>
	{/if}
	<button class="move-save" type="submit">Add the debt</button>
</form>

<style>
	/* Same tokens and shape as RecordIncomeForm.svelte's ported styles — see
	   that file's comment for why these differ from Today's original inline
	   block. */
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

	.field input {
		font: inherit;
		color: var(--ink);
		background: transparent;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		padding: 0.5rem 0.625rem;
		min-height: var(--touch);
	}

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
