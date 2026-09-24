/**
 * Запись справочников: организации и их площадки, люди и их роли, программы и
 * продукты.
 *
 * Три правила держат весь модуль. Первое: записи справочника не удаляются —
 * организация уходит в архив (`is_active = false`), роль человека закрывается
 * датой, программа получает новую версию. На них ссылаются взаимодействия и
 * документы, и задним числом «этого вуза у нас не было» быть не должно.
 * Второе: отказ по правам — это событие журнала, а не молчание, поэтому право
 * спрашивается формой `requirePermission` с описанием отказа. Третье:
 * уникальность проверяет база, а сервис переводит её нарушение в понятную
 * фразу — иначе гонка двух вкладок покажет человеку код PostgreSQL.
 */
import { and, eq, max, ne, sql } from 'drizzle-orm';
import type {
	AffiliationView,
	CreateAffiliationInput,
	CreateDirectionInput,
	DirectionView,
	CreateOrganizationInput,
	CreatePersonInput,
	CreateProductInput,
	CreateProgramInput,
	CreateProgramVersionInput,
	CreateSiteInput,
	EndAffiliationInput,
	LinkProductDirectionInput,
	OrganizationView,
	PersonView,
	ProductView,
	ProgramVersionView,
	ProgramView,
	SiteView,
	UpdateDirectionInput,
	UpdateOrganizationInput,
	UpdatePersonInput,
	UpdateProductInput,
	UpdateProgramInput,
	UpdateSiteInput
} from '$lib/contracts/directory';
import type { PassportProvenance } from '$lib/contracts/enrichment';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { invalidateDirectoryOptions } from '../cache/directory';
import { getDb } from '../db';
import {
	affiliations,
	directions,
	organizationResponsibles,
	organizations,
	people,
	productDirections,
	products,
	programVersions,
	programs,
	sites
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';

/** Кто выполняет запрос: транзакция вызывающего или общий пул. */
type Executor = Tx | ReturnType<typeof getDb>;
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { assertPersonVisible } from '../people/access';
import { contactColumns, decryptContacts } from '../people/pii';
import { withPiiTrace } from '../people/pii-trace';
import { toPersonView } from '../people/serialize';
import { requirePermission, scopeFilter } from '../rbac';
import { withUniqueConflicts } from './conflicts';
import {
	findOrganizationByInn,
	getDirectionRow,
	getOrganization,
	getSite,
	toDirectionView,
	toOrganizationView
} from './read';

/** Поля, значение которых изменилось: их список идёт в журнал вместо значений. */
function changedFields<TRow extends object>(before: TRow, after: Partial<TRow>): string[] {
	return Object.keys(after).filter((key) => before[key as keyof TRow] !== after[key as keyof TRow]);
}

/**
 * ИНН — ключ сверки с внешними справочниками, поэтому дубль по нему
 * отвергается до записи и с объяснением, какая организация его уже занимает.
 * Проверка идёт по всей базе, а не по области доступа: уникальный индекс тоже
 * не знает про области. А вот название чужой организации в ответ не попадает —
 * иначе перебором ИНН можно собрать справочник, закрытый областью доступа.
 */
async function assertInnIsFree(
	ctx: ActorContext,
	inn: string | null,
	exceptId?: string,
	executor: Tx | ReturnType<typeof getDb> = getDb()
): Promise<void> {
	if (inn === null) {
		return;
	}

	const conditions = [eq(organizations.inn, inn)];

	if (exceptId !== undefined) {
		conditions.push(ne(organizations.id, exceptId));
	}

	const [clash] = await executor
		.select({ id: organizations.id })
		.from(organizations)
		.where(and(...conditions))
		.limit(1);

	if (clash === undefined) {
		return;
	}

	const visible = await findOrganizationByInn(ctx, inn, executor);

	throw new ConflictError(
		visible === null
			? `ИНН ${inn} уже занят другой организацией`
			: `ИНН ${inn} уже указан у организации «${visible.label}»`
	);
}

/**
 * Запись в справочник состоялась: подбор, собранный раньше, больше не
 * показывать.
 *
 * Обесценивание идёт **после** того, как запись завершилась, а не внутри неё:
 * до фиксации транзакции показывать ещё нечего, а сбросить кэш ради отката
 * значило бы собрать его заново на тех же данных.
 *
 * Вложенный вызов — тот, которому транзакцию передали снаружи (приём заявки с
 * сайта, загрузка каталога файлом), — обесценивает кэш, когда его собственная
 * работа сделана, но внешняя транзакция ещё не зафиксирована. Владелец
 * транзакции зовёт `invalidateDirectoryOptions` ещё раз, уже после фиксации:
 * `INCR` стоит одну команду, а окно между двумя вызовами — единственное место,
 * где читатель успел бы положить в кэш то, чего ещё нет.
 */
async function written<TResult>(result: Promise<TResult>): Promise<TResult> {
	const value = await result;

	await invalidateDirectoryOptions();

	return value;
}

/**
 * Поля карточки приняты из паспорта организации: событие с источником и датой
 * каждого значения. Пишется в той же транзакции, что и сами поля, — принятое
 * значение без записи о происхождении ничем не отличалось бы от набранного
 * руками. Пустой список — ничего не принималось, и события нет.
 */
async function recordPassportProvenance(
	ctx: ActorContext,
	organizationId: string,
	provenance: readonly PassportProvenance[],
	executor: Tx
): Promise<void> {
	if (provenance.length === 0) {
		return;
	}

	await recordAuditEvent(
		ctx,
		{
			type: 'organizations.passport_applied',
			outcome: 'success',
			subject: { type: 'organization', id: organizationId },
			details: {
				changedFields: provenance.map((entry) => entry.field),
				provenance: provenance.map(({ field, source, fetchedAt, via }) => ({
					field,
					source,
					fetchedAt,
					via
				}))
			}
		},
		executor
	);
}

/**
 * Заведение организации. `tx` передаёт тот, кто уже открыл транзакцию и
 * отвечает за целостность операции целиком: заявка с сайта заводит организацию,
 * человека, его роль и взаимодействие — либо всё, либо ничего. Своей
 * транзакции вложенный вызов не начинает, и запись в журнал уходит в ту же.
 */
export async function createOrganization(
	ctx: ActorContext,
	input: CreateOrganizationInput,
	tx?: Tx,
	provenance: readonly PassportProvenance[] = []
): Promise<OrganizationView> {
	await requirePermission(ctx, 'organizations.write', { type: 'organizations.created' });
	await assertInnIsFree(ctx, input.inn, undefined, tx);

	const write = async (executor: Tx): Promise<OrganizationView> => {
		const [row] = await executor.insert(organizations).values(input).returning();

		// Автор сразу становится ответственным: иначе менеджер завёл бы карточку
		// и тут же потерял её из виду — область считается по действующим
		// назначениям, и у новой организации их нет ни одного.
		//
		// Организация-оператор из этого правила выведена: она стоит стороной
		// почти в каждом взаимодействии, и назначение на неё отдало бы автору все
		// записи продукта разом. Фоновые задачи и сиды тоже: у них нет человека,
		// которому эта организация принадлежала бы.
		if (ctx.user !== null && row.kind !== 'operator') {
			await executor.insert(organizationResponsibles).values({
				organizationId: row.id,
				userId: ctx.user.id,
				assignedByUserId: ctx.user.id
			});

			await recordAuditEvent(
				ctx,
				{
					type: 'directory.responsible_assigned',
					outcome: 'success',
					subject: { type: 'organization', id: row.id },
					details: { organizationId: row.id, userId: ctx.user.id }
				},
				executor
			);
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'organizations.created',
				outcome: 'success',
				subject: { type: 'organization', id: row.id }
			},
			executor
		);
		await recordPassportProvenance(ctx, row.id, provenance, executor);

		return toOrganizationView(row);
	};

	return written(
		withUniqueConflicts(() => (tx === undefined ? withTransaction(ctx, write) : write(tx)))
	);
}

