/**
 * Текст уведомления.
 *
 * Писем четыре вида: о зависшем взаимодействии, о сроке лицензии, утренняя
 * сводка «Мой день» и «Вас упомянули в деле».
 *
 * Письмо уходит наружу — в чужой почтовый ящик, откуда его не отозвать и где
 * его прочитает почтовый сервер получателя, — поэтому персональных данных в нём
 * ровно столько, сколько нужно, чтобы понять, о чём речь: название
 * взаимодействия, название организации, стадия и срок. Ни фамилии
 * ответственного, ни фамилии адресата, ни контактов вуза в письме нет: кто
 * ведёт работу, видно в карточке, а карточка закрыта входом.
 *
 * Функция чистая и принимает адрес системы параметром: `ORIGIN` читает тот, кто
 * зовёт, а текст обязан проверяться без окружения целиком.
 */
import {
	MY_DAY_BASIS_LABELS,
	MY_DAY_SECTIONS,
	myDayLetterTitle,
	type MyDay,
	type MyDayItem
} from '$lib/contracts/my-day';
import { NOTIFICATION_KIND_LABELS } from '$lib/contracts/notifications';
import { pluralForm } from '$lib/format';

export type NotificationMessage = {
	subject: string;
	text: string;
};

export type StuckNotificationFacts = {
	interactionId: string;
	interactionTitle: string;
	/** Название основной стороны; `null` — сторон у взаимодействия ещё нет. */
	organizationName: string | null;
	/** Название стадии из слепка записи: маршрут могли переиздать. */
	stageName: string;
	/** Сколько дней запись стоит без учёта пауз. */
	standingDays: number;
	/** Порог, при котором система напоминает. */
	thresholdDays: number;
};

/** Ссылка на карточку взаимодействия от корня установки. */
export function interactionUrl(origin: string, interactionId: string): string {
	return `${origin.replace(/\/+$/, '')}/interactions/${interactionId}`;
}

/** Склонение слова «день» при числе. */
function days(count: number): string {
	const tail = count % 100;
	const last = count % 10;

	if (tail >= 11 && tail <= 14) {
		return `${count} дней`;
	}

	if (last === 1) {
		return `${count} день`;
	}

	if (last >= 2 && last <= 4) {
		return `${count} дня`;
	}

	return `${count} дней`;
}

/**
 * Письмо о зависшем взаимодействии. Тема называет запись, тело — стадию, срок,
 * порог и ссылку; последняя строка объясняет, откуда письмо и почему на него не
 * отвечают.
 */
export function stuckNotificationMessage(
	facts: StuckNotificationFacts,
	origin: string
): NotificationMessage {
	const where = facts.organizationName === null ? '' : ` (${facts.organizationName})`;
	const standing = facts.standingDays === 0 ? 'меньше суток' : days(facts.standingDays);
	const rule =
		facts.thresholdDays === 0
			? 'Система настроена напоминать о стадии сразу, как только по ней открыта запись.'
			: `Система напоминает о взаимодействиях, которые стоят на одной стадии дольше ${days(facts.thresholdDays)}; время пауз в этот срок не входит.`;

	const lines = [
		`Взаимодействие «${facts.interactionTitle}»${where} остаётся на стадии «${facts.stageName}» ${standing}.`,
		rule,
		'',
		`Карточка: ${interactionUrl(origin, facts.interactionId)}`,
		'',
		'Письмо отправила система контроля взаимодействия с учебными заведениями. Отвечать на него не нужно.'
	];

	return {
		subject: `${NOTIFICATION_KIND_LABELS.stage_stuck}: «${facts.interactionTitle}»`,
		text: lines.join('\n')
	};
}

/** Ссылка на карточку организации от корня установки. */
export function organizationUrl(origin: string, organizationId: string): string {
	return `${origin.replace(/\/+$/, '')}/organizations/${organizationId}`;
}

export type LicenseNotificationFacts = {
	organizationId: string;
	/**
	 * Название организации; `null` — называть её в письме нельзя (физическое
	 * лицо: его название — это ФИО, и письмо унесло бы его наружу).
	 */
	organizationName: string | null;
	productName: string;
	contractNumber: string;
	/** Срок лицензии словами, `31.12.2026`. */
	licenseUntilLabel: string;
	/** Сколько дней до конца срока; отрицательное — сколько дней как истёк. */
	daysLeft: number;
	/** `true` — письмо руководителю: продление не запущено, а срок уже прошёл. */
	escalation: boolean;
};

/**
 * Письмо о сроке лицензии. Тема называет продукт, тело — договор, срок и что
 * делать: открыть карточку организации и запустить продление из блока
 * договоров.
 */
