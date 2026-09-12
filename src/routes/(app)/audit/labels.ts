/**
 * Как журнал называется по-русски.
 *
 * Словарь событий (`AUDIT_EVENT_TYPES`) — машинный: `interactions.stage_advanced`
 * годится для выборки, но не для чтения. Здесь у каждого кода есть название, и
 * записи `Record<AuditEventType, string>` достаточно, чтобы новое событие
 * нельзя было завести, не придумав ему имя: без строки в этой таблице проект
 * не соберётся.
 */
import { resolve } from '$app/paths';
import type { Pathname, ResolvedPathname } from '$app/types';
import type { StatusTone } from '$lib/components/status-badge.svelte';
import {
	AUDIT_EVENT_TYPES,
	type AuditEventType,
	type AuditOutcome,
	type AuditSource
} from '$lib/contracts/audit';

export const AUDIT_EVENT_LABELS: Record<AuditEventType, string> = {
	'auth.login': 'Вход в систему',
	'auth.logout': 'Выход из системы',
	'auth.login_failed': 'Неудачная попытка входа',
	'auth.locked': 'Вход закрыт блокировкой',
	'auth.password_changed': 'Смена пароля',
	'users.created': 'Пользователь заведён',
	'users.updated': 'Пользователь изменён',
	'users.role_changed': 'Роль пользователя изменена',
	'users.activated': 'Пользователь включён',
	'users.deactivated': 'Пользователь выключен',
	'settings.updated': 'Настройка изменена',
	'api_keys.created': 'Ключ доступа выпущен',
	'api_keys.revoked': 'Ключ доступа отозван',
	'organizations.created': 'Организация заведена',
	'organizations.updated': 'Организация изменена',
	'organizations.deactivated': 'Организация выключена',
	'organizations.site_created': 'Площадка заведена',
	'organizations.site_updated': 'Площадка изменена',
	'people.created': 'Человек заведён',
	'people.updated': 'Человек изменён',
	'people.affiliation_created': 'Роль в организации заведена',
	'people.affiliation_updated': 'Роль в организации изменена',
	'people.pii_viewed': 'Просмотр контактов человека',
	'programs.created': 'Программа заведена',
	'programs.updated': 'Программа изменена',
	'programs.version_created': 'Версия программы создана',
	'programs.archived': 'Программа отправлена в архив',
	'products.created': 'Продукт заведён',
	'products.updated': 'Продукт изменён',
	'products.archived': 'Продукт отправлен в архив',
	'interactions.created': 'Взаимодействие заведено',
	'interactions.updated': 'Взаимодействие изменено',
	'interactions.started': 'Взаимодействие запущено',
	'interactions.stage_advanced': 'Переход на следующую стадию',
	'interactions.stage_returned': 'Возврат на предыдущую стадию',
	'interactions.stage_skipped': 'Стадия пропущена',
	'interactions.paused': 'Взаимодействие приостановлено',
	'interactions.resumed': 'Взаимодействие возобновлено',
	'interactions.blocker_raised': 'Помеха зафиксирована',
	'interactions.blocker_resolved': 'Помеха снята',
	'interactions.confirmed': 'Взаимодействие подтверждено',
	'interactions.checklist_changed': 'Чек-лист стадии изменён',
	'interactions.result_recorded': 'Результат стадии записан',
	'interactions.responsible_changed': 'Ответственный изменён',
	'interactions.commented': 'Добавлен комментарий',
	'interactions.completed': 'Взаимодействие завершено',
	'interactions.cancelled': 'Взаимодействие отменено',
	'stages.route_created': 'Маршрут стадий создан',
	'stages.route_updated': 'Маршрут стадий изменён',
	'stages.route_published': 'Маршрут стадий опубликован',
	'documents.uploaded': 'Документ загружен',
	'documents.generated': 'Документ сгенерирован',
	'documents.downloaded': 'Документ скачан',
	'documents.status_changed': 'Статус документа изменён',
	'audit.exported': 'Журнал выгружен',
	'api.request': 'Обращение к API'
};

/** Первая часть кода события — раздел, к которому оно относится. */
type EventPrefix = AuditEventType extends `${infer Prefix}.${string}` ? Prefix : never;

const GROUP_LABELS: Record<EventPrefix, string> = {
	auth: 'Вход и доступ',
	users: 'Пользователи',
	settings: 'Настройки',
	api_keys: 'Ключи доступа',
	organizations: 'Организации',
	people: 'Люди',
	programs: 'Программы',
	products: 'Продукты',
	interactions: 'Взаимодействия',
	stages: 'Маршруты и стадии',
	documents: 'Документы',
	audit: 'Журнал',
	api: 'API'
};