export async function updateOrganization(
	ctx: ActorContext,
	input: UpdateOrganizationInput,
	provenance: readonly PassportProvenance[] = []
): Promise<OrganizationView> {
	await requirePermission(ctx, 'organizations.write', {
		type: 'organizations.updated',
		subject: { type: 'organization', id: input.id }
	});

	// Организация вне области доступа отдаётся как «не найдена» — тем же путём,
	// что и в чтении, чтобы перебор идентификаторов ничего не рассказывал.
	const before = await getOrganization(ctx, input.id);
	const { id, ...fields } = input;

	await assertInnIsFree(ctx, fields.inn, id);

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.update(organizations)
					.set({ ...fields, updatedAt: sql`now()` })
					.where(eq(organizations.id, id))
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'organizations.updated',
						outcome: 'success',
						subject: { type: 'organization', id },
						details: { changedFields: changedFields(before, fields) }
					},
					tx
				);
				await recordPassportProvenance(ctx, id, provenance, tx);

				return toOrganizationView(row);
			})
		)
	);
}

/**
 * Организация уходит в архив, а не удаляется: на неё ссылаются взаимодействия,
 * документы и роли людей, и «этого вуза у нас никогда не было» — неправда.
 */
export async function archiveOrganization(
	ctx: ActorContext,
	id: string
): Promise<OrganizationView> {
	await requirePermission(ctx, 'organizations.write', {
		type: 'organizations.deactivated',
		subject: { type: 'organization', id }
	});

	const before = await getOrganization(ctx, id);

	if (!before.isActive) {
		throw new ConflictError('Организация уже в архиве');
	}

	return written(
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(organizations)
				.set({ isActive: false, updatedAt: sql`now()` })
				.where(eq(organizations.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'organizations.deactivated',
					outcome: 'success',
					subject: { type: 'organization', id }
				},
				tx
			);

			return toOrganizationView(row);
		})
	);
}

