import type { Stage } from '$lib/components/stage-timeline.svelte';

/**
 * Fixtures for the kit page. Everything here is invented: the names are built
 * out of generic words so that no real organisation can be read into them, and
 * the numbers are generated from the row index, so the page looks the same on
 * every machine and in every screenshot.
 */

/** The moment the whole page is rendered against, so nothing drifts by a day. */
export const SHOWCASE_NOW = '2026-09-12T09:00:00Z';

export const REGIONS = [
	'Москва',
	'Санкт-Петербург',
	'Новосибирская область',
	'Свердловская область',
	'Республика Татарстан',
	'Приморский край',
	'Ростовская область',
	'Томская область'
] as const;

export type Region = (typeof REGIONS)[number];

export const ORGANIZATION_KINDS = {
	university: 'Вуз',
	college: 'Колледж',
	partner: 'Партнёр'
} as const;

export type OrganizationKind = keyof typeof ORGANIZATION_KINDS;

export type ShowcaseOrganization = {
	id: string;
	name: string;
	shortName: string;
	region: Region;
	kind: OrganizationKind;
	/** People on record at the organisation. */
	contacts: number;
	/** Date of the last interaction, ISO. */
	updatedAt: string;
	/** The interaction route, for the compact timeline in the list. */
	route: Stage[];
};

const KIND_WORDS: Record<OrganizationKind, string> = {
	university: 'Университет',
	college: 'Колледж',
	partner: 'Центр'
};

const SUBJECTS = [
	'прикладной информатики',
	'цифровых технологий',
	'связи и телекоммуникаций',
	'промышленной автоматизации',
	'информационной безопасности',
	'проектного управления',
	'анализа данных',
	'электроники'
] as const;

const PREFIXES = ['Северный', 'Приволжский', 'Восточный', 'Центральный', 'Южный'] as const;

const SHORT_STAGES: readonly string[] = [
	'Заявка',
	'Квалификация',
	'Программа',
	'Договор',
	'Набор',
	'Занятия',
	'Отчёт'
];

function shortRoute(progress: number): Stage[] {
	return SHORT_STAGES.map((label, index) => ({
		id: `${index}`,
		label,
		state: index < progress ? 'done' : index === progress ? 'current' : 'pending'
	}));
}

/**
 * The 40 rows the list demo works on. Built once at module load: the table
 * shows a page of a stable array, exactly as it will show a page from the
 * database.
 */
export const SHOWCASE_ORGANIZATIONS: readonly ShowcaseOrganization[] = Array.from(
	{ length: 40 },
	(_unused, index) => {
		const kind = (['university', 'college', 'partner'] as const)[index % 3];
		const prefix = PREFIXES[index % PREFIXES.length];
		const subject = SUBJECTS[index % SUBJECTS.length];
		const region = REGIONS[index % REGIONS.length];
		const number = index + 1;

		return {
			id: `org-${String(number).padStart(2, '0')}`,
			name: `${prefix} ${KIND_WORDS[kind].toLowerCase()} ${subject} № ${number}`,
			shortName: `${prefix.slice(0, 3).toUpperCase()}${KIND_WORDS[kind][0]}-${number}`,
			region,
			kind,
			contacts: 3 + ((index * 7) % 23),
			updatedAt: new Date(Date.UTC(2026, 7, 1 + ((index * 5) % 40), 9, 0)).toISOString(),
			route: shortRoute(index % SHORT_STAGES.length)
		};
	}
);

/**
 * A full interaction route, the frame the record card opens with: fourteen
 * stages covering every state the timeline can show.
 */
export const SHOWCASE_ROUTE: readonly Stage[] = [
	{ id: 'request', label: 'Заявка принята', state: 'done' },
	{ id: 'check', label: 'Проверка организации', state: 'done' },
	{ id: 'program', label: 'Согласование программы', state: 'done' },
	{ id: 'offer', label: 'Коммерческое предложение', state: 'done' },
	{ id: 'contract-draft', label: 'Подготовка договора', state: 'done' },
	{ id: 'contract-sign', label: 'Подписание договора', state: 'done' },
	{
		id: 'plan',
		label: 'План мероприятий',
		state: 'current',
		deadline: '2026-09-15T00:00:00Z',
		assignee: 'Анна Ковалёва'
	},
	{
		id: 'schedule',
		label: 'Согласование расписания',
		state: 'overdue',
		deadline: '2026-09-08T00:00:00Z',
		assignee: 'Пётр Никитин'
	},
	{
		id: 'enrolment',
		label: 'Набор группы',
		state: 'blocked',
		note: 'Ждём списки от организации'
	},
	{ id: 'classes', label: 'Проведение занятий', state: 'pending' },
	{
		id: 'interim',
		label: 'Промежуточный отчёт',
		state: 'paused',
		note: 'Перенесено на следующий квартал'
	},
	{ id: 'exam', label: 'Итоговая аттестация', state: 'pending' },
	{ id: 'act', label: 'Акт выполненных работ', state: 'pending' },
	{ id: 'survey', label: 'Опрос участников', state: 'skipped', note: 'Не предусмотрен' }
];
