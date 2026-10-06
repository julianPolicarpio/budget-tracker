<script lang="ts">
	/** Add a bill from Today. The typed draft stays with the host on Back. */
	import { enhance } from '$app/forms';
	import { CADENCES, CADENCE_LABELS } from '$lib/subscription-cadence';
	import type { ActionDraft } from '$lib/actions/draft';

	interface Props {
		/** Called once the bill is actually recorded — the panel closes
		 * itself and returns focus to its trigger. */
		onSaved: () => void;
		draft?: ActionDraft;
		onDraftChange?: (draft: ActionDraft) => void;
	}

	let { onSaved, draft, onDraftChange }: Props = $props();

	let formState = $state<Record<string, unknown> | null>(null);
	let uuid = $state(crypto.randomUUID());
	let label = $state('');
	let amount = $state('');
	let cadence = $state('');
	let nextChargeOn = $state('');
	let freeUntil = $state('');
	let isEssential = $state(false);
	let restoredFor = $state('');

	$effect(() => {
		if (!draft || restoredFor === draft.sourceText) return;
		label = draft.fields.label ?? '';
		amount = draft.fields.amount ?? '';
		cadence = draft.fields.cadence ?? '';
		nextChargeOn = draft.fields.nextChargeOn ?? '';
		freeUntil = draft.fields.freeUntil ?? '';
		isEssential = draft.fields.isEssential === '1';
		restoredFor = draft.sourceText;
	});

	function remember() {
		if (!draft || !onDraftChange) return;
		onDraftChange({
			...draft,
			fields: { ...draft.fields, label, amount, cadence, nextChargeOn, freeUntil, isEssential: isEssential ? '1' : '' }
		});
	}

	/** Failures that have an input to sit under; everything else is form-level. */
	const FIELD_ERRORS = ['quickLabel', 'quickAmount', 'cadence', 'nextChargeOn', 'freeUntil'];

	const formLevelError = $derived(
		typeof formState?.error === 'string' && !FIELD_ERRORS.includes(String(formState?.field ?? ''))
			? formState.error
			: null
	);

	const onEnhance = () => {
		formState = null;
		return async ({ result }: { result: Record<string, unknown> }) => {
			if (result.type === 'failure') {
				formState = (result.data ?? {}) as Record<string, unknown>;
			} else if (result.type === 'success') {
				uuid = crypto.randomUUID();
				onSaved();
			} else {
				formState = { error: 'Could not confirm the save. Check your connection and try again.' };
			}
		};
	};
</script>

<form method="POST" action="?/quickAddBill" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">What it is</span>
		<input
			name="label"
			type="text"
			autocomplete="off"
			required
			placeholder="Streaming, gym, insurance…"
			bind:value={label}
			oninput={remember}
			aria-invalid={formState?.field === 'quickLabel' ? 'true' : undefined}
		/>
	</label>
	{#if formState?.field === 'quickLabel'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">Charge</span>
		<input
			name="amount"
			type="text"
			inputmode="decimal"
			autocomplete="off"
			required
			bind:value={amount}
			oninput={remember}
			aria-invalid={formState?.field === 'quickAmount' ? 'true' : undefined}
		/>
	</label>
	{#if formState?.field === 'quickAmount'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">How often</span>
		<select name="cadence" required bind:value={cadence} onchange={remember} aria-invalid={formState?.field === 'cadence' ? 'true' : undefined}>
			<option value="" disabled>Choose how often</option>
			{#each CADENCES as cadence (cadence)}
				<option value={cadence}>
					{CADENCE_LABELS[cadence]}
				</option>
			{/each}
		</select>
	</label>
	{#if formState?.field === 'cadence'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">Billing date</span>
		<input name="nextChargeOn" type="date" required bind:value={nextChargeOn} onchange={remember} aria-invalid={formState?.field === 'nextChargeOn' ? 'true' : undefined} />
	</label>
	{#if formState?.field === 'nextChargeOn'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">Free until <span class="opt">(trials, optional)</span></span>
		<input
			name="freeUntil"
			type="date"
			bind:value={freeUntil}
			onchange={remember}
			aria-invalid={formState?.field === 'freeUntil' ? 'true' : undefined}
		/>
	</label>
	{#if formState?.field === 'freeUntil'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="check">
		<input type="checkbox" name="isEssential" value="1" bind:checked={isEssential} onchange={remember} />
		<span>Non-negotiable — it has to be paid</span>
	</label>
	{#if formLevelError}
		<p class="form-err" role="alert">{formLevelError}</p>
	{/if}
	<button class="move-save" type="submit">Add the bill</button>
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

	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: var(--touch);
		font-size: 0.8125rem;
		color: var(--ink-secondary);
	}

	.check input[type='checkbox'] {
		width: 1.125rem;
		height: 1.125rem;
		accent-color: var(--accent-solid);
	}
</style>
