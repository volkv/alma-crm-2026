/**
 * Выданные паспорта и их приёмка.
 *
 * Паспорт уходит в браузер под номером и одновременно ложится в Redis. Когда
 * сотрудник сохраняет форму, браузер присылает только отметки «поле такое-то
 * принято из паспорта такого-то», а значение, источник и дату сервер берёт из
 * своей копии. Так происхождение в журнале нельзя подделать браузером, а
 * значение, которое сотрудник поправил после приёмки, честно перестаёт быть
 * «из источника».
 */
import type {
	IssuedPassport,
	OrganizationPassport,
	PassportAcceptance,
	PassportField,
	PassportProvenance,
	PassportVia
} from '$lib/contracts/enrichment';
import type { ActorContext } from '../actor';
import { ValidationError } from '../errors';
import { getRedis } from '../redis';

/**
 * Сутки — столько же, сколько живёт кэш ответа: паспорт, найденный утром,
 * должен дожить до сохранения формы вечером.
 */
const PASSPORT_TTL_SECONDS = 24 * 60 * 60;

type StoredPassport = { userId: string; via: PassportVia; passport: OrganizationPassport };

function passportKey(token: string): string {
	return `lct:enrichment:passport:${token}`;
}

/** Кладёт паспорт под новый номер и отдаёт его вместе с номером. */
export async function issuePassport(
	ctx: ActorContext,
	via: PassportVia,
	passport: OrganizationPassport
): Promise<IssuedPassport> {
	if (ctx.user === null) {
		throw new ValidationError('Паспорт организации принимает только сотрудник');
	}

	const token = crypto.randomUUID();
	const stored: StoredPassport = { userId: ctx.user.id, via, passport };

	await getRedis().set(passportKey(token), JSON.stringify(stored), 'EX', PASSPORT_TTL_SECONDS);

	return { token, via, passport };
}

const STALE_PASSPORT =
	'Сведения из источника устарели: найдите организацию заново или сохраните без них';

/**
 * Выданный паспорт по номеру — только тому сотруднику, которому он выдан.
 * Чужой паспорт неотличим от истёкшего: номер не должен рассказывать, что за
 * ним лежит у другого сотрудника.
 */
export async function readIssuedPassport(
	ctx: ActorContext,
	token: string
): Promise<{ via: PassportVia; passport: OrganizationPassport }> {
	const raw = ctx.user === null ? null : await getRedis().get(passportKey(token));
	const parsed = raw === null ? null : (JSON.parse(raw) as StoredPassport);

	if (parsed === null || parsed.userId !== ctx.user?.id) {
		throw new ValidationError(STALE_PASSPORT);
	}

	return { via: parsed.via, passport: parsed.passport };
}

/** Значения полей карточки в том виде, в каком их сохраняет форма. */
export type AcceptedValues = Record<PassportField, string | null>;

/**
 * Происхождение принятых полей, сверенное с выданными паспортами.
 *
 * Отказ — паспорт не найден (истёк или выдан другому сотруднику) или поле в нём
 * не предлагалось: форма утверждает то, чего сервер не выдавал, и сохранять
 * такое происхождение нельзя. Поле, значение которого разошлось с паспортом,
 * пропускается молча по смыслу, а не по небрежности: сотрудник поправил его
 * после приёмки, и оно стало введённым вручную.
 *
 * Одно поле, принятое из двух паспортов, берётся по последней отметке —
 * так же, как его видела форма.
 */
export async function resolveAcceptance(
	ctx: ActorContext,
	acceptance: PassportAcceptance,
	values: AcceptedValues
): Promise<PassportProvenance[]> {
	if (acceptance.length === 0) {
		return [];
	}

	if (ctx.user === null) {
		throw new ValidationError('Паспорт организации принимает только сотрудник');
	}

	const latest = new Map<PassportField, string>();

	for (const { token, field } of acceptance) {
		latest.delete(field);
		latest.set(field, token);
	}

	const tokens = [...new Set(latest.values())];
	const stored = await getRedis().mget(tokens.map(passportKey));
	const passports = new Map<string, StoredPassport>();

	tokens.forEach((token, index) => {
		const raw = stored[index];
		const parsed = raw === null ? null : (JSON.parse(raw) as StoredPassport);

		// Чужой паспорт неотличим от истёкшего: номер не должен рассказывать,
		// что за ним лежит у другого сотрудника.
		if (parsed === null || parsed.userId !== ctx.user?.id) {
			throw new ValidationError(STALE_PASSPORT);
		}

		passports.set(token, parsed);
	});

	const provenance: PassportProvenance[] = [];

	for (const [field, token] of latest) {
		const entry = passports.get(token) as StoredPassport;
		const offered = entry.passport.fields[field];

		if (offered === undefined) {
			throw new ValidationError(`Поле «${field}» источник не предлагал`);
		}

		if (values[field] !== offered.value) {
			continue;
		}

		provenance.push({
			field,
			source: offered.source,
			fetchedAt: offered.fetchedAt,
			via: entry.via
		});
	}

	return provenance;
}
