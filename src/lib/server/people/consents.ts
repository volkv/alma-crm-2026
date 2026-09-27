/**
 * Согласия на обработку персональных данных.
 *
 * Согласие здесь — запись, а не галочка на карточке: у него есть основание
 * (согласие субъекта, исполнение договора, требование закона), версия текста,
 * под которым человек подписался, дата получения и, возможно, дата отзыва.
 * Отозванное согласие остаётся в базе: на вопрос «на каком основании данные
 * лежали до отзыва» отвечают именно им.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
	type ConsentBasis,
	type ConsentView,
	type RecordConsentInput,
	type WithdrawConsentInput
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { consents, people, users } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, NotFoundError } from '../errors';
import { assertPersonVisible, personVisible } from './access';
import { requirePermission } from '../rbac';

/**
 * Согласие отозвано и не дано заново: у человека есть отозванное основание
 * обработки и нет ни одного действующего. Условие над строкой `people` — для
 * выборок, которые выносят данные человека из системы (передача списка в
 * систему обучения, выгрузка списка файлом): основания их обрабатывать больше
 * нет. Человек без записей о согласии сюда не попадает — у него ничего не
 * отзывали.
 */
export const consentWithdrawn = sql<boolean>`(
	exists (select 1 from ${consents} where ${consents.personId} = ${people.id} and ${consents.withdrawnAt} is not null)
	and not exists (select 1 from ${consents} where ${consents.personId} = ${people.id} and ${consents.withdrawnAt} is null)
)`;

/**
 * Автор фиксации и автор отзыва — это одна и та же таблица в двух ролях,
 * поэтому каждая роль входит в запрос под своим именем.
 */
const recordedByUser = alias(users, 'recorded_by_user');
const withdrawnByUser = alias(users, 'withdrawn_by_user');

function toConsentView(row: {
	consent: typeof consents.$inferSelect;
	recordedByName: string | null;
	withdrawnByName: string | null;
}): ConsentView {
	return {
		id: row.consent.id,
		personId: row.consent.personId,
		basis: row.consent.basis,
		textVersion: row.consent.textVersion,
		givenAt: row.consent.givenAt,
		withdrawnAt: row.consent.withdrawnAt,
		recordedByName: row.recordedByName,
		withdrawnByName: row.withdrawnByName
	};
}

/** Выборка согласий вместе с именами тех, кто их зафиксировал и отозвал. */
function selectConsents() {
	return getDb()
		.select({
			consent: consents,
			recordedByName: recordedByUser.fullName,
			withdrawnByName: withdrawnByUser.fullName
		})
		.from(consents)
		.leftJoin(recordedByUser, eq(recordedByUser.id, consents.recordedBy))
		.leftJoin(withdrawnByUser, eq(withdrawnByUser.id, consents.withdrawnBy));
}

/**
 * Согласия одного человека: действующие сверху, отозванные ниже. Право то же,
 * что и на их изменение: это не часть карточки контакта, а учёт оснований
 * обработки, и открывают его те, кто за него отвечает.
 */
export async function listConsents(ctx: ActorContext, personId: string): Promise<ConsentView[]> {
	requirePermission(ctx, 'people.manage_consents');
	await assertPersonVisible(ctx, personId);

	const rows = await selectConsents()
		.where(eq(consents.personId, personId))
		// Действующие сверху, отозванные ниже: карточка отвечает на вопрос «на
		// каком основании данные лежат сейчас», а история — уже вторым слоем.
		.orderBy(
			asc(sql`${consents.withdrawnAt} is not null`),
			desc(consents.givenAt),
			desc(consents.createdAt)
		);

	return rows.map(toConsentView);
}

/** Одно согласие в том же виде, в каком его отдаёт список. */
async function readConsent(consentId: string): Promise<ConsentView> {
	const [row] = await selectConsents().where(eq(consents.id, consentId)).limit(1);

	if (row === undefined) {
		throw new NotFoundError('Согласие не найдено');
	}

	return toConsentView(row);
}

/**
 * Человек, о котором идёт речь; обезличенному согласия уже не нужны.
 *
 * Область проверяется здесь же, а не только правом: операции идут по
 * идентификатору человека, и без этой проверки менеджер записал бы согласие за
 * чужой вуз, ни разу не открыв его карточку. Человек вне области — «не
 * найден», как и везде: разный ответ выдал бы существование чужой записи.
 */
