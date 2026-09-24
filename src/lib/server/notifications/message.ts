/**
 * Текст уведомления.
 *
 * Писем два вида: о зависшем взаимодействии и о сроке лицензии.
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
import { NOTIFICATION_KIND_LABELS } from '$lib/contracts/notifications';

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
