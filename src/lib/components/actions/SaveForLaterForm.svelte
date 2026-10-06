<script lang="ts">
	/**
	 * "Wait 72 hours" (Rule 4), posting the Today page's existing
	 * `?/addWait` action. The one failure it can produce is unfielded but
	 * concerns the label alone ("Name the thing you want." / the 409), so
	 * the message renders directly under the label input.
	 *
	 * The price is optional text with no validation at all — a wanted thing
	 * with no price is still a wanted thing — so it never shows an error.
	 */
	import { enhance } from '$app/forms';

	interface Props {
		/** Called once the item is actually parked — the panel closes itself. */
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

<form method="POST" action="?/addWait" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">What you want</span>
		<input
			name="label"
			type="text"
			autocomplete="off"
			required
			placeholder="The thing you keep almost buying"
			aria-invalid={formState?.error ? 'true' : undefined}
		/>
	</label>
	{#if formState?.error}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">Price <span class="opt">(optional)</span></span>
		<input name="amount" type="text" inputmode="decimal" autocomplete="off" />
	</label>
	<button class="move-save" type="submit">Park it for 72 hours</button>
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
