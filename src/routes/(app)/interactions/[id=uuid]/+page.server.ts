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
import { formatDate } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { DocumentConversionError } from '$lib/server/documents/errors';
import { generateDocument } from '$lib/server/documents/generate';
import { listInteractionSupersessions } from '$lib/server/documents/read';
import { uploadDocument, uploadDocumentRevision } from '$lib/server/documents/upload';
import { toActionFailure, toPageError } from '$lib/server/http';
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
import { getInteractionStatus } from '$lib/server/stages/status';
import { responsibleOptions } from '../responsible';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const { id } = event.params;

	try {
		const [interaction, status, summary, closing, comments, changes, users, supersessions] =
			await Promise.all([
				getInteraction(ctx, id),
				getInteractionStatus(ctx, id),
				getInteractionSummary(ctx, id),
				getInteractionClosing(ctx, id),
				listComments(ctx, id),
				listInteractionChanges(ctx, id),
				responsibleOptions(event),
				// Панель документов по умолчанию показывает только действующие
				// редакции, и объяснить скрытые она может, лишь зная, чем их заменили.
				listInteractionSupersessions(ctx, id)
			]);

		return { interaction, status, summary, closing, comments, changes, users, supersessions };
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
			checklistState: {}
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => advanceStage(actorFromEvent(event), parsed.data));
	},

	return: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(returnStageSchema, { ...fields(data), interactionId: event.params.id });

		if (!parsed.ok) return parsed.failure;

		return run(() => returnStage(actorFromEvent(event), parsed.data));
	},

	skip: async (event) => {
		const data = await event.request.formData();
		const parsed = parse(skipStageSchema, { ...fields(data), interactionId: event.params.id });

		if (!parsed.ok) return parsed.failure;

		return run(() => skipStage(actorFromEvent(event), parsed.data));
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
			reason: data.get('reason')
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => cancelInteraction(actorFromEvent(event), parsed.data));
	},

	generate: async (event) => generateAgreement(event),

	update: async (event) => {
		const ctx = actorFromEvent(event);
		const data = await event.request.formData();
		const current = await getInteraction(ctx, event.params.id);

		// Стороны, программы и продукты правятся в своих местах карточки; форма
		// плана меняет название и сроки, поэтому остальное едет как есть.
		const parsed = parse(updateInteractionSchema, {
			id: current.id,
			routeId: current.routeId,
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
			productIds: current.products.map((product) => product.productId)
		});

		if (!parsed.ok) return parsed.failure;

		return run(() => updateInteraction(ctx, parsed.data));
	}
};

/**
 * Соглашение по шаблону. Тегов без значения в договоре не бывает, поэтому всё,
 * чего нет в карточке (город, подписанты), спрашивается формой, а не
 * подставляется пустой строкой.
 */
async function generateAgreement(event: RequestEvent) {
	const ctx = actorFromEvent(event);
	const data = await event.request.formData();
	const interaction = await getInteraction(ctx, event.params.id);

	const institution = interaction.parties.find(
		(party) => party.partyRole === 'educational_institution'
	);

	if (institution === undefined) {
		return fail(400, {
			message: 'Для соглашения нужен участник — учебное заведение',
			issues: [] as string[]
		});
	}

	const periodStart = interaction.agreementPeriodStart;
	const periodEnd = interaction.agreementPeriodEnd;

	if (periodStart === null || periodEnd === null) {
		return fail(400, {
			message: 'Укажите срок действия соглашения в плане взаимодействия',
			issues: [] as string[]
		});
	}

	const city = text(data, 'city');
	const operatorName = text(data, 'operatorName');
	const operatorSigner = text(data, 'operatorSigner');
	const institutionSigner = text(data, 'institutionSigner');
	const customerName = text(data, 'customerName');

	const missing = [
		['Город подписания', city],
		['Оператор', operatorName],
		['Подписант оператора', operatorSigner],
		['Подписант учебного заведения', institutionSigner],
		['Заказчик подготовки', customerName]
	]
		.filter(([, value]) => value === null)
		.map(([label]) => String(label));

	if (
		city === null ||
		operatorName === null ||
		operatorSigner === null ||
		institutionSigner === null ||
		customerName === null
	) {
		return fail(400, { message: 'Заполните все поля соглашения', issues: missing });
	}

	return run(() =>
		generateDocument(ctx, {
			templateKey: 'agreement',
			interactionId: interaction.id,
			title: `Соглашение — ${interaction.title}`,
			formats: ['docx', 'pdf'],
			data: {
				city,
				date: formatDate(new Date()),
				operatorName,
				operatorSigner,
				institutionName: institution.organizationName,
				institutionSigner,
				customerName,
				periodStart: formatDate(periodStart),
				periodEnd: formatDate(periodEnd),
				programs: interaction.programs.map((program) => ({ name: program.name }))
			}
		})
	);
}
