/**
 * Второй фактор входа: одноразовый код из приложения-аутентификатора.
 *
 * Здесь три разных вопроса, и путать их нельзя. Первый — нужен ли фактор
 * вообще: на него отвечает политика (`mfa_policy`) по роли и по тому, откуда
 * пришёл запрос. Второй — регистрация: секрет, который человек переносит в
 * приложение, и код, которым он подтверждает, что перенёс. Третий — проверка
 * при входе: код из приложения или резервный код, однократно.
 *
 * Математика TOTP лежит отдельно и ничего не знает про базу (`totp.ts`), сети —
 * в `networks.ts`. Этот модуль — про состояние: что записано у пользователя,
 * что уже предъявлено и что попало в журнал.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { MfaStateView } from '$lib/contracts/auth';
import type { SettingValue } from '$lib/contracts/settings';
import { pluralize } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getConfig } from '../config';
import { getDb } from '../db';
import { users } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { getRedis } from '../redis';
import { getSetting } from '../settings';
import { clearLoginFailures, lockoutState, registerLoginFailure, UNKNOWN_ADDRESS } from './lockout';
import { isAddressWithin } from './networks';
import { revokeAllSessions } from './session';
import { generateTotpSecret, otpauthUri, TOTP_STEP_SECONDS, TOTP_WINDOW, verifyTotp } from './totp';
import type { SessionUser } from './types';
import { normalizeEmail } from './users';

/** Сколько резервных кодов выдаётся за раз. */
export const BACKUP_CODE_COUNT = 10;

/**
 * Алфавит резервного кода — Crockford base32: цифры и буквы без `I`, `L`, `O`
 * и `U`. Код переписывают с экрана на бумагу и обратно, и пара «единица или
 * латинская I» стоит человеку попытки входа, которых у него пять.
 */
const BACKUP_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Три группы по четыре символа: 60 бит на код. */
const BACKUP_GROUPS = 3;
const BACKUP_GROUP_SIZE = 4;

/**
 * Сколько живёт начатая регистрация. Секрет уже показан на экране, но фактором
 * ещё не стал: если человек ушёл, не подтвердив код, начинать придётся заново —
 * незавершённая регистрация не должна ждать его сутками.
 */
const ENROLLMENT_SECONDS = 15 * 60;

const enrollmentKey = (sessionId: string): string => `mfa_enroll:${sessionId}`;
const enrolledKey = (sessionId: string): string => `mfa_enrolled:${sessionId}`;
const usedCodeKey = (userId: string, counter: number): string => `mfa_used:${userId}:${counter}`;

/**
 * Сколько помнить предъявленный код. Окно проверки — шаг в обе стороны,
 * поэтому код действует три шага; отметка живёт столько же плюс запас.
 */
const USED_CODE_SECONDS = (2 * TOTP_WINDOW + 2) * TOTP_STEP_SECONDS;

/**
 * Издатель в ссылке `otpauth://`: он подписывает запись в приложении, и по нему
 * человек с двумя стендами понимает, чей это код. Поэтому в подписи стоит и имя
 * системы, и адрес, на котором она открыта.
 */
function issuer(): string {
	return `LCT CRM ${new URL(getConfig().ORIGIN).host}`;
}

/**
 * Нужен ли этому пользователю второй фактор.
 *
 * Демонстрационная сессия выведена из политики целиком. Её учётная запись
 * общая: зарегистрировать на неё фактор — значит отдать вход одному телефону
 * из всех, кто открыл стенд, а не защитить учётную запись.
 *
 * `remoteOnly` понимается буквально: фактор нужен, когда адрес не попал ни в
 * одну доверенную сеть. Пустой список сетей означает, что доверенных сетей нет
 * и удалённым считается любой адрес.
 */
