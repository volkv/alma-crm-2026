/**
 * Смена контактного лица стороны из карточки взаимодействия.
 *
 * Контакт выбирают при заведении, но на стадии поиска контактных лиц его и
 * находят: человек, с которым говорили вначале, уходит, на его место
 * приходит другой. Правка плана переписывает стороны целиком по форме плана,
 * а здесь меняется одно поле одной стороны — поэтому команда своя.
 *
 * Правило то же, что у правки плана: право на запись взаимодействия, область
 * доступа (чужая запись — «не найдено»), версия правки под блокировкой строки,
 * строка предметной истории с причиной и событие журнала. Новый контакт —
 * действующая роль организации этой стороны: роль другой организации или
 * закончившаяся роль — отказ, а не тихая запись.
 *
 * Нужного человека в справочнике нет — его заводят тут же
 * (`createInteractionContact`): тем же созданием контакта, что у карточки
 * вуза, и той же записью смены контакта, одной транзакцией.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
	createInteractionContactSchema,
	isAffiliationCurrent,
	type CreateInteractionContactDraft
} from '$lib/contracts/directory';
import {
	changeInteractionContactSchema,
	type ChangeInteractionContactDraft
} from '$lib/contracts/interactions';
import type { SiteSourceView } from '$lib/contracts/organization-card';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { invalidateDirectoryOptions } from '../cache/directory';
import { getDb } from '../db';
import { affiliations, interactionChanges, interactionParties, interactions } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { currentAffiliationFilter } from '../directory/affiliation-current';
import {
	createOrganizationContact,
	listSiteContactCandidates,
	siteContactDraft,
	type OrganizationContactDraft,
	type SiteContactCandidate
} from '../directory/organization-card';
import { setAffiliationChannel } from '../directory/write';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { publishAfterCommit } from '../live/publish';
import { can, requirePermission } from '../rbac';
import { interactionScopeFilter } from './access';
import { assertEditVersion, editorOf, nextEdit } from './edit-version';

/** Момент, который ставит база: часы приложения и базы могут расходиться. */
const now = sql`now()`;

type PartyRef = { interactionId: string; partyId: string };

type VersionedPartyRef = PartyRef & { editVersion: number };

type LockedParty = {
	interaction: typeof interactions.$inferSelect;
	party: { id: string; organizationId: string; contactAffiliationId: string | null };
};

/**
 * Запись под блокировкой строки и её сторона: область доступа (чужая запись —
 * «не найдено») и версия правки проверяются здесь.
 */
