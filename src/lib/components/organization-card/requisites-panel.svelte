<script lang="ts">
	import ContextSection from '$lib/components/interaction-card/context-section.svelte';
	import type { OrganizationView } from '$lib/contracts/directory';
	import type { FieldSource, PassportField, PassportVia } from '$lib/contracts/enrichment';
	import { formatDate, formatDateTime } from '$lib/format';
	import { PASSPORT_FIELD_LABELS, PASSPORT_SOURCE_LABELS } from './model';

	/**
	 * Реквизиты организации — полное наименование, ИНН, КПП, ОГРН — и откуда
	 * они взялись. Происхождение — из журнала: последняя приёмка полей из паспорта организации называет
	 * поля, источник и дату ответа источника. Нет такой записи — реквизиты
	 * набраны руками или пришли импортом, и это сказано прямо.
	 */
	let {
		organization,
		passportApplied
	}: {
		organization: OrganizationView;
		passportApplied: {
			occurredAt: Date;
			actorLabel: string;
			provenance: {
				field: PassportField;
				source: FieldSource;
				fetchedAt: string;
				via: PassportVia;
			}[];
		} | null;
	} = $props();

	/** Принятые поля по источнику: «ЕГРЮЛ: ИНН, ОГРН — ответ от …». */
	const bySource = $derived.by(() => {
		const groups: {
			key: string;
			source: string;
			fields: string[];
			fetchedAt: string;
			via: PassportVia;
		}[] = [];

		for (const entry of passportApplied?.provenance ?? []) {
			const key = `${entry.source}/${entry.via}`;
			let group = groups.find((known) => known.key === key);

			if (group === undefined) {
				group = {
					key,
					source: PASSPORT_SOURCE_LABELS[entry.source],
					fields: [],
					fetchedAt: entry.fetchedAt,
					via: entry.via
				};
				groups.push(group);
			}

			group.fields.push(PASSPORT_FIELD_LABELS[entry.field]);
		}

		return groups;
	});
</script>

<ContextSection title="Реквизиты">
	<dl class="flex flex-col gap-2 text-sm">
		<div class="min-w-0">
			<dt class="text-xs text-muted-foreground">Полное наименование</dt>
			<dd class="break-words">{organization.legalName}</dd>
		</div>
		<div class="flex flex-wrap gap-x-6 gap-y-2">
			<div>
				<dt class="text-xs text-muted-foreground">ИНН</dt>
				<dd class="tabular-nums">{organization.inn ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">КПП</dt>
				<dd class="tabular-nums">{organization.kpp ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">ОГРН</dt>
				<dd class="tabular-nums">{organization.ogrn ?? '—'}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Обновлено</dt>
				<dd>{formatDate(organization.updatedAt)}</dd>
			</div>
		</div>
	</dl>
	{#if organization.notes}
		<p class="text-sm break-words whitespace-pre-line text-muted-foreground">
			{organization.notes}
		</p>
	{/if}
</ContextSection>

<ContextSection title="Источник реквизитов">
	{#if passportApplied === null}
		<p class="text-sm text-muted-foreground">
			Записей о приёмке из ЕГРЮЛ или с сайта нет: реквизиты введены вручную или импортом.
		</p>
	{:else}
		<ul class="flex flex-col gap-1.5 text-sm">
			{#each bySource as group (group.key)}
				<li class="break-words">
					<span class="font-medium">{group.source}</span>: {group.fields.join(', ')}
					<span class="block text-xs text-muted-foreground">
						ответ источника от {formatDateTime(group.fetchedAt)}{group.via === 'snapshot'
							? ', загружен снимком'
							: ''}
					</span>
				</li>
			{/each}
		</ul>
		<p class="text-xs text-faint">
			Приняты {formatDateTime(passportApplied.occurredAt)}, {passportApplied.actorLabel}.
		</p>
	{/if}
</ContextSection>