/**
 * Возврат из архива — обратная операция к архивированию: вуз, с которым снова
 * начали работать, не заводят второй записью, иначе история взаимодействий
 * разъедется на две организации. Событие журнала то же, что у правки, с одним
 * изменённым полем: отдельного кода на это ничего не спрашивают, а вопрос
 * «когда вернули» читается по нему. Повторный возврат — конфликт, а не
 * молчаливый успех.
 */
export async function restoreOrganization(
	ctx: ActorContext,
	id: string
): Promise<OrganizationView> {
	await requirePermission(ctx, 'organizations.write', {
		type: 'organizations.updated',
		subject: { type: 'organization', id }
	});

	const before = await getOrganization(ctx, id);

	if (before.isActive) {
		throw new ConflictError('Организация и так не в архиве');
	}

	return written(
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(organizations)
				.set({ isActive: true, updatedAt: sql`now()` })
				.where(eq(organizations.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'organizations.updated',
					outcome: 'success',
					subject: { type: 'organization', id },
					details: { changedFields: ['isActive'] }
				},
				tx
			);

			return toOrganizationView(row);
		})
	);
}

function toSiteView(row: typeof sites.$inferSelect): SiteView {
	return {
		id: row.id,
		organizationId: row.organizationId,
		kind: row.kind,
		name: row.name,
		address: row.address,
		region: row.region
	};
}

export async function createSite(ctx: ActorContext, input: CreateSiteInput): Promise<SiteView> {
	await requirePermission(ctx, 'organizations.write', {
		type: 'organizations.site_created',
		subject: { type: 'organization', id: input.organizationId }
	});

	await getOrganization(ctx, input.organizationId);

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx.insert(sites).values(input).returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'organizations.site_created',
						outcome: 'success',
						subject: { type: 'site', id: row.id },
						details: { organizationId: row.organizationId }
					},
					tx
				);

				return toSiteView(row);
			})
		)
	);
}

export async function updateSite(ctx: ActorContext, input: UpdateSiteInput): Promise<SiteView> {
	await requirePermission(ctx, 'organizations.write', {
		type: 'organizations.site_updated',
		subject: { type: 'site', id: input.id }
	});

	const before = await getSite(ctx, input.id);
	const { id, ...fields } = input;

	// Площадку не переносят между организациями: на пару «площадка + её
	// организация» ссылаются роли людей, и перенос сделал бы эти ссылки ложью.
	if (fields.organizationId !== before.organizationId) {
		throw new ValidationError('Площадку нельзя перенести в другую организацию', [
			'Заведите площадку в нужной организации и закройте прежнюю'
		]);
	}

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.update(sites)
					.set({ ...fields, updatedAt: sql`now()` })
					.where(eq(sites.id, id))
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'organizations.site_updated',
						outcome: 'success',
						subject: { type: 'site', id },
						details: {
							organizationId: row.organizationId,
							changedFields: changedFields(before, fields)
						}
					},
					tx
				);

				return toSiteView(row);
			})
		)
	);
}