export function mfaRequired(
	policy: SettingValue<'mfa_policy'>,
	user: Pick<SessionUser, 'roleId' | 'isDemo'>,
	ip: string | null
): boolean {
	if (user.isDemo) {
		return false;
	}

	if (!policy.requiredForRoles.includes(user.roleId)) {
		return false;
	}

	if (!policy.remoteOnly) {
		return true;
	}

	return !isAddressWithin(ip, policy.trustedNetworks);
}

/** То же самое, но с чтением действующей политики. */
export async function mfaRequiredFor(
	user: Pick<SessionUser, 'roleId' | 'isDemo'>,
	ip: string | null
): Promise<boolean> {
	return mfaRequired(await getSetting('mfa_policy'), user, ip);
}

/** Обязателен ли фактор роли независимо от того, откуда пришёл запрос. */
export async function mfaRequiredForRole(roleId: string): Promise<boolean> {
	return (await getSetting('mfa_policy')).requiredForRoles.includes(roleId);
}

type FactorRow = {
	totpSecret: string | null;
	totpEnabledAt: Date | null;
	totpBackupCodes: string[] | null;
};

async function readFactor(userId: string): Promise<FactorRow> {
	const [row] = await getDb()
		.select({
			totpSecret: users.totpSecret,
			totpEnabledAt: users.totpEnabledAt,
			totpBackupCodes: users.totpBackupCodes
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Пользователь не найден');
	}

	return row;
}

/** Состояние фактора у одной учётной записи: то, что показывает профиль. */
export async function mfaStateFor(userId: string): Promise<MfaStateView> {
	const row = await readFactor(userId);

	return {
		enabled: row.totpEnabledAt !== null && row.totpSecret !== null,
		enrolledAt: row.totpEnabledAt,
		backupCodesLeft: row.totpBackupCodes?.length ?? 0
	};
}

/**
 * У кого из перечисленных фактор подключён. Отдельным запросом, а не колонкой
 * в `listUsers`: список штата собирает модуль пользователей, а про второй
 * фактор знает этот.
 */
export async function mfaEnabledFor(userIds: readonly string[]): Promise<Set<string>> {
	if (userIds.length === 0) {
		return new Set();
	}

	const rows = await getDb()
		.select({ id: users.id, enabledAt: users.totpEnabledAt })
		.from(users)
		.where(inArray(users.id, [...userIds]));

	return new Set(rows.filter((row) => row.enabledAt !== null).map((row) => row.id));
}

/** Кто действует; без него ни один из этих вызовов не имеет смысла. */
function actor(ctx: ActorContext): SessionUser {
	if (ctx.user === null) {
		throw new ForbiddenError('Действие доступно только вошедшему пользователю');
	}

	return ctx.user;
}

/**
 * Демонстрационная учётная запись общая для всех, кто открыл стенд: фактор,
 * зарегистрированный на неё, закрыл бы вход остальным, а снять его было бы
 * некому. Граница та же, что у смены пароля в профиле.
 */
function refuseDemo(action: string): ForbiddenError {
	return new ForbiddenError(
		`Демонстрационная учётная запись общая для всех, кто открыл стенд: ${action} из демонстрации нельзя`
	);
}

export type PendingEnrollment = {
	/** Секрет в base32 — его же человек вводит руками, если камера не работает. */
	secret: string;
	/** Ссылка `otpauth://` для камеры приложения. */
	uri: string;
};

/**
 * Секрет начатой регистрации.
 *
 * Он живёт в Redis рядом с сессией, а не в базе: пока код не подтверждён,
 * фактора у учётной записи нет, и запись в `users` означала бы, что он есть.
 * Повторное открытие страницы отдаёт тот же секрет — иначе человек, переснявший
 * QR-код после перезагрузки страницы, подтверждал бы уже не тот секрет, который
 * унёс в приложение.
 */
export async function pendingEnrollment(
	ctx: ActorContext,
	sessionId: string
): Promise<PendingEnrollment> {
	const user = actor(ctx);

	if (user.isDemo) {
		throw refuseDemo('подключать второй фактор');
	}

	const redis = getRedis();
	const key = enrollmentKey(sessionId);
	const existing = await redis.get(key);
	const secret = existing ?? generateTotpSecret();

	await redis.set(key, secret, 'EX', ENROLLMENT_SECONDS);

	return { secret, uri: otpauthUri({ issuer: issuer(), account: user.email, secret }) };
}

/** Резервный код в том виде, в каком его показывают: три группы по четыре. */
function generateBackupCode(): string {
	const bytes = randomBytes(BACKUP_GROUPS * BACKUP_GROUP_SIZE);
	// Алфавит ровно в 32 символа, поэтому пять младших бит байта выбирают символ
	// равновероятно: остатка, который смещал бы выбор, здесь нет.
	const characters = [...bytes].map((byte) => BACKUP_ALPHABET[byte & 0b11111]);

	return Array.from({ length: BACKUP_GROUPS }, (_unused, group) =>
		characters.slice(group * BACKUP_GROUP_SIZE, (group + 1) * BACKUP_GROUP_SIZE).join('')
	).join('-');
}

/**
 * Приводит набранное к виду кода: человек переписывает его с бумаги, и дефисы,
 * пробелы и регистр — это оформление, а не часть кода.
 */
export function normalizeBackupCode(value: string): string {
	return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/**
 * Хеш резервного кода — SHA-256.
 *
 * Медленный хеш нужен паролю: его придумал человек, и перебор осмысленных
 * вариантов реален. Здесь код случайный, шестьдесят бит, и перебирать его
 * нечем ни быстрым хешем, ни медленным. А главное — рядом, в той же строке,
 * лежит секрет TOTP в открытом виде (зашифровать его нечем, см.
 * `docs/auth.md`): тот, кто прочитал базу, получает фактор целиком, и argon2 на
 * резервных кодах защищал бы уже пустое место.
 */
function hashBackupCode(code: string): string {
	return createHash('sha256').update(normalizeBackupCode(code), 'utf8').digest('hex');
}

function newBackupCodes(): { codes: string[]; hashes: string[] } {
	const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);

	return { codes, hashes: codes.map(hashBackupCode) };
}

/** Совпадение хешей постоянного времени: длина у них одна и та же. */
function sameHash(left: string, right: string): boolean {
	const a = Buffer.from(left, 'utf8');
	const b = Buffer.from(right, 'utf8');

	return a.length === b.length && timingSafeEqual(a, b);
}

/** Отмечает шаг использованным. Возвращает `false`, если он уже был предъявлен. */
async function claimCounter(userId: string, counter: number): Promise<boolean> {
	const claimed = await getRedis().set(
		usedCodeKey(userId, counter),
		'1',
		'EX',
		USED_CODE_SECONDS,
		'NX'
	);

	return claimed !== null;
}

/**
 * Завершает регистрацию: код подтверждает, что секрет действительно перенесён
 * в приложение, и только после этого он попадает в базу.
 *
 * Возвращает резервные коды в открытом виде — единственный раз за их жизнь.
 */
export async function confirmEnrollment(
	ctx: ActorContext,
	input: { sessionId: string; code: string }
): Promise<string[]> {
	const user = actor(ctx);

	if (user.isDemo) {
		throw refuseDemo('подключать второй фактор');
	}

	const secret = await getRedis().get(enrollmentKey(input.sessionId));

	if (secret === null) {
		throw new ConflictError('Регистрация не начата или уже устарела — откройте страницу заново');
	}

	const counter = verifyTotp(secret, input.code, { at: Date.now() });

	if (counter === null) {
		await recordAuditEvent(ctx, {
			type: 'auth.mfa_failed',
			outcome: 'failure',
			subject: { type: 'user', id: user.id },
			details: { userId: user.id }
		});

		throw new ValidationError('Фактор не подключён', [
			'Код не подошёл. Проверьте, что в приложении выбрана запись этой системы, и введите текущий код'
		]);
	}

	const { codes, hashes } = newBackupCodes();

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({
				totpSecret: secret,
				totpEnabledAt: sql`now()`,
				totpBackupCodes: hashes,
				updatedAt: sql`now()`
			})
			.where(eq(users.id, user.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'auth.mfa_enrolled',
				outcome: 'success',
				subject: { type: 'user', id: user.id },
				details: { userId: user.id }
			},
			tx
		);
	});

	// Код, которым подтвердили регистрацию, больше не годится: иначе первый же
	// шаг после неё принимает тот же код второй раз.
	await claimCounter(user.id, counter);

	await getRedis()
		.multi()
		.del(enrollmentKey(input.sessionId))
		// Разрешение закрыть второй шаг без кода — ровно один раз и ровно этой
		// сессии. Без него достаточно было бы отправить «Продолжить» мимо формы,
		// чтобы попасть внутрь с уже зарегистрированным фактором, не предъявив
		// кода. Резервные коды человек видит один раз, поэтому шаг «я их записал»
		// нужен, а бесплатным он быть не может.
		.set(enrolledKey(input.sessionId), '1', 'EX', ENROLLMENT_SECONDS)
		.exec();

	return codes;
}

