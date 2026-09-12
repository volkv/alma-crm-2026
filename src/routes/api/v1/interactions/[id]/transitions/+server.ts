import { z } from 'zod';
import type { RequestHandler } from './$types';
import { id } from '$lib/contracts/common';
import {
	advanceStageSchema,
	apiTransitionRequestSchema,
	apiTransitionResultSchema,
	returnStageSchema,
	skipStageSchema
} from '$lib/contracts/interactions';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { advanceStage, returnStage, skipStage } from '$lib/server/stages/commands';
import { getInteractionStatus } from '$lib/server/stages/status';

const transitionEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	body: apiTransitionRequestSchema,
	output: apiTransitionResultSchema,
	permission: 'stages.transition',
	// Повторённый переход — это вторая запись в истории взаимодействия, и
	// защищает от неё только ключ идемпотентности.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'post',
	path: '/v1/interactions/{id}/transitions',
	summary: 'Перевод взаимодействия по стадиям',
	description:
		'Шаг вперёд, возврат на доработку или пропуск. Стадия, с которой отдана команда, ' +
		'обязательна: сервер сверит её с открытой записью и откажет с кодом 409, если ' +
		'взаимодействие успели сдвинуть. Возврат и пропуск требуют причины. ' +
		'Повтор с тем же `Idempotency-Key` возвращает прежний ответ и второй записи не создаёт.',
	tags: ['Взаимодействия'],
	config: transitionEndpoint
});

/** Претензии схемы контракта в виде, пригодном для ответа API. */
function parseOrThrow<TSchema extends z.ZodType>(
	schema: TSchema,
	input: unknown
): z.output<TSchema> {
	const parsed = schema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Переход не прошёл проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	return parsed.data;
}

export const POST: RequestHandler = apiHandler(
	transitionEndpoint,
	async (ctx, { params, body }) => {
		const command = {
			interactionId: params.id,
			fromStageId: body.fromStageId,
			toStageId: body.toStageId
		};

		if (body.kind === 'forward') {
			await advanceStage(
				ctx,
				parseOrThrow(advanceStageSchema, {
					...command,
					resultText: body.resultText,
					checklistState: {}
				})
			);
		} else if (body.kind === 'return') {
			await returnStage(ctx, parseOrThrow(returnStageSchema, { ...command, reason: body.reason }));
		} else {
			await skipStage(ctx, parseOrThrow(skipStageSchema, { ...command, reason: body.reason }));
		}

		const status = await getInteractionStatus(ctx, params.id);
		const current = status.current;

		if (current === null) {
			// Сюда попасть нельзя: переход всегда открывает новую запись стадии.
			// Если это всё же случилось, ответ с придуманной стадией был бы хуже отказа.
			throw new ConflictError('После перехода взаимодействие не стоит ни на одной стадии');
		}

		return {
			interactionId: params.id,
			stageId: current.stageId,
			stageKey: current.snapshot.key,
			stageName: current.snapshot.name,
			stagePosition: current.snapshot.position,
			enteredAt: current.enteredAt.toISOString(),
			dueAt: current.dueAt.toISOString()
		};
	}
);