/** Заведение человека; `tx` — как у `createOrganization`. */
export async function createPerson(
	ctx: ActorContext,
	input: CreatePersonInput,
	tx?: Tx
): Promise<PersonView> {
	await requirePermission(ctx, 'people.write', { type: 'people.created' });

	const write = async (executor: Tx): Promise<PersonView> => {
		// Контакты — через `contactColumns`: в базу они едут шифртекстом, и
		// ключи сравнения обязаны лечь тем же оператором, что и он сам.
		const [row] = await executor
			.insert(people)
			.values({ ...input, ...contactColumns(input) })
			.returning();

		await recordAuditEvent(
			ctx,
			{ type: 'people.created', outcome: 'success', subject: { type: 'person', id: row.id } },
			executor
		);

		// Даже автор записи получает её обратно через сериализатор: право на
		// запись и право видеть контакты — разные права.
		return toPersonView(ctx, row);
	};

	// Ответ уносит контакты наружу — значит, и он оставляет след просмотра:
	// правило одно на чтения и на возвраты записи.
	return written(
		withPiiTrace(ctx, () => (tx === undefined ? withTransaction(ctx, write) : write(tx)), tx)
	);
}

/**
 * Изменение человека переписывает запись целиком, поэтому требует и права
 * видеть контакты: иначе тот, кому они показаны замаскированными, сохранил бы
 * в базу «i***@vuz.ru» вместо адреса и стёр бы настоящий.
 *
 * Граница области — здесь, а не в маршрутах: правка идёт по идентификатору,
 * и форма, API и любой будущий вход иначе проверяли бы её каждый по-своему.
 */
export async function updatePerson(
	ctx: ActorContext,
	input: UpdatePersonInput
): Promise<PersonView> {
	await requirePermission(ctx, 'people.write', {
		type: 'people.updated',
		subject: { type: 'person', id: input.id }
	});
	await requirePermission(ctx, 'people.read_pii', {
		type: 'people.updated',
		subject: { type: 'person', id: input.id }
	});

	await assertPersonVisible(ctx, input.id);

	const { id, ...fields } = input;
	const db = getDb();

	const [before] = await db.select().from(people).where(eq(people.id, id)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	// Обезличивание необратимо, и правка — единственный путь, которым стёртые
	// данные могли бы вернуться в ту же запись. Нужен контакт с этим именем —
	// заводят нового человека, а не воскрешают уничтоженного.
	if (before.anonymizedAt !== null) {
		throw new ConflictError('Данные человека обезличены: изменить их нельзя');
	}

	return written(
		withPiiTrace(ctx, () =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.update(people)
					.set({ ...fields, ...contactColumns(fields), updatedAt: sql`now()` })
					.where(eq(people.id, id))
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'people.updated',
						outcome: 'success',
						subject: { type: 'person', id },
						// В журнал попадают только имена изменённых полей: значения здесь —
						// персональные данные, а журнал неизменяем. Сравнивается открытый
						// вид: у одного и того же адреса шифртекст каждый раз новый, и по
						// нему «изменилось» стояло бы в каждой правке.
						details: { changedFields: changedFields(decryptContacts(before), fields) }
					},
					tx
				);

				return toPersonView(ctx, row);
			})
		)
	);
}

/**
 * Роль вместе с человеком, которому она принадлежит. Контакты в ответе те же,
 * что в чтении, поэтому вызывающий обязан открыть область сбора следа
 * просмотра — снаружи транзакции, чтобы событие не ушло в журнал раньше, чем
 * запись подтвердится.
 */
