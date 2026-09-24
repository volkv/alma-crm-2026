import { fail } from '@sveltejs/kit';
import type { z } from 'zod';
import {
	advanceStageSchema,
	cancelInteractionSchema,
	completeInteractionSchema,
	confirmStageSchema,
	createCommentSchema,
	pauseStageSchema,
	raiseBlockerSchema,
	resolveBlockerSchema,
	resumeStageSchema,
	returnStageSchema,
	setChecklistItemSchema,
	setResponsibleSchema,
	setStageResultSchema,
	skipStageSchema,
	updateInteractionSchema
} from '$lib/contracts/interactions';
import {
	DOCUMENT_TEMPLATE_LABELS,
	generatePackageSchema,
	markDocumentStatusSchema,
	markMomentFromDay,
	STAGE_ATTACHMENT_DOCUMENT_KIND
} from '$lib/contracts/documents';
import { completeLearningGroupSchema, sendLearningGroupSchema } from '$lib/contracts/exchange';
import { NO_OPTION } from '$lib/components/directory/labels';
import { actorFromEvent } from '$lib/server/actor';
import { listOrganizationContracts } from '$lib/server/directory/contracts';
import { getOrganization, listAffiliations } from '$lib/server/directory/read';
import { DocumentConversionError } from '$lib/server/documents/errors';
import { generateDocumentPackage } from '$lib/server/documents/package';
import { listInteractionSupersessions } from '$lib/server/documents/read';
import { markDocument } from '$lib/server/documents/status';
import { uploadDocument, uploadDocumentRevision } from '$lib/server/documents/upload';
import { toActionFailure, toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import {
	markLearningGroupCompleted,
	readInteractionExchange,
	requestLearningGroup
} from '$lib/server/integrations/exchange/groups';
import {
	getInteraction,
	listComments,
	listInteractionChanges
} from '$lib/server/interactions/read';
import { getInteractionSummary } from '$lib/server/interactions/summary';
import { updateInteraction } from '$lib/server/interactions/write';
import {
	addComment,
	advanceStage,
	cancelInteraction,
	completeInteraction,
	confirmStage,
	getInteractionClosing,
	pauseStage,
	raiseBlocker,
	resolveBlocker,
	resumeStage,
	returnStage,
	setChecklistItem,
	setResponsible,
	setStageResult,
	skipStage
} from '$lib/server/stages/commands';
import { readInteractionCard } from '$lib/server/stages/card';
import { getInteractionStatus } from '$lib/server/stages/status';
import { responsibleOptions } from '../responsible';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const { id } = event.params;

	try {
		const [
			interaction,
			status,
			summary,
			closing,
			comments,
			changes,
			users,
			supersessions,
			exchange
		] = await Promise.all([
			getInteraction(ctx, id),
			getInteractionStatus(ctx, id),
			getInteractionSummary(ctx, id),
			getInteractionClosing(ctx, id),
			listComments(ctx, id),
			listInteractionChanges(ctx, id),
			responsibleOptions(event),
			// Панель документов по умолчанию показывает только действующие
			// редакции, и объяснить скрытые она может, лишь зная, чем их заменили.
			listInteractionSupersessions(ctx, id),
			// Обмен с системой обучения: заведённые потоки и приговор по кнопке
			// «Отправить в LMS».
			readInteractionExchange(ctx, id)
		]);

		// Договоры основной стороны: из них выбирают договор записи. Читаются
		// только тому, кто может править, — остальным список не нужен, а
		// карточка и без него называет договор, по которому идёт работа.
		// Сама основная сторона из справочника — вид контрагента, полное имя и
		// реквизиты для панели контекста; без права на справочник карточка
		// называет её так, как она записана в стороне взаимодействия.
		// Состав карточки — панели и шаблоны — объявляет процесс записи, а вид
		// шапки задаёт вид основной стороны.
		const primary = interaction.parties.find((party) => party.isPrimary);
		// Контакты стороны — для диалога приглашения на встречу (участники с
		// почтой, галочками): та же область доступа, что у справочника людей, а не
		// у карточки взаимодействия саму по себе. Без права список пуст, и диалог
		// говорит почему, а не молчит.
		const meetingContactsDenied = primary !== undefined && !can(ctx, 'people.read');
		const [contracts, counterparty, card, meetingContacts] = await Promise.all([
			primary !== undefined && can(ctx, 'interactions.write')
				? listOrganizationContracts(ctx, primary.organizationId)
				: [],
			primary !== undefined && can(ctx, 'organizations.read')
				? getOrganization(ctx, primary.organizationId)
				: null,
			readInteractionCard(interaction),
			primary !== undefined && can(ctx, 'people.read')
				? listAffiliations(ctx, primary.organizationId)
				: []
		]);

		return {
			interaction,
			status,
			summary,
			closing,
			comments,
			changes,
			users,
			supersessions,
			exchange,
			contracts,
			counterparty,
			card,
			meetingContacts,
			meetingContactsDenied
		};
	} catch (cause) {
		toPageError(cause);
	}
};