export function licenseNotificationMessage(
	facts: LicenseNotificationFacts,
	origin: string
): NotificationMessage {
	const where = facts.organizationName === null ? '' : ` у «${facts.organizationName}»`;
	const term =
		facts.daysLeft < 0
			? `истекла ${facts.licenseUntilLabel} (${days(-facts.daysLeft)} назад)`
			: facts.daysLeft === 0
				? `истекает сегодня, ${facts.licenseUntilLabel}`
				: `истекает ${facts.licenseUntilLabel}, через ${days(facts.daysLeft)}`;
	const action = facts.escalation
		? 'Срок прошёл, а лицензия не продлена. Проверьте, запущено ли продление, у ответственного за организацию.'
		: 'Запустите продление кнопкой «Запустить продление» в блоке «Договоры» на карточке организации: система заведёт взаимодействие с этим продуктом и договором.';
	const kind = facts.daysLeft < 0 ? 'license_expired' : 'license_expiring';

	const lines = [
		`Лицензия на «${facts.productName}» по договору № ${facts.contractNumber}${where} ${term}.`,
		action,
		'',
		`Карточка организации: ${organizationUrl(origin, facts.organizationId)}`,
		'',
		'Письмо отправила система контроля взаимодействия с учебными заведениями. Отвечать на него не нужно.'
	];

	return {
		subject: `${NOTIFICATION_KIND_LABELS[kind]}: «${facts.productName}», договор № ${facts.contractNumber}`,
		text: lines.join('\n')
	};
}

function myDayItemUrl(origin: string, item: MyDayItem): string {
	return item.target.type === 'interaction'
		? interactionUrl(origin, item.target.id)
		: organizationUrl(origin, item.target.id);
}

/**
 * Утренняя сводка: разделы «Моего дня» со строками, подсказкой к действию и
 * ссылками.
 *
 * Обезличена так же, как письма наблюдателей, и строже их: у стороны —
 * физического лица не называется ни она сама, ни взаимодействие (название
 * заявки с сайта несёт ФИО заявителя), а свободный текст сотрудников — помехи
 * и «кого ждём» — в письмо не попадает вовсе: имена там пишут чаще, чем
 * где-либо.
 */
export function digestNotificationMessage(
	facts: { day: MyDay; dayLabel: string },
	origin: string
): NotificationMessage {
	const total = facts.day.sections.reduce((sum, section) => sum + section.total, 0);
	const home = `${origin.replace(/\/+$/, '')}/`;
	const lines = [
		`Что требует внимания сегодня, ${facts.dayLabel}. ${MY_DAY_BASIS_LABELS[facts.day.basis]}.`
	];

	for (const section of facts.day.sections) {
		const meta = MY_DAY_SECTIONS[section.kind];

		lines.push('', `${meta.title} (${section.total})`, `Что сделать: ${meta.action}.`);

		for (const item of section.items) {
			lines.push(`— ${myDayLetterTitle(item)}: ${item.detail}.`, `  ${myDayItemUrl(origin, item)}`);
		}

		const rest = section.total - section.items.length;

		if (rest > 0) {
			lines.push(`…и ещё ${rest} — на главной.`);
		}
	}

	lines.push(
		'',
		`Главная: ${home}`,
		'',
		'Сводку отправила система контроля взаимодействия с учебными заведениями. Отвечать на неё не нужно. Час сводки и её выключатель — в разделе «Настройки → Общие».'
	);

	return {
		subject: `${NOTIFICATION_KIND_LABELS.daily_digest} на ${facts.dayLabel}: ${total} ${pluralForm(total, ['дело', 'дела', 'дел'])}`,
		text: lines.join('\n')
	};
}

/**
 * Письмо об упоминании в комментарии.
 *
 * Самое скупое из всех: ни текста комментария, ни названия дела, ни имени
 * того, кто упомянул. Комментарий — свободный текст, в нём пишут телефоны и
 * фамилии, а название заявки физического лица и есть его ФИО; уехав в чужой
 * почтовый ящик, всё это стало бы копией, которую обезличивание уже не
 * достанет. Что сказано и кем — видно в карточке, а карточка закрыта входом и
 * откроется только тому, кто дело видит.
 */
export function mentionNotificationMessage(
	facts: { interactionId: string },
	origin: string
): NotificationMessage {
	const lines = [
		'Вас упомянули в комментарии к делу. Текст комментария и название дела в письмо не включаются — они в карточке после входа.',
		'',
		`Карточка: ${interactionUrl(origin, facts.interactionId)}`,
		'',
		'Письмо отправила система контроля взаимодействия с учебными заведениями. Отвечать на него не нужно.'
	];

	return { subject: 'Вас упомянули в деле', text: lines.join('\n') };
}