async function toAffiliationView(
	ctx: ActorContext,
	tx: Tx,
	row: typeof affiliations.$inferSelect
): Promise<AffiliationView> {
	const [person] = await tx.select().from(people).where(eq(people.id, row.personId)).limit(1);

	if (person === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	return {
		id: row.id,
		person: toPersonView(ctx, person),
		organizationId: row.organizationId,
		siteId: row.siteId,
		position: row.position,
		roleKind: row.roleKind,
		isPrimary: row.isPrimary,
		validFrom: row.validFrom,
		validTo: row.validTo,
		channel: row.channel
	};
}

/**
 * Роль человека в организации. Принадлежность площадки той же организации
 * проверяет составной внешний ключ — здесь она переводится в понятную фразу,
 * потому что выбрать чужую площадку легко, а код `23503` ничего не объясняет.
 */
export async function createAffiliation(
	ctx: ActorContext,
	input: CreateAffiliationInput,
	tx?: Tx
): Promise<AffiliationView> {
	await requirePermission(ctx, 'people.write', {
		type: 'people.affiliation_created',
		subject: { type: 'organization', id: input.organizationId }
	});

	// Проверки идут тем же исполнителем, что и запись: организацию и человека
	// могли завести в этой же транзакции, и общий пул их ещё не видит. Человек
	// проверяется наравне с организацией: иначе роль в своём вузе приписали бы
	// сотруднику чужого, которого вызывающий не видит.
	await getOrganization(ctx, input.organizationId, tx);
	await assertPersonVisible(ctx, input.personId, tx);

	if (input.siteId !== null) {
		const site = await getSite(ctx, input.siteId, tx);

		if (site.organizationId !== input.organizationId) {
			throw new ValidationError('Роль не сохранена', ['Площадка принадлежит другой организации']);
		}
	}

	const write = async (executor: Tx): Promise<AffiliationView> => {
		const [row] = await executor.insert(affiliations).values(input).returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'people.affiliation_created',
				outcome: 'success',
				subject: { type: 'affiliation', id: row.id },
				details: { personId: row.personId, organizationId: row.organizationId }
			},
			executor
		);

		return toAffiliationView(ctx, executor, row);
	};

	return written(
		withPiiTrace(ctx, () => (tx === undefined ? withTransaction(ctx, write) : write(tx)), tx)
	);
}

/**
 * Закрытие периода полномочий. Роль остаётся в базе: взаимодействия, где этот
 * человек был контактом, обязаны помнить, кем он тогда был.
 */
export async function endAffiliation(
	ctx: ActorContext,
	input: EndAffiliationInput
): Promise<AffiliationView> {
	await requirePermission(ctx, 'people.write', {
		type: 'people.affiliation_updated',
		subject: { type: 'affiliation', id: input.id }
	});

	const db = getDb();

	const [before] = await db
		.select()
		.from(affiliations)
		.where(and(eq(affiliations.id, input.id), scopeFilter(ctx, affiliations.organizationId)))
		.limit(1);

	if (before === undefined) {
		throw new NotFoundError('Роль не найдена');
	}

	if (before.validTo !== null) {
		throw new ConflictError(`Полномочия уже закрыты ${before.validTo}`);
	}

	if (input.validTo < before.validFrom) {
		throw new ValidationError('Полномочия не закрыты', [
			'Дата окончания не может быть раньше даты начала полномочий'
		]);
	}

	return written(
		withPiiTrace(ctx, () =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.update(affiliations)
					.set({ validTo: input.validTo, updatedAt: sql`now()` })
					.where(eq(affiliations.id, input.id))
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'people.affiliation_updated',
						outcome: 'success',
						subject: { type: 'affiliation', id: row.id },
						details: {
							personId: row.personId,
							organizationId: row.organizationId,
							changedFields: ['validTo']
						}
					},
					tx
				);

				return toAffiliationView(ctx, tx, row);
			})
		)
	);
}

function toProgramView(row: typeof programs.$inferSelect): ProgramView {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		level: row.level,
		directionCode: row.directionCode,
		priority: row.priority,
		status: row.status
	};
}

export async function createProgram(
	ctx: ActorContext,
	input: CreateProgramInput
): Promise<ProgramView> {
	await requirePermission(ctx, 'programs.write', { type: 'programs.created' });

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx.insert(programs).values(input).returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'programs.created',
						outcome: 'success',
						subject: { type: 'program', id: row.id }
					},
					tx
				);

				return toProgramView(row);
			})
		)
	);
}