async function requirePerson(
	ctx: ActorContext,
	personId: string
): Promise<typeof people.$inferSelect> {
	await assertPersonVisible(ctx, personId);

	const [row] = await getDb().select().from(people).where(eq(people.id, personId)).limit(1);

	if (row === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	return row;
}

export async function recordConsent(
	ctx: ActorContext,
	input: RecordConsentInput
): Promise<ConsentView> {
	await requirePermission(ctx, 'people.manage_consents', {
		type: 'people.consent_recorded',
		subject: { type: 'person', id: input.personId }
	});

	const person = await requirePerson(ctx, input.personId);

	if (person.anonymizedAt !== null) {
		throw new ConflictError('Данные человека обезличены: согласие фиксировать не на что');
	}

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.insert(consents)
			.values({
				personId: input.personId,
				basis: input.basis,
				textVersion: input.textVersion,
				givenAt: input.givenAt,
				recordedBy: ctx.user?.id ?? null
			})
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'people.consent_recorded',
				outcome: 'success',
				subject: { type: 'consent', id: row.id },
				details: { personId: row.personId }
			},
			tx
		);

		return row.id;
	}).then(readConsent);
}

/**
 * Отзыв согласия. Условие «ещё не отозвано» живёт в самом `UPDATE`: между
 * чтением и записью отзыв мог зафиксировать кто-то другой, и тогда мы затёрли
 * бы чужую дату.
 */
export async function withdrawConsent(
	ctx: ActorContext,
	input: WithdrawConsentInput
): Promise<ConsentView> {
	await requirePermission(ctx, 'people.manage_consents', {
		type: 'people.consent_withdrawn',
		subject: { type: 'consent', id: input.id }
	});

	// Согласие ищется по своему идентификатору, а область — это люди: без
	// условия видимости отзыв дотянулся бы до согласия человека чужого вуза.
	// Чужое согласие — «не найдено», как и несуществующее.
	const [found] = await getDb()
		.select({ consent: consents })
		.from(consents)
		.innerJoin(people, eq(people.id, consents.personId))
		.where(and(eq(consents.id, input.id), personVisible(ctx)))
		.limit(1);
	const existing = found?.consent;

	if (existing === undefined) {
		throw new NotFoundError('Согласие не найдено');
	}

	if (existing.withdrawnAt !== null) {
		throw new ConflictError(`Согласие уже отозвано ${existing.withdrawnAt}`);
	}

	if (input.withdrawnAt < existing.givenAt) {
		throw new ConflictError('Отзыв не может быть раньше даты получения согласия');
	}

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.update(consents)
			.set({
				withdrawnAt: input.withdrawnAt,
				withdrawnBy: ctx.user?.id ?? null,
				updatedAt: sql`now()`
			})
			.where(and(eq(consents.id, input.id), isNull(consents.withdrawnAt)))
			.returning();

		// Проверка выше отвечает на вопрос «когда отозвали», а это условие — на
		// вопрос «а не отозвал ли кто-то, пока мы читали».
		if (row === undefined) {
			throw new ConflictError('Согласие уже отозвано');
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'people.consent_withdrawn',
				outcome: 'success',
				subject: { type: 'consent', id: row.id },
				details: { personId: row.personId, changedFields: ['withdrawnAt'] }
			},
			tx
		);

		return row.id;
	}).then(readConsent);
}

/**
 * Основание обработки, которое приносит сам путь заведения человека: заявка с
 * сайта — согласие, оплата — договор-оферту, контакт организации — договор с
 * ней, физлицо из формы дела — то, что выбрал сотрудник. Пишется в транзакции
 * вызывающего, без `recordConsent`: тот — путь карточки, он открывает свою
 * транзакцию и проверяет видимость человека, которого общий пул ещё не видит.
 * Запись с той же версией текста второй раз не заводится.
 */
export async function recordProcessingBasis(
	ctx: ActorContext,
	tx: Tx,
	personId: string,
	basis: { basis: ConsentBasis; textVersion: string; givenAt: string }
): Promise<void> {
	const existing = await tx
		.select({ id: consents.id })
		.from(consents)
		.where(and(eq(consents.personId, personId), eq(consents.textVersion, basis.textVersion)))
		.limit(1);

	if (existing.length > 0) {
		return;
	}

	const [row] = await tx
		.insert(consents)
		.values({
			personId,
			basis: basis.basis,
			textVersion: basis.textVersion,
			givenAt: basis.givenAt,
			recordedBy: ctx.user?.id ?? null
		})
		.returning({ id: consents.id });

	await recordAuditEvent(
		ctx,
		{
			type: 'people.consent_recorded',
			outcome: 'success',
			subject: { type: 'consent', id: row.id },
			details: { personId }
		},
		tx
	);
}
