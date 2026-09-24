/**
 * Журнал действий: словарь событий, правила для их подробностей и фильтр
 * выборки.
 *
 * Журнал — доказательство того, кто и что сделал, поэтому он неизменяем на
 * уровне базы, а в подробности события нельзя положить персональные данные:
 * иначе удалить их по требованию субъекта будет невозможно, не сломав журнал.
 */
import { z } from 'zod';
import { optionalId, optionalText, searchQuery } from './common';

/** Откуда пришло действие. */
export const AUDIT_SOURCES = ['ui', 'api', 'system'] as const;
/** Чем оно кончилось: сделано, не получилось, запрещено правами. */
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Полный словарь событий. Событие, которого здесь нет, записать нельзя:
 * так журнал остаётся пригодным для выборок и отчётов, а не превращается в
 * свалку произвольных строк.
 */
export const AUDIT_EVENT_TYPES = [
	'auth.login',
	'auth.logout',
	'users.created',
	'users.updated',
	'users.role_changed',
	'users.activated',
	'users.deactivated',
	// Членство в пространстве: доступ к работе направления выдан или отозван.
	// Своим кодом, а не правкой пользователя: вопрос «кто и когда открыл ему
	// это направление» журнал обязан находить без чтения подробностей.
	'users.workspace_granted',
	'users.workspace_revoked',
	// Чтение штата: успешное не пишется — его совершают десятками за смену, —
	// а вот попытка прочитать штат без права на него и есть то, ради чего
	// событие заведено. В журнале оно встречается с исходом `denied`.
	'users.viewed',
	'settings.updated',
	// Демонстрационный стенд вернули к начальным данным: взаимодействия,
	// документы и справочник стёрты и залиты заново. Своим кодом, а не правкой
	// настройки: на вопрос «куда делась запись, которую я вёл вчера» журнал
	// обязан отвечать прямо, а не строкой о том, что кто-то менял настройки.
	'settings.demo_reset',
	'api_keys.created',
	'api_keys.revoked',
	// То же, что и `users.viewed`: список ключей читают постоянно, а записывать
	// стоит попытку прочитать его без права.
	'api_keys.viewed',
	'organizations.created',
	'organizations.updated',
	'organizations.deactivated',
	'organizations.site_created',
	'organizations.site_updated',
	// Поля карточки приняты из паспорта организации — выписки ЕГРЮЛ, раздела
	// `/sveden` сайта или снимка. Своим событием рядом с заведением и правкой:
	// на вопрос «откуда в карточке этот ИНН» журнал отвечает источником и
	// датой каждого принятого значения (`provenance` в подробностях).
	'organizations.passport_applied',
	// Ответственный за вуз: назначен, снят без замены, заменён другим. У замены
	// в подробностях ещё и прежний ответственный: вопрос «а кто вёл до этого»
	// задают сразу после вопроса «кто теперь ведёт». Работу замена не двигает —
	// незавершённые взаимодействия остаются за своими владельцами.
	'directory.responsible_assigned',
	'directory.responsible_released',
	'directory.responsible_reassigned',
	// Импорт каталога: файл принят, разложен по справочникам, отклонён. Числа
	// строк едут в подробностях (`<что-то>Count`), потому что «импорт применён»
	// без них не отвечает на вопрос, что именно он в справочнике поменял.
	// Собственного события у шага сопоставления нет: он ничего не решает —
	// предпросмотр пересчитывается сколько угодно раз, а решение это следующий шаг.
	'directory.import_created',
	'directory.import_confirmed',
	'directory.import_rejected',
	// Договор контрагента и его позиции: заведены и изменены. Своим кодом, а не
	// правкой организации: договор — обязательство с датами и коммерческими
	// условиями, и на вопрос «кто и когда поменял срок лицензии» журнал обязан
	// отвечать по самой записи. Импорт каталога заводит их десятками и своей
	// строкой в журнале уже отмечен (`directory.import_confirmed`).
	'directory.contract_created',
	'directory.contract_updated',
	'directory.contract_item_created',
	'directory.contract_item_updated',
	'people.created',
	'people.updated',
	'people.affiliation_created',
	'people.affiliation_updated',
	'people.pii_viewed',
	'people.consent_recorded',
	'people.consent_withdrawn',
	'people.retention_changed',
	'people.anonymized',
	'programs.created',
	'programs.updated',
	'programs.version_created',
	'programs.archived',
	// ИТ-направление заведено. Отдельное событие, а не правка справочника: по
	// направлению назначают ответственных и строят разрезы отчёта, и новое
	// направление меняет картину всем сразу.
	'directions.created',
	// Изменено: название, код, состав продуктов, возврат из архива. Возврат идёт
	// правкой с одним изменённым полем — отдельного кода на него никто не
	// спрашивает, а вопрос «когда вернули» читается по ней.
	'directions.updated',
	// Ушло в архив: по направлению больше не работают, и в подсказках оно не
	// предлагается. Своим кодом по той же причине, что и у программы, — на
	// вопрос «когда направление закрыли» отвечают по нему.
	'directions.archived',
	'products.created',
	'products.updated',
	'products.archived',
	'interactions.created',
	'interactions.updated',
	'interactions.started',
	'interactions.stage_advanced',
	'interactions.stage_returned',
	'interactions.stage_skipped',
	'interactions.paused',
	'interactions.resumed',
	'interactions.blocker_raised',
	'interactions.blocker_resolved',
	'interactions.confirmed',
	'interactions.checklist_changed',
	'interactions.result_recorded',
	// Сменился тот, чья это работа: у взаимодействия один владелец, и вопрос
	// «кто теперь ведёт» задают по нему.
	'interactions.owner_changed',
	// Запись стадии переехала при изменении процесса: строка на каждое
	// переехавшее взаимодействие. На вопрос «почему моя запись стоит не там, где
	// вчера» журнал обязан отвечать по самой записи, а не только по процессу.
	'interactions.stage_migrated',
	'interactions.commented',
	// Скачано приглашение на встречу файлом календаря (.ics). Пишется на каждое
	// скачивание, а не только на первое: файл можно перегенерировать с другим
	// временем или составом участников, и это тоже действие, о котором стоит
	// знать. Подробностей с почтой или именами участников здесь нет — сам файл
	// уже подчиняется праву на персональные данные, а журнал его не дублирует.
	'interactions.meeting_invited',
	'interactions.completed',
	'interactions.cancelled',
	// Публикация изменённого процесса и перенос записей: две строки одной
	// транзакции. Первая несёт диф в числах, вторая — сколько записей
	// перепривязано и сколько взаимодействий переехало.
	'stages.process_published',
	'stages.process_migrated',
	'stages.draft_created',
	'stages.draft_updated',
	'stages.draft_discarded',
	// То же, что и `users.viewed`: устройство процесса открывает каждый, кто
	// зашёл в раздел настроек, и успешное чтение в журнале не нужно — а вот
	// попытка открыть его без права на настройку и есть то, ради чего событие
	// заведено. В журнале оно встречается с исходом `denied`.
	'stages.process_viewed',
	// Настройка пространств: заводит их теперь заказчик, а не миграция, и
	// каждое такое решение — часть устройства системы, а не рабочие данные.
	// Назначение процесса стоит отдельным событием: сменить его у пространства
	// со взаимодействиями нельзя, и вопрос «когда и на что его поменяли»
	// задают именно по этой строке.
	'workspaces.created',
	'workspaces.renamed',
	'workspaces.reordered',
	'workspaces.workflow_assigned',
	// Процесс заводят отдельно от места: одно описание работы может обслуживать
	// несколько пространств, и его появление — самостоятельное решение.
	'workflows.created',
	// Состав карточки процесса — панели и шаблоны документов. Меняет рабочее
	// место всех пространств процесса сразу и без публикации, поэтому след
	// в журнале — единственный ответ на «кто убрал оплату из карточки».
	'workflows.card_configured',
	'documents.uploaded',
	'documents.generated',
	'documents.downloaded',
	'documents.status_changed',
	// Новая редакция файла со ссылкой на предыдущую версию в подробностях.
	'documents.version_uploaded',
	'stats.snapshot_created',
	'stats.snapshot_mapped',
	'stats.snapshot_confirmed',
	'stats.snapshot_rejected',
	// Отчёт по данным об обучении, унесённый книгой. Смотреть те же числа на
	// дашборде можно сколько угодно и в журнал это не пишется, а выгрузка
	// выносит их из системы: дальше файл живёт сам по себе, и знать, кто его
	// собрал, можно только отсюда.
	'stats.exported',
	// Напоминания о зависших взаимодействиях. Успехи сводятся в одну запись за
	// проход цикла (`sentCount`) — строка на каждое письмо превратила бы журнал
	// в лог рассылки; нажатие «Повторить» пишется отдельной строкой с самим
	// взаимодействием. Отказ и пропуск, наоборот, поимённы: каждый из них ждёт
	// человека — либо почтовый сервер, либо незаполненная иерархия.
	'notifications.sent',
	'notifications.failed',
	'notifications.skipped',
	'integrations.webhook_created',
	'integrations.webhook_updated',
	'integrations.webhook_delivered',
	'integrations.webhook_failed',
	'integrations.lms_synced',
	'integrations.lms_sync_failed',
	// Заявка, пришедшая от внешней системы, а не заведённая руками в интерфейсе.
	'integrations.application_received',
	// Журнал обмена: сообщение принято, отправлено, не доставлено после всех
	// попыток, помечено разобранным вручную. Отправку учебной группы и отметку
	// «обучение завершено» пишем отдельно — это действия сотрудника, а не работа
	// цикла доставки. Комментарий отметки лежит на самой группе: свободному
	// тексту в подробностях журнала не место.
	'exchange.message_received',
	'exchange.message_sent',
	'exchange.message_failed',
	'exchange.message_dismissed',
	'exchange.group_requested',
	'exchange.group_completed',
	// Поимённый список слушателей группы: загрузка файлом и удаление человека
	// из списка. Передача списка в систему обучения — это та же заявка на
	// группу и пишется ею.
	'exchange.roster_loaded',
	'exchange.learner_removed',
	// Отчёт по взаимодействиям, унесённый файлом: режим, период и число строк.
	// Смотреть те же числа на экране можно сколько угодно, а выгрузка выносит их
	// из системы — дальше файл живёт сам по себе.
	'reports.exported',
	'audit.exported',
	'api.request',
	'api.unauthenticated_burst'
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * Подробности события. Разрешены ссылки на другие записи (ключ заканчивается на
 * `Id`), список изменённых полей и закрытый список служебных полей запроса —
 * то есть то, что позволяет найти объект и понять, что происходило, но само по
 * себе ничего не рассказывает о человеке.
 */
export type AuditDetails = {
	changedFields?: readonly string[];
	/**
	 * Люди, чьи контакты раскрыли в одном запросе. Единственный список
	 * идентификаторов в подробностях: след просмотра персональных данных
	 * пишется одной записью на запрос, а не строкой на каждого человека —
	 * иначе открытый список из ста строк дал бы сто записей об одном действии.
	 */
	personIds?: readonly string[];
	/** Маршрут, по которому пришёл запрос к API: `/api/v1/organizations/[id]`. */
	route?: string;
	/** Метод запроса: `GET`, `POST`, … */
	method?: string;
	/** Код ответа, которым кончился запрос. */
	status?: number;
	/** Вход в публичную демонстрацию: учётная запись общая, а не личная. */
	demo?: boolean;
	/**
	 * Каким из объявленных способов совершено действие: режим отчёта
	 * (`snapshot`, `movement`), способ сброса стенда (`manual`, `schedule`).
	 * Значение — код из закрытого списка, а не свободный текст: его проверяет
	 * образец.
	 */
	mode?: string;
	/** Границы периода выгрузки — календарные дни `2026-10-01`. */
	periodStart?: string;
	periodEnd?: string;
	/**
	 * Происхождение полей, принятых из паспорта организации: поле, источник,
	 * момент ответа источника и способ получения. Второй и последний список в
	 * подробностях — каждое его значение проверяется образцом, и свободному
	 * тексту в нём места нет.
	 */
	provenance?: readonly {
		field: string;
		source: string;
		fetchedAt: string;
		via: string;
	}[];
	[key: `${string}Id`]: string | undefined;
	[key: `${string}Key`]: string | undefined;
	[key: `${string}Count`]: number | undefined;
};

/**
 * Служебные поля и их типы. Список закрыт намеренно: маршрут, метод, код ответа
 * и признак демонстрационного входа персональных данных не несут, а любое поле
 * «ещё немного контекста» рано или поздно окажется текстом, который писал
 * человек.
 */
const REQUEST_DETAIL_KEYS = new Map<string, 'string' | 'number' | 'boolean'>([
	['route', 'string'],
	['method', 'string'],
	['status', 'number'],
	['demo', 'boolean']
]);

/**
 * Способ действия и границы периода выгрузки. Свободного текста не допускают и
 * они — значение проверяется образцом, а не только типом.
 */
const SHAPED_DETAIL_KEYS = new Map<string, RegExp>([
	['mode', /^[a-z][a-z0-9_-]{0,31}$/],
	['periodStart', /^\d{4}-\d{2}-\d{2}$/],
	['periodEnd', /^\d{4}-\d{2}-\d{2}$/]
]);

/**
 * Устойчивое имя внутри системы: ключ стадии, ключ группы процесса, код
 * направления. Образец закрывает форме `<что-то>Key` дорогу к свободному
 * тексту: «позвонили в вуз» в неё не помещается.
 */
const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Ключ со списком идентификаторов. Кроме него, список допустим только у
 * происхождения полей паспорта (`provenance`, ниже). Остальные списки запрещены,
 * потому что произвольный массив рано или поздно окажется перечнем фамилий, а
 * этот содержит только ссылки на записи и заведён под след просмотра.
 */
const ID_LIST_DETAIL_KEY = 'personIds';

/** Ключ происхождения принятых полей паспорта организации. */
const PROVENANCE_DETAIL_KEY = 'provenance';

/**
 * Образцы частей записи происхождения. Имя поля и источник — коды, момент —
 * отметка времени ISO с поясом: ни одна из частей не вмещает фразы.
 */
const PROVENANCE_SHAPES: Record<string, RegExp> = {
	field: /^[a-zA-Z]{1,32}$/,
	source: /^[a-z]{1,16}$/,
	fetchedAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
	via: /^[a-z]{1,16}$/
};

function isProvenanceEntry(item: unknown): boolean {
	if (typeof item !== 'object' || item === null || Array.isArray(item)) {
		return false;
	}

	const entries = Object.entries(item);

	return (
		entries.length === Object.keys(PROVENANCE_SHAPES).length &&
		entries.every(
			([key, value]) =>
				PROVENANCE_SHAPES[key] !== undefined &&
				typeof value === 'string' &&
				PROVENANCE_SHAPES[key].test(value)
		)
	);
}

/** Идентификатор записи: только он и допустим внутри списка ссылок. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ключи, которые в журнале запрещены прямо. За первыми всегда стоят
 * персональные данные; последние — секреты, и попали в список потому, что
 * форма `<что-то>Key` пускает в подробности строку, а `apiKey` — это строка.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
	'email',
	'phone',
	'password',
	'lastName',
	'firstName',
	'middleName',
	'apiKey',
	'secretKey',
	'signingKey',
	'privateKey'
]);

/**
 * Проверяет подробности события. Возвращает список претензий; пустой список —
 * значит, записывать можно. Функция чистая и не знает про HTTP: превращает
 * претензии в ошибку тот, кто пишет событие.
 */
export function validateAuditDetails(details: object): string[] {
	const issues: string[] = [];

	for (const [key, value] of Object.entries(details)) {
		if (key === 'changedFields') {
			if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
				issues.push('changedFields: ожидается список имён полей');
			}
			continue;
		}

		if (key === ID_LIST_DETAIL_KEY) {
			if (
				!Array.isArray(value) ||
				value.some((item) => typeof item !== 'string' || !UUID_PATTERN.test(item))
			) {
				issues.push(`${ID_LIST_DETAIL_KEY}: ожидается список идентификаторов записей`);
			}
			continue;
		}

		if (key === PROVENANCE_DETAIL_KEY) {
			if (!Array.isArray(value) || value.length > 32 || !value.every(isProvenanceEntry)) {
				issues.push(
					`${PROVENANCE_DETAIL_KEY}: ожидается список записей { field, source, fetchedAt, via }`
				);
			}
			continue;
		}

		if (FORBIDDEN_DETAIL_KEYS.has(key)) {
			issues.push(`${key}: персональные данные в журнал не записываются`);
			continue;
		}

		const expected = REQUEST_DETAIL_KEYS.get(key);
		if (expected !== undefined) {
			if (typeof value !== expected) {
				issues.push(`${key}: ожидается значение типа ${expected}`);
			}
			continue;
		}

		const shape = SHAPED_DETAIL_KEYS.get(key);
		if (shape !== undefined) {
			if (typeof value !== 'string' || !shape.test(value)) {
				issues.push(`${key}: значение не отвечает образцу ${shape.source}`);
			}
			continue;
		}

		// Счётчик: публикация процесса несёт диф в числах, переназначение —
		// сколько записей передано, выгрузка — сколько строк ушло в файл.
		if (key.endsWith('Count')) {
			if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
				issues.push(`${key}: ожидается целое число не меньше нуля`);
			}
			continue;
		}

		// Устойчивое имя: ключ стадии, группы, направления. Не идентификатор
		// записи — по ключу сопоставляют стадии разных редакций процесса.
		if (key.endsWith('Key')) {
			if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
				issues.push(`${key}: ожидается устойчивое имя вида ${KEY_PATTERN.source}`);
			}
			continue;
		}

		if (!key.endsWith('Id')) {
			issues.push(
				`${key}: в подробностях допустимы ссылки вида <что-то>Id, имена <что-то>Key, числа <что-то>Count, ${ID_LIST_DETAIL_KEY}, ${PROVENANCE_DETAIL_KEY} и поля ${[...REQUEST_DETAIL_KEYS.keys(), ...SHAPED_DETAIL_KEYS.keys()].join(', ')}`
			);
			continue;
		}

		if (typeof value !== 'string') {
			issues.push(`${key}: идентификатор должен быть строкой`);
		}
	}

	return issues;
}