/**
 * Забирает разрешение закрыть второй шаг после только что законченной
 * регистрации. Одноразовое: второй вызов вернёт `false`.
 */
export async function claimFreshEnrollment(sessionId: string): Promise<boolean> {
	return (await getRedis().getdel(enrolledKey(sessionId))) !== null;
}

export type SecondFactorOutcome =
	{ ok: true; kind: 'totp' | 'backup'; backupCodesLeft: number } | { ok: false; message: string };

function lockedMessage(remainingSeconds: number): string {
	const minutes = Math.max(1, Math.ceil(remainingSeconds / 60));

	return `Слишком много неудачных попыток. Вход в эту учётную запись закрыт ещё ${pluralize(minutes, ['минуту', 'минуты', 'минут'])}`;
}

/**
 * Второй шаг входа: код из приложения или резервный код.
 *
 * Отказ — обычный исход, а не сбой: функция возвращает результат, как и вход по
 * паролю, а показать его решает страница. Неудачные коды считаются в ту же
 * блокировку, что и неудачные пароли: без этого шестизначный код перебирается с
 * одного адреса за вечер.
 */
export async function verifySecondFactor(
	ctx: ActorContext,
	input: { code: string }
): Promise<SecondFactorOutcome> {
	const user = actor(ctx);

	// Второй шаг существует только для сессии, которая его не прошла. Полная
	// сессия, дошедшая сюда, всё равно ничего бы не закрыла (`finishSecondFactor`
	// откажет), но код предъявлен — и резервный код списался бы с учётной записи
	// ни за что. Поэтому отказ идёт до всякого расхода.
	if (!user.mfaPending) {
		throw new ConflictError('Второй шаг входа уже пройден');
	}

	const email = normalizeEmail(user.email);
	const ip = ctx.ip ?? UNKNOWN_ADDRESS;
	const policy = await getSetting('lockout_policy');
	const state = await lockoutState(email, ip);

	if (state.failures >= policy.attempts && state.remainingSeconds > 0) {
		await recordAuditEvent(ctx, {
			type: 'auth.locked',
			outcome: 'denied',
			subject: { type: 'user', id: user.id },
			details: { userId: user.id }
		});

		return { ok: false, message: lockedMessage(state.remainingSeconds) };
	}

	const row = await readFactor(user.id);

	if (row.totpSecret === null || row.totpEnabledAt === null) {
		throw new ConflictError('У этой учётной записи нет второго фактора');
	}

	const counter = verifyTotp(row.totpSecret, input.code, { at: Date.now() });

	if (counter !== null) {
		if (!(await claimCounter(user.id, counter))) {
			return refuseCode(
				ctx,
				user,
				email,
				ip,
				policy.minutes,
				'Этот код уже использован — дождитесь следующего'
			);
		}

		await clearLoginFailures(email, ip);

		await recordAuditEvent(ctx, {
			type: 'auth.mfa_verified',
			outcome: 'success',
			subject: { type: 'user', id: user.id },
			details: { userId: user.id }
		});

		return { ok: true, kind: 'totp', backupCodesLeft: row.totpBackupCodes?.length ?? 0 };
	}

	const claimed = await claimBackupCode(ctx, user.id, input.code);

	if (claimed === null) {
		return refuseCode(ctx, user, email, ip, policy.minutes, 'Код не подошёл');
	}

	await clearLoginFailures(email, ip);

	return { ok: true, kind: 'backup', backupCodesLeft: claimed.left };
}

