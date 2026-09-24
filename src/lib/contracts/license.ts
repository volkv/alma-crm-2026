/**
 * Срок лицензии по позиции договора: идёт, подходит к концу или уже прошёл.
 *
 * Правило одно на наблюдателя, который напоминает ответственному за вуз, и на
 * карточку организации, которая показывает кнопку «Запустить продление»: если
 * бы они считали окно по-разному, письмо звало бы к кнопке, которой на экране
 * нет. Функция чистая и сравнивает календарные дни строками `YYYY-MM-DD` —
 * часовой пояс решает тот, кто передаёт «сегодня».
 */

export type LicenseState = 'active' | 'expiring' | 'expired';

export const LICENSE_STATE_LABELS: Record<LicenseState, string> = {
	active: 'Действует',
	expiring: 'Истекает',
	expired: 'Истекла'
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Календарный день через `days` дней после `isoDay`. */
export function addDays(isoDay: string, days: number): string {
	const at = Date.parse(`${isoDay}T00:00:00Z`);

	if (Number.isNaN(at)) {
		throw new RangeError(`Не календарный день: ${isoDay}`);
	}

	return new Date(at + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Состояние лицензии на день `today`. Срок «до 31.12» включает 31.12: в этот
 * день лицензия ещё действует и только истекает. `null` — срок не записан, и
 * напоминать не о чем.
 */
export function licenseState(
	licenseUntil: string | null,
	today: string,
	windowDays: number
): LicenseState | null {
	if (licenseUntil === null) {
		return null;
	}

	if (licenseUntil < today) {
		return 'expired';
	}

	return licenseUntil <= addDays(today, windowDays) ? 'expiring' : 'active';
}

/**
 * Название взаимодействия продления: по нему запись узнают в списке и на доске.
 * Дата — нынешний срок лицензии, а не новый: нового ещё нет, его и согласуют.
 */
export function renewalTitle(facts: {
	productName: string;
	contractNumber: string;
	licenseUntilLabel: string;
}): string {
	return `Продление лицензии «${facts.productName}» по договору № ${facts.contractNumber}, срок до ${facts.licenseUntilLabel}`;
}
