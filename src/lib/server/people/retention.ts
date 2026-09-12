/**
 * Срок хранения персональных данных и их уничтожение.
 *
 * Персональные данные хранят не дольше, чем нужно для цели, ради которой их
 * собрали, и уничтожают по её достижении. В системе это два действия: назначить
 * срок и, когда он прошёл, обезличить запись — стереть фамилию, имя и контакты,
 * оставив саму строку. Удалить её нельзя: на человека ссылаются роли в
 * организациях и взаимодействия, где он был контактом, и «этого контакта у нас
 * никогда не было» — неправда.
 *
 * Обезличивание необратимо. Отменяющей команды здесь нет намеренно: то, что
 * стёрли, в базе не лежит и восстановлению не подлежит.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
	ANONYMIZED_PERSON_LAST_NAME,
	type PersonView,
	type SetRetentionInput
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { people } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, NotFoundError } from '../errors';
import { requirePermission } from '../rbac';
import { toPersonView } from './serialize';
import { withPiiTrace } from './pii-trace';

/**
 * Условие «срок хранения прошёл, а данные ещё на месте». Сутки считает база:
 * «сегодня» у приложения и у базы должно быть одно, иначе запись то попадает в
 * очередь на уничтожение, то нет.
 *
 * Отдельного списка под это правило нет намеренно: очередь на уничтожение —
 * тот же справочник людей с включённым фильтром, и второй список с собственным
 * поиском, сортировкой и областью доступа разошёлся бы с первым.
 */
export const retentionExpired = sql<boolean>`(
	${people.retentionUntil} is not null
	and ${people.retentionUntil} <= current_date
	and ${people.anonymizedAt} is null
)`;

/**
 * Назначает или снимает срок хранения. Снятие — это не «хранить вечно», а
 * «срок ещё не назначен»: решение принимает человек, и до него запись просто
 * ждёт.
 */
export async function setRetention(
	ctx: ActorContext,
	input: SetRetentionInput
): Promise<PersonView> {
	await requirePermission(ctx, 'people.manage_consents', {
		type: 'people.retention_changed',
		subject: { type: 'person', id: input.personId }
	});

	const [before] = await getDb()
		.select()
		.from(people)
		.where(eq(people.id, input.personId))
		.limit(1);

	if (before === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	if (before.anonymizedAt !== null) {
		throw new ConflictError('Данные человека обезличены: срок хранения им больше не нужен');
	}

	if (before.retentionUntil === input.retentionUntil) {
		throw new ConflictError('Срок хранения уже такой');
	}

	return withPiiTrace(ctx, () =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(people)
				.set({ retentionUntil: input.retentionUntil, updatedAt: sql`now()` })
				.where(eq(people.id, input.personId))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'people.retention_changed',
					outcome: 'success',
					subject: { type: 'person', id: row.id },
					details: { changedFields: ['retentionUntil'] }
				},
				tx
			);

			return toPersonView(ctx, row);
		})
	);
}

/**
 * Плановое уничтожение персональных данных: фамилия заменяется словом
 * «Обезличено», имя, отчество, контакты и заметки стираются. Роли человека и
 * его след во взаимодействиях остаются — там он больше никем не назван.
 *
 * Условие «ещё не обезличен» живёт в самом `UPDATE`: между чтением и записью
 * то же самое мог сделать кто-то другой, и второй проход стёр бы уже пустое,
 * но переписал бы дату уничтожения.
 */
export async function anonymizePerson(ctx: ActorContext, personId: string): Promise<PersonView> {
	await requirePermission(ctx, 'people.manage_consents', {
		type: 'people.anonymized',
		subject: { type: 'person', id: personId }
	});

	const [before] = await getDb().select().from(people).where(eq(people.id, personId)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	if (before.anonymizedAt !== null) {
		throw new ConflictError('Данные человека уже обезличены');
	}

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.update(people)
			.set({
				lastName: ANONYMIZED_PERSON_LAST_NAME,
				// Пустое имя, а не прочерк: собранное из частей ФИО показывает одно
				// слово «Обезличено», и подставлять вместо стёртого имени значок,
				// который выглядит как данные, незачем.
				firstName: '',
				middleName: null,
				email: null,
				phone: null,
				notes: null,
				anonymizedAt: sql`now()`,
				updatedAt: sql`now()`
			})
			.where(and(eq(people.id, personId), isNull(people.anonymizedAt)))
			.returning();

		if (row === undefined) {
			throw new ConflictError('Данные человека уже обезличены');
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'people.anonymized',
				outcome: 'success',
				subject: { type: 'person', id: row.id },
				details: { personId: row.id }
			},
			tx
		);

		return toPersonView(ctx, row);
	});
}
