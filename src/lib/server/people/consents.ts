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
	type ConsentView,
	type RecordConsentInput,
	type WithdrawConsentInput
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { consents, people, users } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, NotFoundError } from '../errors';
import { assertPersonVisible } from './access';
import { requirePermission } from '../rbac';

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

	const [existing] = await getDb()
		.select()
		.from(consents)
		.where(eq(consents.id, input.id))
		.limit(1);

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
