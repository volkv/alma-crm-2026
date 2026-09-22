/**
 * Сводка карточки: четыре вопроса, с которыми человек открывает взаимодействие.
 *
 * Что происходит, что мешает, кто должен действовать и что я могу сделать
 * прямо сейчас. Ответ собирается на сервере целиком, потому что три из четырёх
 * вопросов — это правила, а не данные: доступность перехода считает
 * `evaluateTransition`, и интерфейс не имеет права выводить её заново.
 */
import { eq, inArray } from 'drizzle-orm';
import type {
	InteractionAction,
	InteractionSummaryView,
	TransitionOptionView
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { interactionParties, organizations } from '../db/schema';
import { can, requirePermission } from '../rbac';
import { requireActiveRevisionForWorkspace } from '../stages/process';
import { getInteractionStatus } from '../stages/status';
import { evaluateTransition, type StageState } from '../stages/transitions';
import { assertInteractionVisible } from './access';

/** Название организации-стороны: «кого ждём» — это участник, а не абстракция. */
async function readPartyNames(partyIds: string[]): Promise<Map<string, string>> {
	if (partyIds.length === 0) {
		return new Map();
	}

	const rows = await getDb()
		.select({ id: interactionParties.id, name: organizations.shortName })
		.from(interactionParties)
		.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
		.where(inArray(interactionParties.id, partyIds));

	return new Map(rows.map((row) => [row.id, row.name]));
}

export async function getInteractionSummary(
	ctx: ActorContext,
	interactionId: string
): Promise<InteractionSummaryView> {
	requirePermission(ctx, 'interactions.read');

	const interaction = await assertInteractionVisible(ctx, interactionId);
	const [status, revision] = await Promise.all([
		getInteractionStatus(ctx, interactionId),
		requireActiveRevisionForWorkspace(getDb(), interaction.workspaceId)
	]);

	const current = status.current;
	const openBlockers = status.blockers.filter((blocker) => blocker.resolvedAt === null);
	const blockingBlockers = openBlockers.filter((blocker) => blocker.blocksTransition);
	const openPause = current?.pauses.find((pause) => pause.endedAt === null) ?? null;

	const waitingPartyId = openPause?.waitingPartyId ?? current?.waitingPartyId ?? null;
	const partyNames = await readPartyNames(waitingPartyId === null ? [] : [waitingPartyId]);
	const waitingParty =
		waitingPartyId === null
			? null
			: {
					id: waitingPartyId,
					organizationName: partyNames.get(waitingPartyId) ?? 'Участник взаимодействия'
				};

	const stagesById = new Map(revision.stages.map((stage) => [stage.id, stage]));

	let transitions: TransitionOptionView[] = [];

	if (current !== null) {
		const state: StageState = {
			stageId: current.stageId,
			snapshot: current.snapshot,
			checklistState: current.checklistState,
			resultText: current.resultText,
			confirmation: current.confirmation,
			lmsEvidence: current.lmsEvidence,
			documentMarkEvidence: current.documentMarkEvidence,
			isPaused: current.isPaused,
			blockingBlockers: blockingBlockers.length
		};

		transitions = revision.transitions
			.filter((transition) => transition.fromStageId === current.stageId)
			.map((transition) => {
				const toStage = stagesById.get(transition.toStageId);

				// Причину перехода человек вводит в диалоге, поэтому сводка
				// спрашивает готовность без команды: иначе возврат всегда выглядел
				// бы недоступным.
				const verdict = evaluateTransition(ctx, state, transition, null);

				return {
					transition,
					toStage:
						toStage === undefined
							? {
									id: transition.toStageId,
									key: 'unknown',
									name: 'Стадия вне процесса',
									position: 0,
									category: current.snapshot.category
								}
							: {
									id: toStage.id,
									key: toStage.key,
									name: toStage.name,
									position: toStage.position,
									category: toStage.category
								},
					allowed: verdict.allowed,
					reasons: verdict.reasons
				};
			})
			.sort((left, right) => left.toStage.position - right.toStage.position);
	}

	const actions: InteractionAction[] = [];
	const canTransition = can(ctx, 'stages.transition');
	const canWrite = can(ctx, 'interactions.write');

	if (current !== null && canTransition) {
		actions.push(current.isPaused ? 'resume' : 'pause');
		actions.push('set_result');
		actions.push('confirm');

		if (current.snapshot.checklist.length > 0) {
			actions.push('set_checklist');
		}
	}

	if (canWrite) {
		actions.push('raise_blocker');

		if (openBlockers.length > 0) {
			actions.push('resolve_blocker');
		}

		actions.push('comment', 'edit');
	}

	// Смена владельца — не «вести свою работу», а передать чужую: право на неё
	// отдельное, и кнопки у того, кто её не имеет, быть не должно.
	if (can(ctx, 'interactions.reassign')) {
		actions.push('set_responsible');
	}

	if (can(ctx, 'documents.write')) {
		actions.push('upload_document');
	}

	if (can(ctx, 'documents.generate')) {
		actions.push('generate_document');
	}

	const openChecklist =
		current === null
			? []
			: current.snapshot.checklist.filter((item) => current.checklistState[item.key] !== true);

	return {
		happening: {
			stage:
				current === null
					? null
					: {
							id: current.stageId,
							key: current.snapshot.key,
							name: current.snapshot.name,
							position: current.snapshot.position,
							category: current.snapshot.category
						},
			dueAt: current?.dueAt ?? null,
			remainingSeconds: current?.remainingSeconds ?? null,
			isOverdue: current?.isOverdue ?? false,
			isPaused: current?.isPaused ?? false,
			pause: openPause,
			waitingParty,
			nextAction: openPause?.nextAction ?? null
		},
		blocking: {
			blockers: openBlockers,
			openChecklist
		},
		whoActs: {
			responsibleUser:
				current?.responsibleUserId === null || current?.responsibleUserId === undefined
					? null
					: {
							id: current.responsibleUserId,
							name: current.responsibleName ?? 'Ответственный не указан'
						},
			waitingParty
		},
		canDo: { transitions, actions }
	};
}