/**
 * Списывает резервный код из набора. `null` — такого кода в наборе нет, в том
 * числе потому, что его только что забрала другая попытка.
 *
 * Код одноразовый, и «одноразовый» здесь означает «при любом числе
 * одновременных предъявлений». Поэтому проверка и списание — одна транзакция, а
 * строка на её время заперта (`for update`): без замка три параллельные попытки
 * читают один и тот же полный набор, каждая вычитает из него один и тот же код
 * и записывает одинаковый результат — код списан один раз, а впущены все трое.
 * Второй попытке замок даёт дождаться первой и увидеть уже укороченный набор.
 *
 * Отметки в Redis, как у шага TOTP (`claimCounter`), здесь не нужно: набор
 * резервных кодов и есть эта строка, и спор о нём должно решать то хранилище, в
 * котором он записан, а не второе рядом.
 */
async function claimBackupCode(
	ctx: ActorContext,
	userId: string,
	code: string
): Promise<{ left: number } | null> {
	const presented = hashBackupCode(code);

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.select({ codes: users.totpBackupCodes })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1)
			.for('update');

		if (row === undefined) {
			throw new NotFoundError('Пользователь не найден');
		}

		const stored = row.codes ?? [];
		const matched = stored.find((hash) => sameHash(hash, presented));

		if (matched === undefined) {
			return null;
		}

		const left = stored.filter((hash) => hash !== matched);

		await tx
			.update(users)
			.set({ totpBackupCodes: left, updatedAt: sql`now()` })
			.where(eq(users.id, userId));

		await recordAuditEvent(
			ctx,
			{
				type: 'auth.mfa_verified',
				outcome: 'success',
				subject: { type: 'user', id: userId },
				// Списанный резервный код — это изменение самой учётной записи, а не
				// просто удачная проверка: по этой отметке видно, что человек вошёл
				// не приложением.
				details: { userId, changedFields: ['totpBackupCodes'] }
			},
			tx
		);

		return { left: left.length };
	});
}