export async function updateProgram(
	ctx: ActorContext,
	input: UpdateProgramInput
): Promise<ProgramView> {
	await requirePermission(ctx, 'programs.write', {
		type: 'programs.updated',
		subject: { type: 'program', id: input.id }
	});

	await assertPersonVisible(ctx, input.id);

	const { id, ...fields } = input;
	const db = getDb();

	const [before] = await db.select().from(programs).where(eq(programs.id, id)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Программа не найдена');
	}

	// Уход в архив — отдельное событие журнала: по нему отвечают на вопрос
	// «когда программу перестали предлагать», а не листают все правки подряд.
	const archived = fields.status === 'archived' && before.status !== 'archived';

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.update(programs)
					.set({ ...fields, updatedAt: sql`now()` })
					.where(eq(programs.id, id))
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: archived ? 'programs.archived' : 'programs.updated',
						outcome: 'success',
						subject: { type: 'program', id },
						details: { changedFields: changedFields(before, fields) }
					},
					tx
				);

				return toProgramView(row);
			})
		)
	);
}

/**
 * Новая версия программы. Номер считается внутри транзакции по строке
 * программы, взятой `for update`: без блокировки две одновременные версии
 * получили бы один номер и разошлись бы только на уникальном индексе.
 */
export async function addProgramVersion(
	ctx: ActorContext,
	input: CreateProgramVersionInput
): Promise<ProgramVersionView> {
	await requirePermission(ctx, 'programs.write', {
		type: 'programs.version_created',
		subject: { type: 'program', id: input.programId }
	});

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [program] = await tx
					.select({ id: programs.id })
					.from(programs)
					.where(eq(programs.id, input.programId))
					.for('update')
					.limit(1);

				if (program === undefined) {
					throw new NotFoundError('Программа не найдена');
				}

				const [current] = await tx
					.select({ value: max(programVersions.version) })
					.from(programVersions)
					.where(eq(programVersions.programId, input.programId));

				const [row] = await tx
					.insert(programVersions)
					.values({
						programId: input.programId,
						version: (current?.value ?? 0) + 1,
						summary: input.summary,
						effectiveFrom: input.effectiveFrom,
						createdBy: ctx.user?.id ?? null
					})
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'programs.version_created',
						outcome: 'success',
						subject: { type: 'program_version', id: row.id },
						details: { programId: row.programId }
					},
					tx
				);

				return {
					id: row.id,
					programId: row.programId,
					version: row.version,
					summary: row.summary,
					effectiveFrom: row.effectiveFrom,
					createdAt: row.createdAt
				};
			})
		)
	);
}

/**
 * Заведение ИТ-направления.
 *
 * Позицию в списке назначает сервис, а не форма: направления показываются в
 * своём порядке значимости, и новое встаёт в конец. Считается она внутри
 * транзакции по уже заведённым строкам, а гонку двух одновременных заведений
 * ловит уникальный индекс — проверка в приложении её не поймала бы.
 */
export async function createDirection(
	ctx: ActorContext,
	input: CreateDirectionInput,
	tx?: Tx
): Promise<DirectionView> {
	await requirePermission(ctx, 'directions.write', { type: 'directions.created' });

	const write = async (executor: Tx): Promise<DirectionView> => {
		const [last] = await executor.select({ value: max(directions.position) }).from(directions);

		const [row] = await executor
			.insert(directions)
			.values({ ...input, position: (last?.value ?? 0) + 1 })
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'directions.created',
				outcome: 'success',
				subject: { type: 'direction', id: row.id }
			},
			executor
		);

		return toDirectionView(row);
	};

	return written(
		withUniqueConflicts(() => (tx === undefined ? withTransaction(ctx, write) : write(tx)))
	);
}

/**
 * Правка направления: код и название. Позицию форма не присылает — её назначает
 * заведение, а перестановка задевала бы соседние строки (позиция уникальна) и
 * сама по себе никому не нужна: направлений десятки, и порядок у них один.
 */
