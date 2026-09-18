/**
 * Единственный способ отдать человека наружу.
 *
 * Фамилия, имя и должность нужны всем, кто работает с процессом; почта и
 * телефон — персональные данные, и видеть их должен только тот, кому это нужно
 * по работе. Поэтому маскирование живёт не в компоненте и не в конкретном
 * запросе, а здесь: любой ответ, экспорт и сгенерированный документ обязаны
 * проходить через эту функцию, иначе контакты рано или поздно утекут из места,
 * про которое забыли.
 *
 * Здесь же контакты расшифровываются: в базе они лежат шифртекстом
 * (`people/pii.ts`), и единственное место, которое отдаёт их наружу, обязано
 * быть единственным местом, которое их читает. Второй расшифровке взяться
 * неоткуда — значит, и утечь мимо маскирования нечему.
 */
import type { PersonView } from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { can } from '../rbac';
import { decryptContact } from './pii';
import { notePiiView } from './pii-trace';

/** Поля человека, которые нужны сериализатору, — как они лежат в базе. */
export type PersonRecord = {
	id: string;
	lastName: string;
	firstName: string;
	middleName: string | null;
	/** Шифртекст `enc:v1:…`: расшифровывает его {@link toPersonView}. */
	email: string | null;
	/** Он же для телефона. */
	phone: string | null;
	notes: string | null;
	retentionUntil: string | null;
	anonymizedAt: Date | null;
};

/** `ivanov@vuz.ru` → `i***@vuz.ru`: домен остаётся, имя ящика — нет. */
function maskEmail(email: string): string {
	const at = email.lastIndexOf('@');
	if (at <= 0) {
		return '***';
	}

	return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** `+7 999 123-45-67` → `+7 *** *** 45 67`: узнать номер нельзя, сверить — можно. */
function maskPhone(phone: string): string {
	const digits = phone.replace(/\D/g, '');
	if (digits.length < 5) {
		return '***';
	}

	const tail = digits.slice(-4);
	return `+${digits.slice(0, 1)} *** *** ${tail.slice(0, 2)} ${tail.slice(2)}`;
}

export function toPersonView(ctx: ActorContext, person: PersonRecord): PersonView {
	const full = can(ctx, 'people.read_pii');
	const email = person.email === null ? null : decryptContact(person.email);
	const phone = person.phone === null ? null : decryptContact(person.phone);

	// Раскрытие контактов — событие журнала, и отмечается оно здесь, в
	// единственном месте, которое знает, показали их или замаскировали. Пустые
	// контакты не в счёт: показывать было нечего.
	if (full && (email !== null || phone !== null)) {
		notePiiView(ctx, person.id);
	}

	return {
		id: person.id,
		lastName: person.lastName,
		firstName: person.firstName,
		middleName: person.middleName,
		email: email === null ? null : full ? email : maskEmail(email),
		phone: phone === null ? null : full ? phone : maskPhone(phone),
		notes: person.notes,
		contactsMasked: !full,
		retentionUntil: person.retentionUntil,
		anonymizedAt: person.anonymizedAt
	};
}