/** Неудачный код: попытка засчитывается в блокировку и попадает в журнал. */
async function refuseCode(
	ctx: ActorContext,
	user: SessionUser,
	email: string,
	ip: string,
	lockoutMinutes: number,
	message: string
): Promise<SecondFactorOutcome> {
	await registerLoginFailure(email, ip, lockoutMinutes);

	await recordAuditEvent(ctx, {
		type: 'auth.mfa_failed',
		outcome: 'failure',
		subject: { type: 'user', id: user.id },
		details: { userId: user.id }
	});

	return { ok: false, message };
}

/**
 * Код из приложения от самого владельца — подтверждение действия, а не вход.
 *
 * Резервный код здесь не принимается намеренно: он существует ровно для того
 * случая, когда приложения под рукой нет, и отключать им фактор или
 * перевыпускать резервные коды значило бы, что потерянного листка с кодами
 * достаточно, чтобы снять защиту совсем.
 */
async function requireOwnCode(ctx: ActorContext, code: string): Promise<void> {
	const user = actor(ctx);
	const row = await readFactor(user.id);

	if (row.totpSecret === null || row.totpEnabledAt === null) {
		throw new ConflictError('У этой учётной записи нет второго фактора');
	}

	const counter = verifyTotp(row.totpSecret, code, { at: Date.now() });

	if (counter === null) {
		await recordAuditEvent(ctx, {
			type: 'auth.mfa_failed',
			outcome: 'failure',
			subject: { type: 'user', id: user.id },
			details: { userId: user.id }
		});

		throw new ValidationError('Код не подошёл', [
			'Введите текущий код из приложения — он меняется каждые 30 секунд'
		]);
	}

	if (!(await claimCounter(user.id, counter))) {
		throw new ValidationError('Код не подошёл', [
			'Этот код уже использован — дождитесь следующего'
		]);
	}
}

