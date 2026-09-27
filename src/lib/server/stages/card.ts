/**
 * Состав карточки взаимодействия, который объявляет процесс: панели и шаблоны
 * документов.
 *
 * Хранится на процессе, а не на редакции: это вид рабочего места, а не
 * структура работы. Стадий он не касается, переносить по нему нечего, поэтому
 * правка применяется сразу — без черновика и публикации, — и движок стадий о
 * нём не знает.
 */
import { eq } from 'drizzle-orm';
import type { OrganizationKind } from '$lib/contracts/directory';
import { DOCUMENT_TEMPLATE_LABELS, type DocumentTemplateKey } from '$lib/contracts/documents';
import type { InteractionView } from '$lib/contracts/interactions';
import { processCardSchema, type ProcessCard } from '$lib/contracts/process-card';
import { moduleByKey, templateOwner } from '$lib/platform/registry';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { interactions, organizations, workflows, workspaces } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { readActiveModules } from '../platform/workspace-modules';
import { requirePermission } from '../rbac';
import { readWorkflowByKey, type Executor } from './process';

/** Колонки процесса, из которых собирается состав карточки. */
const cardColumns = {
	panels: workflows.cardPanels,
	templates: workflows.documentTemplateKeys
};

/** Состав карточки процесса по его ключу — для редактора процесса. */
export async function getProcessCard(ctx: ActorContext, workflowKey: string): Promise<ProcessCard> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.process_viewed' });

	const [row] = await getDb()
		.select(cardColumns)
		.from(workflows)
		.where(eq(workflows.key, workflowKey));

	if (row === undefined) {
		throw new NotFoundError('Процесс не найден');
	}

	return row;
}

/**
 * Всё, что карточка взаимодействия берёт у процесса и у контрагента: панели,
 * шаблоны и вид основной стороны.
 *
 * Принимает уже прочитанное взаимодействие, а не идентификатор: право его
 * видеть проверило чтение, и повторять область доступа здесь незачем. Вид
 * контрагента читается отсюда же, а не из справочника: реквизиты стороны
 * закрыты правом на справочник, а какую карточку рисовать, решается и без него.
 */
export async function readInteractionCard(
	interaction: InteractionView
): Promise<ProcessCard & { counterpartyKind: OrganizationKind }> {
	const db = getDb();
	const primary = interaction.parties.find((party) => party.isPrimary);

	// Ровно одну основную сторону держит схема создания и правки; запись без
	// неё — поломка данных, а не вид карточки.
	if (primary === undefined) {
		throw new ConflictError('У взаимодействия нет основной стороны');
	}

	const [[card], [counterparty]] = await Promise.all([
		db
			.select(cardColumns)
			.from(workspaces)
			.innerJoin(workflows, eq(workflows.id, workspaces.workflowId))
			.where(eq(workspaces.id, interaction.workspaceId)),
		db
			.select({ kind: organizations.kind })
			.from(organizations)
			.where(eq(organizations.id, primary.organizationId))
	]);

	// Сменить процесс пространству, где есть взаимодействия, нельзя
	// (`assignWorkspaceWorkflow`), поэтому у записи он есть всегда.
	if (card === undefined) {
		throw new ConflictError(
			`Пространству «${interaction.workspaceName}» не назначен процесс: карточку не из чего собрать`
		);
	}

	if (counterparty === undefined) {
		throw new NotFoundError('Основная сторона взаимодействия не найдена в справочнике');
	}

	return { ...card, counterpartyKind: counterparty.kind };
}

/**
 * Шаблон доступен в карточке, только если его объявил процесс записи и, когда
 * шаблон принадлежит модулю, этот модуль действует в пространстве записи.
 * Проверка на сервере, а не только скрытой кнопкой: форму можно отправить и без
 * неё.
 *
 * Модуль, нужный стадии действующей редакции, действует всегда: стадию,
 * которую подтверждает отметка на акте передачи, этот отказ не остановит.
 */
export async function assertTemplateOffered(
	executor: Executor,
	interactionId: string,
	templateKey: DocumentTemplateKey
): Promise<void> {
	const [row] = await executor
		.select({
			templates: workflows.documentTemplateKeys,
			workflowName: workflows.name,
			workspaceId: workspaces.id,
			workspaceName: workspaces.name
		})
		.from(interactions)
		.innerJoin(workspaces, eq(workspaces.id, interactions.workspaceId))
		.innerJoin(workflows, eq(workflows.id, workspaces.workflowId))
		.where(eq(interactions.id, interactionId));

	if (row === undefined) {
		throw new NotFoundError('Взаимодействие не найдено');
	}

	if (!row.templates.includes(templateKey)) {
		throw new ValidationError('Шаблон недоступен в этом процессе', [
			`Процесс «${row.workflowName}» не предлагает шаблон «${DOCUMENT_TEMPLATE_LABELS[templateKey]}»: его включают в редакторе процесса`
		]);
	}

	const owner = templateOwner(templateKey);

	if (owner === null) {
		return;
	}

	const { active } = await readActiveModules(row.workspaceId, executor);

	if (!active.includes(owner)) {
		throw new ValidationError(
			`Шаблон «${DOCUMENT_TEMPLATE_LABELS[templateKey]}» даёт модуль «${moduleByKey(owner)?.label ?? owner}», он не подключён к пространству «${row.workspaceName}»`,
			['Его подключают в «Настройки → Пространства»']
		);
	}
}

/**
 * Новый состав карточки процесса. Действует сразу во всех пространствах
 * процесса и во всех их взаимодействиях, открытых и закрытых: это вид рабочего
 * места, а не условие работы.
 */
export async function updateProcessCard(
	ctx: ActorContext,
	workflowKey: string,
	/** Ввод формы как есть: состав проверяется по каталогу здесь, а не в маршруте. */
	input: unknown
): Promise<ProcessCard> {
	await requirePermission(ctx, 'stages.configure', { type: 'workflows.card_configured' });

	const parsed = processCardSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Состав карточки не прошёл проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const next = parsed.data;

	return withTransaction(ctx, async (tx) => {
		const workflow = await readWorkflowByKey(tx, workflowKey);

		await tx
			.update(workflows)
			.set({
				cardPanels: next.panels,
				documentTemplateKeys: next.templates,
				updatedAt: new Date()
			})
			.where(eq(workflows.id, workflow.id));

		await recordAuditEvent(
			ctx,
			{
				type: 'workflows.card_configured',
				outcome: 'success',
				subject: { type: 'workflow', id: workflow.id },
				details: {
					workflowKey: workflow.key,
					panelCount: next.panels.length,
					templateCount: next.templates.length
				}
			},
			tx
		);

		return next;
	});
}
