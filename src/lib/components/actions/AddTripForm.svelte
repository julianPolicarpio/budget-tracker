<script lang="ts">
	/**
	 * "Add a trip" (Spec A6) — posts to Today's own page action (`?/declareTrip`,
	 * added to `src/routes/+page.server.ts`), never across to `/trips?/declare`.
	 * Same relative-URL rule as the two sibling forms.
	 *
	 * The fields are the same ones the Trips tab's own declare form collects;
	 * this is the quick version of the same decision.
	 *
	 * Behaviour is copied from RecordIncomeForm.svelte: a fresh `client_uuid`
	 * per submit, regenerated only after a real success; the enhance callback
	 * never calls `update()`. The declare action reports every failure as a
	 * plain `{error}` message (including the 422 for a trip over the maximum
	 * length), so the error renders once under the form rather than beside a
	 * field.
	 *
	 * `tripTz` starts empty on purpose: a quick form must not guess the
	 * timezone from settings or from the browser — the person declaring the
	 * trip knows where they are going.
	 */
	import { enhance } from '$app/forms';

	interface Props {
		/** Called once the trip is actually declared — the panel closes
		 * itself and returns focus to its trigger. */
		onSaved: () => void;
	}

	let { onSaved }: Props = $props();

	let uuid = $state(crypto.randomUUID());
	let tripTz = $state('');
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

<form method="POST" action="?/declareTrip" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">Label</span>
		<input name="label" type="text" placeholder="Tokyo, September" autocomplete="off" required />
	</label>
	<label class="field">
		<span class="field-label">Starts</span>
		<input name="startsOn" type="date" required />
	</label>
	<label class="field">
		<span class="field-label">Ends</span>
		<input name="endsOn" type="date" required />
	</label>
	<label class="field">
		<span class="field-label">Timezone</span>
		<input name="tripTz" type="text" placeholder="Asia/Manila" bind:value={tripTz} required />
	</label>
	<label class="field">
		<span class="field-label">Currency code</span>
		<input
			name="currencyCode"
			type="text"
			class="code"
			placeholder="PHP"
			autocomplete="off"
			required
		/>
	</label>
	<label class="field">
		<span class="field-label">Symbol</span>
		<input name="currencySymbol" type="text" placeholder="₱" autocomplete="off" required />
	</label>
	<label class="field">
		<span class="field-label">Decimal places</span>
		<select name="localMinorUnits" required>
			<option value="2" selected>2 — most currencies</option>
			<option value="0">0 — JPY, KRW, VND</option>
			<option value="3">3 — KWD, BHD, JOD</option>
		</select>
	</label>
	<label class="field">
		<span class="field-label">Exchange rate — home per 1 unit</span>
		<input name="fxRateToHome" type="number" step="any" required />
	</label>
	<label class="field">
		<span class="field-label">Estimate (before padding)</span>
		<input name="estimate" type="text" inputmode="decimal" autocomplete="off" required />
	</label>
	{#if formState?.error}
		<p class="form-err" role="alert">{formState.error}</p>
	{/if}
	<button class="move-save" type="submit">Declare it</button>
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

	.field .code {
		text-transform: uppercase;
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
