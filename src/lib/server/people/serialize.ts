/**
 * Единственный способ отдать человека наружу.
 *
 * Фамилия, имя и должность нужны всем, кто работает с процессом; почта и
 * телефон — персональные данные, и видеть их должен только тот, кому это нужно
 * по работе. Поэтому маскирование живёт не в компоненте и не в конкретном
 * запросе, а здесь: любой ответ, экспорт и сгенерированный документ обязаны
 * проходить через эту функцию, иначе контакты рано или поздно утекут из места,
 * про которое забыли.
 */
import type { PersonView } from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { can } from '../rbac';

/** Поля человека, которые нужны сериализатору. */
export type PersonRecord = {
	id: string;
	lastName: string;
	firstName: string;
	middleName: string | null;
	email: string | null;
	phone: string | null;
	notes: string | null;
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

	return {
		id: person.id,
		lastName: person.lastName,
		firstName: person.firstName,
		middleName: person.middleName,
		email: person.email === null ? null : full ? person.email : maskEmail(person.email),
		phone: person.phone === null ? null : full ? person.phone : maskPhone(person.phone),
		notes: person.notes,
		contactsMasked: !full
	};
}