export async function updateDirection(
	ctx: ActorContext,
	input: UpdateDirectionInput
): Promise<DirectionView> {
	await requirePermission(ctx, 'directions.write', {
		type: 'directions.updated',
		subject: { type: 'direction', id: input.id }
	});

	const { id, ...fields } = input;
	const before = await getDirectionRow(ctx, id);

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.update(directions)
					.set({ ...fields, updatedAt: sql`now()` })
					.where(eq(directions.id, id))
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: 'directions.updated',
						outcome: 'success',
						subject: { type: 'direction', id },
						details: { changedFields: changedFields(before, fields) }
					},
					tx
				);

				return toDirectionView(row);
			})
		)
	);
}

/**
 * Направление уходит в архив, а не удаляется: на него ссылаются назначения
 * ответственных, продукты и программы, и «такого направления у нас никогда не
 * было» — неправда. Архивное не предлагают в подсказках назначения, но в
 * списке, в отчётах и в истории оно остаётся.
 */
export async function archiveDirection(ctx: ActorContext, id: string): Promise<DirectionView> {
	await requirePermission(ctx, 'directions.write', {
		type: 'directions.archived',
		subject: { type: 'direction', id }
	});

	const before = await getDirectionRow(ctx, id);

	if (!before.isActive) {
		throw new ConflictError('Направление уже в архиве');
	}

	return written(
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(directions)
				.set({ isActive: false, updatedAt: sql`now()` })
				.where(eq(directions.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{ type: 'directions.archived', outcome: 'success', subject: { type: 'direction', id } },
				tx
			);

			return toDirectionView(row);
		})
	);
}

/**
 * Возврат из архива — той же записью, а не вторым направлением: иначе разрез
 * отчёта разъехался бы надвое. Событие журнала то же, что у правки, с одним
 * изменённым полем — по нему и отвечают на вопрос «когда вернули».
 */
export async function restoreDirection(ctx: ActorContext, id: string): Promise<DirectionView> {
	await requirePermission(ctx, 'directions.write', {
		type: 'directions.updated',
		subject: { type: 'direction', id }
	});

	const before = await getDirectionRow(ctx, id);

	if (before.isActive) {
		throw new ConflictError('Направление и так не в архиве');
	}

	return written(
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(directions)
				.set({ isActive: true, updatedAt: sql`now()` })
				.where(eq(directions.id, id))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'directions.updated',
					outcome: 'success',
					subject: { type: 'direction', id },
					details: { changedFields: ['isActive'] }
				},
				tx
			);

			return toDirectionView(row);
		})
	);
}

/**
 * Продукт отнесён к направлению.
 *
 * Право своё — `directions.write`: состав направления это его собственная
 * картина, и ведёт её тот же, кто ведёт сам справочник направлений. Повторная
 * связь — конфликт, а не молчаливый успех; гонку двух вкладок ловит первичный
 * ключ пары, а не проверка перед вставкой.
 */
export async function linkProductDirection(
	ctx: ActorContext,
	input: LinkProductDirectionInput
): Promise<void> {
	await requirePermission(ctx, 'directions.write', {
		type: 'directions.updated',
		subject: { type: 'direction', id: input.directionId }
	});

	const direction = await getDirectionRow(ctx, input.directionId);

	if (!direction.isActive) {
		throw new ConflictError('Направление в архиве: продукты к нему больше не относят');
	}

	await assertProductExists(getDb(), input.productId);

	await written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				await tx.insert(productDirections).values(input);

				await recordAuditEvent(
					ctx,
					{
						type: 'directions.updated',
						outcome: 'success',
						subject: { type: 'direction', id: input.directionId },
						details: { productId: input.productId, changedFields: ['products'] }
					},
					tx
				);
			})
		)
	);
}

/** Связь снята: продукт к направлению больше не относится. */
export async function unlinkProductDirection(
	ctx: ActorContext,
	input: LinkProductDirectionInput
): Promise<void> {
	await requirePermission(ctx, 'directions.write', {
		type: 'directions.updated',
		subject: { type: 'direction', id: input.directionId }
	});

	await getDirectionRow(ctx, input.directionId);

	await written(
		withTransaction(ctx, async (tx) => {
			const removed = await tx
				.delete(productDirections)
				.where(
					and(
						eq(productDirections.directionId, input.directionId),
						eq(productDirections.productId, input.productId)
					)
				)
				.returning({ productId: productDirections.productId });

			if (removed.length === 0) {
				throw new NotFoundError('Продукт не отнесён к этому направлению');
			}

			await recordAuditEvent(
				ctx,
				{
					type: 'directions.updated',
					outcome: 'success',
					subject: { type: 'direction', id: input.directionId },
					details: { productId: input.productId, changedFields: ['products'] }
				},
				tx
			);
		})
	);
}