/** Поля формы в объекте, пригодном для схемы контракта. */
function fields(data: FormData): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const key of new Set(data.keys())) {
		const values = data.getAll(key);
		result[key] = values.length === 1 ? values[0] : values;
	}

	return result;
}

/**
 * Разбор тела формы по схеме контракта. Претензии показываются рядом с
 * действием, а не превращаются в отказ без объяснения.
 */
function parse<TSchema extends z.ZodType>(schema: TSchema, input: unknown) {
	const parsed = schema.safeParse(input);

	if (!parsed.success) {
		return {
			ok: false as const,
			failure: fail(400, {
				message: 'Данные действия не прошли проверку',
				issues: parsed.error.issues.map((issue) => issue.message)
			})
		};
	}

	return { ok: true as const, data: parsed.data };
}

/**
 * Файлы, приложенные к переходу, — сначала документами взаимодействия, потом
 * связью с записью стадии. Загрузка идёт до команды: файл, который хранилище не
 * приняло, не должен стоить человеку перехода, уже записанного в историю.
 *
 * Отдельная функция, а не часть команды: граница хранилища живёт в модуле
 * документов, и движку стадий незачем знать про S3.
 */
async function attach(
	event: RequestEvent,
	data: FormData
): Promise<{ ok: true; documentIds: string[] } | { ok: false; failure: ReturnType<typeof fail> }> {
	const files = data.getAll('files').filter((item): item is File => item instanceof File);
	const chosen = files.filter((file) => file.size > 0);

	if (chosen.length === 0) {
		return { ok: true, documentIds: [] };
	}

	const ctx = actorFromEvent(event);
	const documentIds: string[] = [];

	try {
		for (const file of chosen) {
			const uploaded = await uploadDocument(ctx, {
				interactionId: event.params.id,
				kind: STAGE_ATTACHMENT_DOCUMENT_KIND,
				title: file.name,
				file: { mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
			});

			documentIds.push(uploaded.id);
		}
	} catch (cause) {
		return { ok: false, failure: toActionFailure(cause) };
	}

	return { ok: true, documentIds };
}

/** Общая обёртка действия: предметная ошибка становится отказом формы. */
async function run(action: () => Promise<unknown>) {
	try {
		await action();

		return { ok: true };
	} catch (cause) {
		// Отказ внешней службы преобразования — не ошибка предметной области и не
		// наш сбой: человеку нужно сказать, что документ не собрался, и почему.
		if (cause instanceof DocumentConversionError) {
			return fail(502, { message: cause.message, issues: [] as string[] });
		}

		return toActionFailure(cause);
	}
}

/** Значение поля формы как строка или `null` для пустого. */
function text(data: FormData, key: string): string | null {
	const value = data.get(key);

	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export const actions: Actions = {
	advance: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(advanceStageSchema, {
			...fields(data),
			interactionId: event.params.id,
			// Скрытое поле приезжает строкой: номер редакции — число, и приводит
			// его транспорт, а не схема, — иначе схема начала бы принимать строки
			// и от API тоже.
			revision: Number(data.get('revision')),
			checklistState: {}
		});

		if (!parsed.ok) return parsed.failure;

		const attached = await attach(event, data);

		if (!attached.ok) return attached.failure;

		return run(() =>
			advanceStage(actorFromEvent(event), { ...parsed.data, documentIds: attached.documentIds })
		);
	},

	return: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(returnStageSchema, {
			...fields(data),
			interactionId: event.params.id,
			revision: Number(data.get('revision'))
		});

		if (!parsed.ok) return parsed.failure;

		const attached = await attach(event, data);

		if (!attached.ok) return attached.failure;

		return run(() =>
			returnStage(actorFromEvent(event), { ...parsed.data, documentIds: attached.documentIds })
		);
	},

	skip: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(skipStageSchema, {
			...fields(data),
			interactionId: event.params.id,
			revision: Number(data.get('revision'))
		});

		if (!parsed.ok) return parsed.failure;

		const attached = await attach(event, data);

		if (!attached.ok) return attached.failure;

		return run(() =>
			skipStage(actorFromEvent(event), { ...parsed.data, documentIds: attached.documentIds })
		);
	},

	pause: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(pauseStageSchema, { ...fields(data), interactionId: event.params.id });

		if (!parsed.ok) return parsed.failure;

		return run(() => pauseStage(actorFromEvent(event), parsed.data));
	},

	resume: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(resumeStageSchema, { ...fields(data), interactionId: event.params.id });

		if (!parsed.ok) return parsed.failure;

		return run(() => resumeStage(actorFromEvent(event), parsed.data));
	},

	checklist: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(setChecklistItemSchema, {
			interactionId: event.params.id,
			key: data.get('key'),
			done: data.get('done') === 'true'
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => setChecklistItem(actorFromEvent(event), parsed.data));
	},

	result: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(setStageResultSchema, {
			interactionId: event.params.id,
			resultText: data.get('resultText')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => setStageResult(actorFromEvent(event), parsed.data));
	},

	confirm: async (event) => {
		const data = await event.request.formData();
		const kind = data.get('kind');

		const confirmation =
			kind === 'file'
				? { kind: 'file', documentId: data.get('documentId') }
				: kind === 'lms_record'
					? { kind: 'lms_record', source: data.get('source'), recordId: data.get('recordId') }
					: { kind: 'mark' };

		const parsed = parse(confirmStageSchema, {
			interactionId: event.params.id,
			fromStageId: data.get('fromStageId'),
			confirmation
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => confirmStage(actorFromEvent(event), parsed.data));
	},

	raiseBlocker: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(raiseBlockerSchema, {
			interactionId: event.params.id,
			reasonCode: data.get('reasonCode'),
			description: data.get('description'),
			blocksTransition: data.get('blocksTransition') === 'true',
			assigneeUserId: text(data, 'assigneeUserId')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => raiseBlocker(actorFromEvent(event), parsed.data));
	},

	resolveBlocker: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(resolveBlockerSchema, fields(data));

		if (!parsed.ok) return parsed.failure;

		return run(() => resolveBlocker(actorFromEvent(event), parsed.data));
	},

	comment: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(createCommentSchema, {
			interactionId: event.params.id,
			body: data.get('body')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => addComment(actorFromEvent(event), parsed.data));
	},

	assign: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(setResponsibleSchema, {
			interactionIds: [event.params.id],
			userId: data.get('userId')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => setResponsible(actorFromEvent(event), parsed.data));
	},

	upload: async (event) => {
		const data = await event.request.formData();
		const file = data.get('file');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Выберите файл документа', issues: [] as string[] });
		}

		const title = text(data, 'title') ?? file.name;
		const kind = text(data, 'kind') ?? 'other';
		const bytes = new Uint8Array(await file.arrayBuffer());

		return run(() =>
			uploadDocument(actorFromEvent(event), {
				interactionId: event.params.id,
				kind,
				title,
				file: { mime: file.type, bytes }
			})
		);
	},

	/**
	 * Отметка по приложенному документу: согласован, утверждён, введён в
	 * действие. День приходит из календаря диалога, момент по нему считает
	 * контракт; область доступа и однократность проверяет сервис.
	 */
	markDocument: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(markDocumentStatusSchema, {
			documentId: data.get('documentId'),
			fact: data.get('fact'),
			at: text(data, 'at'),
			note: text(data, 'note')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() =>
			markDocument(
				actorFromEvent(event),
				parsed.data.documentId,
				parsed.data.fact,
				parsed.data.at === null ? undefined : markMomentFromDay(parsed.data.at),
				parsed.data.note
			)
		);
	},

	/**
	 * Новая редакция приложенного файла. Название, вид и само дело сервис берёт
	 * у заменяемой редакции — форма спрашивает только файл.
	 */
	uploadRevision: async (event) => {
		const data = await event.request.formData();
		const file = data.get('file');
		const supersedesId = text(data, 'supersedesId');

		if (supersedesId === null) {
			return fail(400, { message: 'Не указано, какую редакцию заменяем', issues: [] as string[] });
		}

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Выберите файл новой редакции', issues: [] as string[] });
		}

		const bytes = new Uint8Array(await file.arrayBuffer());

		return run(() =>
			uploadDocumentRevision(actorFromEvent(event), {
				supersedesId,
				file: { mime: file.type, bytes }
			})
		);
	},

	complete: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(completeInteractionSchema, {
			interactionId: event.params.id,
			revision: Number(data.get('revision')),
			summary: text(data, 'summary'),
			force: data.get('force') === 'true'
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => completeInteraction(actorFromEvent(event), parsed.data));
	},

	cancel: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(cancelInteractionSchema, {
			interactionId: event.params.id,
			revision: Number(data.get('revision')),
			reason: data.get('reason')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => cancelInteraction(actorFromEvent(event), parsed.data));
	},

	/**
	 * Заявка на учебную группу уходит действием сотрудника, а не переходом по
	 * стадии: число мест и даты подтверждает человек, и ошибочный переход не
	 * должен превращаться в группу в чужой системе.
	 */
	sendGroup: async (event) => {
		const data = await event.request.formData();
		// Пустое поле даты — это «дата не названа», а не «дата пустая»: поля
		// собираются поимённо, потому что схема различает `null` и строку.
		const parsed = parse(sendLearningGroupSchema, {
			interactionId: event.params.id,
			streamNumber: data.get('streamNumber'),
			plannedSeats: data.get('plannedSeats'),
			startsOn: text(data, 'startsOn'),
			endsOn: text(data, 'endsOn'),
			// Пустой выбор программы — это «не выбрано», а не пустой
			// идентификатор: подставить единственную или отказать решает сервис.
			programId: text(data, 'programId'),
			productIds: data
				.getAll('productIds')
				.filter((value): value is string => typeof value === 'string' && value !== ''),
			purpose: text(data, 'purpose')
		});

		if (!parsed.ok) {
			return parsed.failure;
		}

		try {
			const outcome = await requestLearningGroup(actorFromEvent(event), parsed.data);

			return outcome.delivered
				? { ok: true }
				: fail(502, {
						message:
							outcome.error ?? 'Система обучения не ответила: заявка осталась в очереди повторов',
						issues: [] as string[]
					});
		} catch (cause) {
			return toActionFailure(cause);
		}
	},

	/**
	 * Отметка «обучение завершено» по группе: итога из системы обучения нет, а
	 * обучение закончилось. Комментарий обязателен — это объяснение, почему
	 * данных нет, а стадия закрыта.
	 */
	completeGroup: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(completeLearningGroupSchema, {
			interactionId: event.params.id,
			learningGroupId: data.get('learningGroupId'),
			comment: data.get('comment')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => markLearningGroupCompleted(actorFromEvent(event), parsed.data));
	},

	/**
	 * Пакет документов дела: выбранные шаблоны процесса, подходящие виду
	 * контрагента. Отказ отдельного документа — его исход, а не отказ
	 * действия: собранное остаётся, форма показывает, что заполнить. Отказ
	 * всего пакета — только когда не собралось ничего.
	 */
	package: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(generatePackageSchema, {
			templates: data.getAll('templates'),
			city: data.get('city') ?? '',
			operatorSigner: data.get('operatorSigner') ?? '',
			counterpartySigner: text(data, 'counterpartySigner')
		});

		if (!parsed.ok) return parsed.failure;

		try {
			const outcomes = await generateDocumentPackage(
				actorFromEvent(event),
				event.params.id,
				parsed.data
			);

			if (outcomes.every((outcome) => outcome.status === 'refused')) {
				return fail(400, {
					message: 'Ни один документ пакета не собран',
					issues: outcomes.flatMap((outcome) =>
						outcome.status === 'refused'
							? outcome.issues.map(
									(issue) => `${DOCUMENT_TEMPLATE_LABELS[outcome.templateKey]}: ${issue}`
								)
							: []
					)
				});
			}

			return { ok: true, outcomes };
		} catch (cause) {
			if (cause instanceof DocumentConversionError) {
				return fail(502, { message: cause.message, issues: [] as string[] });
			}

			return toActionFailure(cause);
		}
	},

	update: async (event) => {
		const ctx = actorFromEvent(event);
		const data = await event.request.formData();
		const current = await getInteraction(ctx, event.params.id);

		// Стороны, программы и продукты правятся в своих местах карточки; форма
		// плана меняет название и сроки, поэтому остальное едет как есть.
		const parsed = parse(updateInteractionSchema, {
			id: current.id,
			title: data.get('title'),
			agreementPeriodStart: text(data, 'agreementPeriodStart'),
			agreementPeriodEnd: text(data, 'agreementPeriodEnd'),
			academicPeriodStart: text(data, 'academicPeriodStart'),
			academicPeriodEnd: text(data, 'academicPeriodEnd'),
			ownerUserId: current.ownerUserId,
			reason: text(data, 'reason'),
			externalSource: current.externalSource,
			externalId: current.externalId,
			parties: current.parties.map((party) => ({
				organizationId: party.organizationId,
				partyRole: party.partyRole,
				isPrimary: party.isPrimary,
				contactAffiliationId: party.contactAffiliationId,
				siteIds: party.sites.map((site) => site.id)
			})),
			programs: current.programs.map((program) => ({
				programId: program.programId,
				programVersionId: program.programVersionId
			})),
			productIds: current.products.map((product) => product.productId),
			contractId: current.contract?.id ?? null,
			contractItemIds: current.contract?.items.map((item) => item.id) ?? []
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => updateInteraction(ctx, parsed.data));
	},

	/**
	 * Договор записи и выбранные из него позиции.
	 *
	 * Своё действие, а не поле формы плана: договор принадлежит контрагенту, и
	 * сменить его — это сказать, что работа идёт по другому обязательству.
	 * Остальной план едет как есть, ровно как стороны и продукты в правке плана.
	 */
	contract: async (event) => {
		const ctx = actorFromEvent(event);
		const data = await event.request.formData();
		const current = await getInteraction(ctx, event.params.id);
		const chosen = text(data, 'contractId');
		// «Без договора» список выбирает своим значением: пустое значение
		// всплывающий список не хранит, и отличить «не выбрано» от «не прислано»
		// по пустой строке было бы нельзя.
		const contractId = chosen === null || chosen === NO_OPTION ? null : chosen;

		const parsed = parse(updateInteractionSchema, {
			id: current.id,
			title: current.title,
			agreementPeriodStart: current.agreementPeriodStart,
			agreementPeriodEnd: current.agreementPeriodEnd,
			academicPeriodStart: current.academicPeriodStart,
			academicPeriodEnd: current.academicPeriodEnd,
			ownerUserId: current.ownerUserId,
			reason: text(data, 'reason'),
			externalSource: current.externalSource,
			externalId: current.externalId,
			parties: current.parties.map((party) => ({
				organizationId: party.organizationId,
				partyRole: party.partyRole,
				isPrimary: party.isPrimary,
				contactAffiliationId: party.contactAffiliationId,
				siteIds: party.sites.map((site) => site.id)
			})),
			programs: current.programs.map((program) => ({
				programId: program.programId,
				programVersionId: program.programVersionId
			})),
			productIds: current.products.map((product) => product.productId),
			contractId,
			contractItemIds: contractId === null ? [] : data.getAll('contractItemIds')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => updateInteraction(ctx, parsed.data));
	}
};