export const auditFilterSchema = z.object({
	/** Нижняя граница периода включительно. */
	from: z.iso
		.datetime({ offset: true, error: 'Дата начала указана неверно' })
		.nullable()
		.default(null),
	/** Верхняя граница периода включительно. */
	to: z.iso
		.datetime({ offset: true, error: 'Дата окончания указана неверно' })
		.nullable()
		.default(null),
	eventType: z.array(z.enum(AUDIT_EVENT_TYPES)).default([]),
	outcome: z.array(z.enum(AUDIT_OUTCOMES)).default([]),
	source: z.array(z.enum(AUDIT_SOURCES)).default([]),
	actorUserId: optionalId('Некорректный идентификатор пользователя'),
	subjectType: optionalText(100),
	subjectId: optionalId('Некорректный идентификатор объекта'),
	/** Поиск по подписи действующего лица и типу события. */
	q: searchQuery
});

export type AuditFilter = z.output<typeof auditFilterSchema>;

/** Формат выгрузки журнала. */
export const AUDIT_EXPORT_FORMATS = ['csv', 'json'] as const;

export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/**
 * Что публичная демонстрация видит вместо адреса и клиента.
 *
 * Журнал стенда пишется не только о синтетических данных: адрес и строка
 * клиента приезжают от живого посетителя, и следующий посетитель прочитает в
 * ленте, откуда и чем заходили до него. Отобрать у демонстрации сам журнал
 * нельзя — он часть того, что показывают, — поэтому убирается ровно то, что
 * указывает на человека, а не на событие.
 *
 * Это не шифрование и не хеш: значение подменяется на более грубое, обратно
 * оно не собирается.
 */

