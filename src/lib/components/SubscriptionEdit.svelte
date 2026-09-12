<script lang="ts">
	/**
	 * The edit form for one commitment.
	 *
	 * A component rather than markup repeated in each table: the essential and
	 * cancellable sections render different columns, and duplicating the form
	 * would guarantee one of them silently loses a field the next time this
	 * changes.
	 */
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { CATEGORIES } from '$lib/categories';
	import { CADENCE_LABELS } from '$lib/subscription-cadence';

	interface Sub {
		id: number;
		label: string;
		vendor: string | null;
		amountMinor: number;
		taxMinor: number | null;
		cadence: string;
		nextChargeOn: string;
		trialEndsOn: string | null;
		cancelByOn: string | null;
		leadDays: number;
		category: string | null;
		note: string | null;
		isEssential: number;
	}

	let {
		sub,
		minorUnits,
		symbol,
		onDone
	}: {
		sub: Sub;
		minorUnits: number;
		symbol: string;
		onDone: () => void;
	} = $props();

	/** Minor units back to a plain editable string — never a float. */
	function major(m: number | null): string {
		if (m === null) return '';
		const s = String(Math.abs(m)).padStart(minorUnits + 1, '0');
		if (minorUnits === 0) return s;
		return `${s.slice(0, -minorUnits)}.${s.slice(-minorUnits)}`;
	}

	// Seeded from the row, then owned by the checkbox. `untrack` says that
	// explicitly: this is an initial value, not a binding that should snap back
	// to the server's copy while you are still editing.
	let essential = $state(untrack(() => sub.isEssential === 1));
</script>

<form
	method="POST"
	action="?/edit"
	use:enhance={() =>
		async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') onDone();
		}}
	class="edit"
>
	<input type="hidden" name="id" value={sub.id} />

	<div class="field wide">
		<label for="e-label-{sub.id}">What is it</label>
		<input id="e-label-{sub.id}" name="label" value={sub.label} required />
	</div>
	<div class="field">
		<label for="e-vendor-{sub.id}">Billed by</label>
		<input id="e-vendor-{sub.id}" name="vendor" value={sub.vendor ?? ''} />
	</div>
	<div class="field">
		<label for="e-amount-{sub.id}">Charge ({symbol})</label>
		<input id="e-amount-{sub.id}" name="amount" value={major(sub.amountMinor)} required />
	</div>
	<div class="field">
		<label for="e-tax-{sub.id}">of which tax</label>
		<input id="e-tax-{sub.id}" name="tax" value={major(sub.taxMinor)} />
	</div>
	<div class="field">
		<label for="e-cadence-{sub.id}">How often</label>
		<select id="e-cadence-{sub.id}" name="cadence">
			{#each Object.entries(CADENCE_LABELS) as [key, label] (key)}
				<option value={key} selected={key === sub.cadence}>{label}</option>
			{/each}
		</select>
	</div>
	<div class="field">
		<label for="e-next-{sub.id}">Next charge</label>
		<input id="e-next-{sub.id}" name="nextChargeOn" type="date" value={sub.nextChargeOn} required />
	</div>
	<div class="field">
		<label for="e-trial-{sub.id}">Free until</label>
		<input id="e-trial-{sub.id}" name="trialEndsOn" type="date" value={sub.trialEndsOn ?? ''} />
		<span class="hint">Blank = already billing.</span>
	</div>

	<label class="check">
		<input type="checkbox" name="isEssential" value="1" bind:checked={essential} />
		Non-negotiable — never ask me to cancel it
	</label>

	{#if !essential}
		<div class="field">
			<label for="e-cancel-{sub.id}">Cancel by</label>
			<input id="e-cancel-{sub.id}" name="cancelByOn" type="date" value={sub.cancelByOn ?? ''} />
			<span class="hint">Blank = the charge date.</span>
		</div>
		<div class="field">
			<label for="e-lead-{sub.id}">Warn me</label>
			<select id="e-lead-{sub.id}" name="leadDays">
				{#each [7, 14, 30, 60, 90] as d (d)}
					<option value={d} selected={d === sub.leadDays}>{d} days ahead</option>
				{/each}
			</select>
			<!--
				Say it out loud: moving a deadline clears the warnings already sent,
				because they described a date that no longer exists.
			-->
			<span class="hint">Changing a date re-arms the warnings.</span>
		</div>
	{/if}

	<div class="field">
		<label for="e-cat-{sub.id}">Category</label>
		<select id="e-cat-{sub.id}" name="category">
			<option value="">—</option>
			{#each CATEGORIES as c (c.key)}
				<option value={c.key} selected={c.key === sub.category}>{c.label}</option>
			{/each}
		</select>
	</div>
	<div class="field wide">
		<label for="e-note-{sub.id}">Note</label>
		<input id="e-note-{sub.id}" name="note" value={sub.note ?? ''} />
	</div>

	<div class="row">
		<button type="submit" class="save">Save changes</button>
		<button type="button" class="cancel" onclick={onDone}>Cancel</button>
	</div>
</form>

<style>
	.edit {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.875rem;
		margin: 0.5rem 0 1rem;
		padding: 1.25rem;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.5rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.field.wide {
		grid-column: 1 / -1;
	}

	label {
		color: var(--ink-muted);
		font-size: 0.75rem;
	}

	input,
	select {
		padding: 0.45rem 0.5rem;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		border-radius: 0.25rem;
		color: var(--ink);
		font: inherit;
		font-size: 0.875rem;
	}

	.hint {
		color: var(--ink-muted);
		font-size: 0.6875rem;
	}

	.check {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--ink-secondary);
		font-size: 0.875rem;
	}

	.check input {
		width: auto;
	}

	.row {
		grid-column: 1 / -1;
		display: flex;
		gap: 0.5rem;
	}

	.save,
	.cancel {
		padding: 0.6rem 1.25rem;
		background: none;
		border: 1px solid var(--hairline-strong);
		border-radius: 0.375rem;
		color: var(--ink);
		font: inherit;
		cursor: pointer;
	}

	.cancel {
		color: var(--ink-muted);
		border-color: transparent;
	}
</style>
