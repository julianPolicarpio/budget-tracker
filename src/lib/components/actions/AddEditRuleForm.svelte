<script lang="ts">
	/**
	 * "Write an if-then rule" (A6 catalogue), posting the Today page's
	 * `?/upsertRule` action. No `id` field: the panel always creates a new
	 * rule, never revises one.
	 *
	 * Every failure this action can produce is unfielded `{ error }`, so
	 * there is exactly one error slot: form level.
	 *
	 * `RULE_CATEGORIES` is mirrored from src/lib/server/rules.ts — that
	 * module is server-only (it pulls in the database layer), so the keys
	 * and labels are copied rather than imported; the server remains the
	 * validating side.
	 */
	import { enhance } from '$app/forms';

	/** keep in sync with RULE_CATEGORIES in src/lib/server/rules.ts */
	const RULE_CATEGORIES = [
		{ key: 'adherence', label: 'Adherence' },
		{ key: 'overspend', label: 'Overspending' },
		{ key: 'structural', label: 'Structural' },
		{ key: 'social', label: 'Social' },
		{ key: 'travel', label: 'Travel' },
		{ key: 'motivation', label: 'Motivation' }
	] as const;

	interface Props {
		/** Called once the rule is actually saved — the panel closes itself. */
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

<form method="POST" action="?/upsertRule" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">When <span class="opt">(a cue you can detect)</span></span>
		<textarea
			name="cue"
			rows="3"
			required
			autocomplete="off"
			placeholder="Right after dinner, when the dishes are done…"></textarea>
	</label>
	<label class="field">
		<span class="field-label">Then <span class="opt">(an action that starts in seconds)</span></span
		>
		<textarea
			name="action"
			rows="3"
			required
			autocomplete="off"
			placeholder="I open the app and log the spend before dessert…"></textarea>
	</label>
	<label class="field">
		<span class="field-label">Category</span>
		<select name="category" required>
			<option value="" disabled selected>Pick a category</option>
			{#each RULE_CATEGORIES as category (category.key)}
				<option value={category.key}>{category.label}</option>
			{/each}
		</select>
	</label>
	{#if formState?.error}
		<p class="form-err" role="alert">{formState.error}</p>
	{/if}
	<button class="move-save" type="submit">Save the rule</button>
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