/** Первые два октета адреса: «откуда примерно», без указания на машину. */
export function maskIp(ip: string | null): string | null {
	if (ip === null) {
		return null;
	}

	const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);

	// IPv6 и всё, что не разобралось в четыре октета, огрублению не поддаётся:
	// в адресе вида `2001:db8::1` префикс — это по-прежнему адрес сети.
	return octets === null ? 'скрыто' : `${octets[1]}.${octets[2]}.*.*`;
}

/** Семейства браузеров: порядок значим — Edge и Яндекс называют себя Chrome. */
const USER_AGENT_FAMILIES: readonly [RegExp, string][] = [
	[/YaBrowser\//, 'Яндекс.Браузер'],
	[/Edg[A-Z]?\//, 'Edge'],
	[/OPR\/|Opera\//, 'Opera'],
	[/Firefox\//, 'Firefox'],
	[/Chrome\//, 'Chrome'],
	[/Safari\//, 'Safari']
];

/**
 * Семейство браузера вместо полной строки клиента. Полная строка — это версии
 * системы и сборки, по которым браузер узнаётся среди прочих; семейства
 * достаточно, чтобы понять, чем открывали.
 */
export function maskUserAgent(userAgent: string | null): string | null {
	if (userAgent === null) {
		return null;
	}

	for (const [pattern, family] of USER_AGENT_FAMILIES) {
		if (pattern.test(userAgent)) {
			return family;
		}
	}

	return 'скрыто';
}

export type AuditEventView = {
	id: string;
	occurredAt: Date;
	requestId: string;
	source: AuditSource;
	eventType: AuditEventType;
	outcome: AuditOutcome;
	actorUserId: string | null;
	apiKeyId: string | null;
	actorLabel: string;
	ip: string | null;
	userAgent: string | null;
	subjectType: string | null;
	subjectId: string | null;
	details: Record<string, unknown>;
};

/**
 * Событие журнала в том виде, в каком его показывают публичной демонстрации.
 * Маскируются только адрес и клиент: всё остальное в записи — про систему, а
 * не про того, кто её открыл.
 */
export function maskAuditEvent(event: AuditEventView): AuditEventView {
	return { ...event, ip: maskIp(event.ip), userAgent: maskUserAgent(event.userAgent) };
}