async function lockParty(ctx: ActorContext, tx: Tx, ref: VersionedPartyRef): Promise<LockedParty> {
	const [interaction] = await tx
		.select()
		.from(interactions)
		.where(and(eq(interactions.id, ref.interactionId), interactionScopeFilter(ctx)))
		.for('update');

	if (interaction === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	await assertEditVersion(tx, interaction, ref.editVersion);

	const [party] = await tx
		.select({
			id: interactionParties.id,
			organizationId: interactionParties.organizationId,
			contactAffiliationId: interactionParties.contactAffiliationId
		})
		.from(interactionParties)
		.where(
			and(
				eq(interactionParties.id, ref.partyId),
				eq(interactionParties.interactionId, ref.interactionId)
			)
		)
		.limit(1);

	if (party === undefined) {
		throw new NotFoundError('Сторона взаимодействия не найдена');
	}

	return { interaction, party };
}

/**
 * Контакт стороны сменился: сторона, версия записи, строка истории с
 * причиной, событие журнала и сигнал живой карточке.
 */
async function writeContact(
	ctx: ActorContext,
	tx: Tx,
	{ interaction, party }: LockedParty,
	contactAffiliationId: string | null,
	reason: string | null
): Promise<void> {
	const authorId = ctx.user?.id ?? null;

	await tx
		.update(interactionParties)
		.set({ contactAffiliationId, updatedAt: now })
		.where(eq(interactionParties.id, party.id));

	await tx
		.update(interactions)
		.set({
			...nextEdit(interactions.editVersion, editorOf(ctx)),
			lastActivityAt: now,
			updatedAt: now
		})
		.where(eq(interactions.id, interaction.id));

	// Автор истории — человек, как у правки плана: правка без него остаётся
	// только в журнале действий.
	if (authorId !== null) {
		await tx.insert(interactionChanges).values({
			interactionId: interaction.id,
			authorId,
			field: 'contact',
			oldValue: party.contactAffiliationId,
			newValue: contactAffiliationId,
			reason
		});
	}

	await recordAuditEvent(
		ctx,
		{
			type: 'interactions.contact_changed',
			outcome: 'success',
			subject: { type: 'interaction', id: interaction.id },
			// Снятый контакт — событие без `affiliationId`: пустых ссылок
			// журнал не принимает.
			details:
				contactAffiliationId === null
					? { partyId: party.id }
					: { partyId: party.id, affiliationId: contactAffiliationId }
		},
		tx
	);

	publishAfterCommit(tx, interaction.id, { type: 'interaction.changed' });
}

export async function changeInteractionContact(
	ctx: ActorContext,
	input: ChangeInteractionContactDraft
): Promise<void> {
	// То же право, что даёт карточке действие «изменить».
	requirePermission(ctx, 'interactions.write');

	const parsed = changeInteractionContactSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Контактное лицо не прошло проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const command = parsed.data;

	await withTransaction(ctx, async (tx) => {
		const locked = await lockParty(ctx, tx, command);

		if (command.contactAffiliationId !== null) {
			// Действующая — без даты окончания или с ещё не прошедшей: так же «текущие» и «прежние»
			// роли делит карточка организации.
			const [affiliation] = await tx
				.select({ id: affiliations.id })
				.from(affiliations)
				.where(
					and(
						eq(affiliations.id, command.contactAffiliationId),
						eq(affiliations.organizationId, locked.party.organizationId),
						currentAffiliationFilter()
					)
				)
				.limit(1);

			if (affiliation === undefined) {
				throw new ValidationError('Контактное лицо не относится к этой организации', [
					'Выберите человека из действующих ролей организации'
				]);
			}
		}

		// «Как связываться» пишется в роль человека — тем же сервисом, что у
		// карточки организации, с его правом на людей и журналом. Роль — та,
		// что станет контактом: канал без человека приписать некому.
		if (command.channel !== null) {
			if (command.contactAffiliationId === null) {
				throw new ValidationError('Канал связи указывают у контактного лица', [
					'Выберите контактное лицо или оставьте «Как связываться» пустым'
				]);
			}

			await setAffiliationChannel(
				ctx,
				{ affiliationId: command.contactAffiliationId, channel: command.channel },
				tx
			);
			publishAfterCommit(tx, locked.interaction.id, { type: 'interaction.changed' });
		}

		// Тот же контакт — не правка записи: версия не сдвигается, и коллега с
		// открытой формой плана не получит отказа из-за пустого действия.
		if (locked.party.contactAffiliationId === command.contactAffiliationId) {
			return;
		}

		await writeContact(ctx, tx, locked, command.contactAffiliationId, command.reason);
	});
}

/**
 * Организация стороны — до транзакции: кандидата из паспорта читают по ней,
 * а чтение паспорта под блокировкой записи держало бы её дольше нужного.
 * Чужая запись — «не найдено», как и у самой смены.
 */
async function partyOrganizationId(ctx: ActorContext, ref: PartyRef): Promise<string> {
	const [row] = await getDb()
		.select({ organizationId: interactionParties.organizationId })
		.from(interactionParties)
		.innerJoin(interactions, eq(interactions.id, interactionParties.interactionId))
		.where(
			and(
				eq(interactionParties.id, ref.partyId),
				eq(interactionParties.interactionId, ref.interactionId),
				interactionScopeFilter(ctx)
			)
		)
		.limit(1);

	if (row === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	return row.organizationId;
}

/**
 * Новый человек организации стороны — сразу её контактным лицом.
 *
 * Человек и роль заводятся тем же `createOrganizationContact`, что у карточки
 * вуза: права `people.write`, шифрование контактов и журнал — его. Смена
 * контакта пишется так же, как выбор из списка, — в той же транзакции: либо
 * есть и человек, и контакт стороны, либо нет ничего.
 */
export async function createInteractionContact(
	ctx: ActorContext,
	input: CreateInteractionContactDraft,
	/** «Как связываться» у новой роли; `null` — не договаривались. */
	channel: string | null
): Promise<{ affiliationId: string }> {
	requirePermission(ctx, 'interactions.write');
	requirePermission(ctx, 'people.write');

	const parsed = createInteractionContactSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Контакт не прошёл проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const command = parsed.data;
	const organizationId = await partyOrganizationId(ctx, command);

	let draft: OrganizationContactDraft;

	if (command.source.kind === 'site') {
		const fromSite = await siteContactDraft(ctx, organizationId, command.source.candidate);

		draft = { ...fromSite, role: { ...fromSite.role, channel } };
	} else {
		const { position, roleKind, validFrom, validTo, ...person } = command.source.contact;

		draft = {
			person: { ...person, notes: null },
			role: {
				siteId: null,
				position,
				roleKind,
				isPrimary: false,
				validFrom,
				validTo,
				channel
			}
		};
	}

	// Контакт стороны — действующая роль: с прошедшим сроком полномочий человек
	// лёг бы в справочник, а контактом стать не смог.
	if (!isAffiliationCurrent(draft.role, formatIsoDay())) {
		throw new ValidationError('Срок полномочий уже закончился', [
			'Контактным лицом становится человек с действующей ролью: проверьте дату окончания'
		]);
	}

	const affiliationId = await withTransaction(ctx, async (tx) => {
		const locked = await lockParty(ctx, tx, command);

		if (locked.party.organizationId !== organizationId) {
			throw new ConflictError('Организация стороны изменилась: откройте карточку заново');
		}

		const added = await createOrganizationContact(ctx, organizationId, draft, tx);

		await writeContact(ctx, tx, locked, added.affiliation.id, command.reason);

		return added.affiliation.id;
	});

	// Новый человек должен появиться в выпадающих списках сразу после фиксации.
	await invalidateDirectoryOptions();

	return { affiliationId };
}

/** Что диалог контакта предлагает завести на месте. */
export type NewContactOptions = {
	/** Право заводить людей: без него кнопки создания нет. */
	canCreate: boolean;
	/** Кандидаты с сайта организации стороны, которых ещё нет в её контактах. */
	candidates: SiteContactCandidate[];
	/**
	 * Прочитан ли сайт: пока читается, диалог спросит ещё раз; `null` — блока
	 * «с сайта» нет (не вуз или нет права заводить людей).
	 */
	source: SiteSourceView | null;
	/** Сколько людей на сайте всего — вместе с уже заведёнными. */
	total: number;
};

export async function newContactOptions(
	ctx: ActorContext,
	ref: PartyRef
): Promise<NewContactOptions> {
	requirePermission(ctx, 'interactions.write');

	if (!can(ctx, 'people.write')) {
		return { canCreate: false, candidates: [], source: null, total: 0 };
	}

	const organizationId = await partyOrganizationId(ctx, ref);

	return { canCreate: true, ...(await listSiteContactCandidates(ctx, organizationId)) };
}