export type AuditEventGroup = {
	prefix: EventPrefix;
	label: string;
	types: AuditEventType[];
};

function prefixOf(type: AuditEventType): EventPrefix {
	return type.slice(0, type.indexOf('.')) as EventPrefix;
}

/**
 * Каталог событий для выбора в фильтре: группы идут в том же порядке, что и
 * сам словарь, поэтому список в интерфейсе меняется вместе с ним и не требует
 * второго перечисления.
 */
export const AUDIT_EVENT_GROUPS: readonly AuditEventGroup[] = AUDIT_EVENT_TYPES.reduce<
	AuditEventGroup[]
>((groups, type) => {
	const prefix = prefixOf(type);
	const group = groups.find((candidate) => candidate.prefix === prefix);

	if (group === undefined) {
		groups.push({ prefix, label: GROUP_LABELS[prefix], types: [type] });
	} else {
		group.types.push(type);
	}

	return groups;
}, []);

export const AUDIT_OUTCOME_LABELS: Record<AuditOutcome, string> = {
	success: 'Успех',
	failure: 'Ошибка',
	denied: 'Отказ'
};

/** Отказ — это правило, которое сработало, а ошибка — то, что сломалось. */
export const AUDIT_OUTCOME_TONES: Record<AuditOutcome, StatusTone> = {
	success: 'success',
	failure: 'danger',
	denied: 'warning'
};

export const AUDIT_SOURCE_LABELS: Record<AuditSource, string> = {
	ui: 'Интерфейс',
	api: 'API',
	system: 'Система'
};

/**
 * Над чем действовали. Тип субъекта приходит из сервиса строкой, поэтому
 * словарь открытый: незнакомый тип показывается как есть, а не прячется.
 */
const SUBJECT_LABELS: Record<string, string> = {
	organization: 'Организация',
	site: 'Площадка',
	person: 'Человек',
	affiliation: 'Роль человека в организации',
	program: 'Программа',
	program_version: 'Версия программы',
	product: 'Продукт',
	interaction: 'Взаимодействие',
	stage_route: 'Маршрут стадий',
	document: 'Документ',
	user: 'Пользователь',
	api_key: 'Ключ доступа'
};

export function subjectTypeLabel(type: string): string {
	return SUBJECT_LABELS[type] ?? type;
}

/** Типы субъектов, по которым фильтр предлагает выбор. */
export const SUBJECT_TYPES: readonly string[] = Object.keys(SUBJECT_LABELS);

/**
 * Разделы, в которых у субъекта есть карточка. Пользователь и ключ доступа сюда
 * не входят: их страницы — это списки в настройках, а не карточка записи.
 */
const SUBJECT_SECTIONS: Record<string, string> = {
	organization: '/organizations',
	person: '/people',
	interaction: '/interactions',
	document: '/documents'
};

/**
 * Ссылка на карточку субъекта или `null`, если такого раздела нет.
 *
 * Путь собирается строкой и приводится к `Pathname` тем же приёмом, что и в
 * `nav.ts`: разделы вводятся в работу по очереди, а журнал ссылается на них
 * с первого дня — он пишет о том, что уже произошло.
 */
export function subjectHref(type: string, id: string): ResolvedPathname | null {
	const section = SUBJECT_SECTIONS[type];

	// Одна ветвь объединения, а не весь `Pathname`: см. `data-table/query.ts` —
	// на нынешнем числе маршрутов TypeScript не сопоставляет объединение целиком.
	return section === undefined ? null : resolve(`${section}/${id}` as Pathname & '/');
}

/** Служебные поля подробностей, у которых есть человеческое имя. */
const DETAIL_LABELS: Record<string, string> = {
	changedFields: 'Изменённые поля',
	route: 'Маршрут',
	method: 'Метод',
	status: 'Код ответа',
	demo: 'Демонстрационный вход',
	roleId: 'Роль',
	ownerUserId: 'Владелец (id)'
};

/** `apiKeyId` → `api_key`: ссылки в подробностях названы по типу записи. */
function snakeCase(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => `_${letter.toLocaleLowerCase('en')}`);
}

export function detailLabel(key: string): string {
	const known = DETAIL_LABELS[key];
	if (known !== undefined) {
		return known;
	}

	if (key.endsWith('Id')) {
		const subject = SUBJECT_LABELS[snakeCase(key.slice(0, -2))];
		if (subject !== undefined) {
			return `${subject} (id)`;
		}
	}

	return key;
}