/**
 * Правообладатель продукта обязан существовать — и это всё, что о нём нужно
 * знать при записи.
 *
 * Проверка идёт **без области доступа**, в отличие от чтения карточки
 * организации. Продукты и программы — общий справочник оператора, область к ним
 * не применяется (`docs/directory.md`), а вендор в нём — это ссылка, а не
 * предмет работы: ответственного вендору не назначают никогда, поэтому в чью-то
 * область он не попадает вовсе. Со scopeFilter руководитель не смог бы записать
 * ни одного продукта с правообладателем — ни формой, ни импортом каталога.
 */
async function assertVendorExists(executor: Executor, id: string): Promise<void> {
	const [row] = await executor
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);

	if (row === undefined) {
		throw new ValidationError('Правообладатель не найден', [
			'Организация-правообладатель не заведена в справочнике'
		]);
	}
}

/**
 * Продукт, к которому привязывают направление, обязан существовать. Как и у
 * правообладателя, без области доступа: каталог продуктов общий.
 */
async function assertProductExists(executor: Executor, id: string): Promise<void> {
	const [row] = await executor
		.select({ id: products.id })
		.from(products)
		.where(eq(products.id, id))
		.limit(1);

	if (row === undefined) {
		throw new ValidationError('Продукт не найден', ['Продукт не заведён в справочнике']);
	}
}

function toProductView(row: typeof products.$inferSelect): ProductView {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		vendorOrganizationId: row.vendorOrganizationId,
		description: row.description,
		status: row.status
	};
}

/**
 * Заведение продукта. `tx` передаёт тот, кто уже открыл транзакцию и отвечает
 * за операцию целиком: импорт каталога заводит организацию-вендора и её продукт
 * одной строкой файла — либо обе записи, либо ни одной. Проверка вендора идёт
 * тем же исполнителем, иначе только что заведённой организации она не увидит.
 */
export async function createProduct(
	ctx: ActorContext,
	input: CreateProductInput,
	tx?: Tx
): Promise<ProductView> {
	await requirePermission(ctx, 'products.write', { type: 'products.created' });

	const write = async (executor: Tx): Promise<ProductView> => {
		if (input.vendorOrganizationId !== null) {
			await assertVendorExists(executor, input.vendorOrganizationId);
		}

		const [row] = await executor.insert(products).values(input).returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'products.created',
				outcome: 'success',
				subject: { type: 'product', id: row.id }
			},
			executor
		);

		return toProductView(row);
	};

	return written(
		withUniqueConflicts(() => (tx === undefined ? withTransaction(ctx, write) : write(tx)))
	);
}

export async function updateProduct(
	ctx: ActorContext,
	input: UpdateProductInput
): Promise<ProductView> {
	await requirePermission(ctx, 'products.write', {
		type: 'products.updated',
		subject: { type: 'product', id: input.id }
	});

	await assertPersonVisible(ctx, input.id);

	const { id, ...fields } = input;
	const db = getDb();

	const [before] = await db.select().from(products).where(eq(products.id, id)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Продукт не найден');
	}

	if (fields.vendorOrganizationId !== null) {
		await assertVendorExists(db, fields.vendorOrganizationId);
	}

	const archived = fields.status === 'archived' && before.status !== 'archived';

	return written(
		withUniqueConflicts(() =>
			withTransaction(ctx, async (tx) => {
				const [row] = await tx
					.update(products)
					.set({ ...fields, updatedAt: sql`now()` })
					.where(eq(products.id, id))
					.returning();

				await recordAuditEvent(
					ctx,
					{
						type: archived ? 'products.archived' : 'products.updated',
						outcome: 'success',
						subject: { type: 'product', id },
						details: { changedFields: changedFields(before, fields) }
					},
					tx
				);

				return toProductView(row);
			})
		)
	);
}
