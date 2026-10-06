<script lang="ts">
	/**
	 * "Open an account", posting the Today page's `?/openAccount` action —
	 * the panel-home version of `addAccount` in
	 * src/routes/accounts/+page.server.ts, whose validation and echo block
	 * this form is built against.
	 *
	 * Failure restore: every `fail()` from that action (other than the 409,
	 * which carries no echo) spreads the raw typed values back — `rawName`,
	 * `kind`, `rawInstitution`, `hasCard`, `isCommitted`, `rawBalance` — so
	 * a rejected submit never wipes the form. The echo is stored in
	 * `formState` and seeds each input's value/checked state.
	 *
	 * Blank balance means zero, not an error (the server treats it that way
	 * explicitly), so the input is optional and never marked required.
	 */
	import { enhance } from '$app/forms';

	/** keep in sync with ACCOUNT_KINDS in src/routes/accounts/+page.server.ts */
	const ACCOUNT_KINDS = ['inflow', 'bills', 'spend', 'irregulars', 'buffer', 'grow'] as const;

	const KIND_LABELS: Record<(typeof ACCOUNT_KINDS)[number], string> = {
		inflow: 'Inflow',
		bills: 'Bills',
		spend: 'Spend',
		irregulars: 'Irregulars',
		buffer: 'Buffer',
		grow: 'Grow'
	};

	/** Server failure payload: `field`/`error` plus the echo block. */
	interface Failure {
		field?: string;
		error?: string;
		rawName?: string;
		kind?: string;
		rawInstitution?: string;
		hasCard?: boolean;
		isCommitted?: boolean;
		rawBalance?: string;
	}

	interface Props {
		/** Called once the account is actually opened — the panel closes itself. */
		onSaved: () => void;
	}

	let { onSaved }: Props = $props();

	let formState = $state<Failure | null>(null);
	let uuid = $state(crypto.randomUUID());

	/** Echoed values are `unknown` in transit; only strings are usable. */
	const text = (v: string | undefined) => (typeof v === 'string' ? v : '');

	const formLevelError = $derived(
		typeof formState?.error === 'string' &&
			!['name', 'kind', 'balance'].includes(String(formState?.field ?? ''))
			? formState.error
			: null
	);

	const onEnhance = () => {
		formState = null;
		return async ({ result }: { result: Record<string, unknown> }) => {
			if (result.type === 'failure') {
				formState = (result.data ?? {}) as Failure;
			} else {
				uuid = crypto.randomUUID();
				onSaved();
			}
		};
	};
</script>

<form method="POST" action="?/openAccount" use:enhance={onEnhance}>
	<input type="hidden" name="clientUuid" value={uuid} />
	<label class="field">
		<span class="field-label">Name</span>
		<input
			name="name"
			type="text"
			autocomplete="off"
			required
			value={text(formState?.rawName)}
			aria-invalid={formState?.field === 'name' ? 'true' : undefined}
			placeholder="Name it something you will recognise"
		/>
	</label>
	{#if formState?.field === 'name'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">Kind</span>
		<select name="kind" required aria-invalid={formState?.field === 'kind' ? 'true' : undefined}>
			<option value="" disabled selected={!formState?.kind}>Pick a purpose</option>
			{#each ACCOUNT_KINDS as kind (kind)}
				<option value={kind} selected={formState?.kind === kind}>{KIND_LABELS[kind]}</option>
			{/each}
		</select>
	</label>
	{#if formState?.field === 'kind'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="field">
		<span class="field-label">Institution <span class="opt">(optional)</span></span>
		<input
			name="institution"
			type="text"
			autocomplete="off"
			value={text(formState?.rawInstitution)}
		/>
	</label>
	<label class="field">
		<span class="field-label"
			>Opening balance <span class="opt">(optional, blank = zero)</span></span
		>
		<input
			name="balance"
			type="text"
			inputmode="decimal"
			autocomplete="off"
			value={text(formState?.rawBalance)}
			aria-invalid={formState?.field === 'balance' ? 'true' : undefined}
		/>
	</label>
	{#if formState?.field === 'balance'}
		<p class="field-err">{formState.error}</p>
	{/if}
	<label class="check">
		<input type="checkbox" name="hasCard" value="1" checked={formState?.hasCard === true} />
		<span>This one has a card</span>
	</label>
	<label class="check">
		<input type="checkbox" name="isCommitted" value="1" checked={formState?.isCommitted === true} />
		<span>Committed money — it leaves without asking</span>
	</label>
	{#if formLevelError}
		<p class="form-err" role="alert">{formLevelError}</p>
	{/if}
	<button class="move-save" type="submit">Open the account</button>
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

	.field input[aria-invalid='true'],
	.field select[aria-invalid='true'] {
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