/**
 * Отключение фактора самим владельцем. Роли, которой фактор обязателен, этого
 * нельзя: иначе политика снимается тем же нажатием, которым она соблюдается.
 */
export async function disableMfa(ctx: ActorContext, input: { code: string }): Promise<void> {
	const user = actor(ctx);

	if (user.isDemo) {
		throw refuseDemo('менять её второй фактор');
	}

	if (await mfaRequiredForRole(user.roleId)) {
		throw new ForbiddenError(
			'Второй фактор обязателен для вашей роли — отключить его может только администратор, изменив политику'
		);
	}

	await requireOwnCode(ctx, input.code);

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({
				totpSecret: null,
				totpEnabledAt: null,
				totpBackupCodes: null,
				updatedAt: sql`now()`
			})
			.where(eq(users.id, user.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'auth.mfa_disabled',
				outcome: 'success',
				subject: { type: 'user', id: user.id },
				details: { userId: user.id }
			},
			tx
		);
	});
}

/**
 * Новый набор резервных кодов вместо прежнего. Старые перестают действовать
 * сразу: набор существует как целое, и «десять старых плюс десять новых» — это
 * не запас, а вдвое больше ключей от одной двери.
 */
export async function regenerateBackupCodes(
	ctx: ActorContext,
	input: { code: string }
): Promise<string[]> {
	const user = actor(ctx);

	if (user.isDemo) {
		throw refuseDemo('менять её второй фактор');
	}

	await requireOwnCode(ctx, input.code);

	const { codes, hashes } = newBackupCodes();

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({ totpBackupCodes: hashes, updatedAt: sql`now()` })
			.where(eq(users.id, user.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'auth.mfa_enrolled',
				outcome: 'success',
				subject: { type: 'user', id: user.id },
				// Отдельного события на перевыпуск в словаре журнала нет, и заводить
				// его незачем: изменилась та же часть фактора, что и при регистрации,
				// а какая именно — сказано полем.
				details: { userId: user.id, changedFields: ['totpBackupCodes'] }
			},
			tx
		);
	});

	return codes;
}

/**
 * Сброс фактора администратором: телефон потерян, приложение стёрто, резервные
 * коды кончились. Сессии владельца гасятся — сброс делают, когда доступ к
 * фактору мог достаться кому-то ещё, и открытая где-то вкладка пережила бы его.
 */
export async function resetMfa(ctx: ActorContext, userId: string): Promise<void> {
	await requirePermission(ctx, 'users.manage', {
		type: 'auth.mfa_reset',
		subject: { type: 'user', id: userId }
	});

	const row = await readFactor(userId);

	if (row.totpEnabledAt === null && row.totpSecret === null) {
		throw new ConflictError('У этой учётной записи второго фактора нет');
	}

	await withTransaction(ctx, async (tx) => {
		await tx
			.update(users)
			.set({
				totpSecret: null,
				totpEnabledAt: null,
				totpBackupCodes: null,
				updatedAt: sql`now()`
			})
			.where(eq(users.id, userId));

		await recordAuditEvent(
			ctx,
			{
				type: 'auth.mfa_reset',
				outcome: 'success',
				subject: { type: 'user', id: userId },
				details: { userId }
			},
			tx
		);
	});

	await revokeAllSessions(userId);
}
