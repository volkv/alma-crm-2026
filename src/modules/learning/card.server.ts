/**
 * Серверная часть «Обучения» в карточке: заявка на поток, отметка о
 * завершении, список слушателей и его выгрузка для системы обучения.
 *
 * Обмен с LMS — сервисы ядра, они же проверяют права и область доступа; здесь
 * только разбор формы и перевод отказа. Что модуль действует в пространстве
 * дела, проверяет реестр до вызова.
 */
import { error, fail } from '@sveltejs/kit';
import { DOCUMENT_FORMAT_MIME_TYPES } from '$lib/contracts/documents';
import {
	completeLearningGroupSchema,
	learningGroupRosterSchema,
	removeLearnerSchema,
	sendLearningGroupSchema
} from '$lib/contracts/exchange';
import { defineCardServer } from '$lib/platform/card.server';
import {
	actorFromEvent,
	addCounterpartyLearner,
	contentDisposition,
	exportLearningGroupRoster,
	fileField,
	importLearningGroupRoster,
	markLearningGroupCompleted,
	parse,
	previewLearningGroupRoster,
	removeLearner,
	requestLearningGroup,
	run,
	sendLearningGroupRoster,
	text,
	toActionFailure,
	toPageError
} from '$lib/platform/core.server';
import learning from './index';

export default defineCardServer(learning, {
	actions: {
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
				comment: data.get('comment'),
				// Флажок «досрочно» приходит строкой только отмеченным: без него
				// поток с концом в будущем сервер не закроет.
				early: data.get('early') === 'true'
			});

			if (!parsed.ok) return parsed.failure;

			return run(() => markLearningGroupCompleted(actorFromEvent(event), parsed.data));
		},

		/**
		 * Предпросмотр списка слушателей: что станет с каждой строкой файла.
		 * Ничего не пишет — подтверждение присылает тот же файл ещё раз.
		 */
		rosterPreview: async (event) => {
			const data = await event.request.formData();
			const parsed = parse(learningGroupRosterSchema, {
				interactionId: event.params.id,
				learningGroupId: data.get('learningGroupId')
			});

			if (!parsed.ok) return parsed.failure;

			const file = fileField(data, 'file');

			if (file === null) {
				return fail(400, {
					message: 'Выберите файл со списком слушателей',
					issues: [] as string[]
				});
			}

			try {
				return {
					ok: true,
					roster: await previewLearningGroupRoster(actorFromEvent(event), parsed.data, {
						name: file.name,
						bytes: new Uint8Array(await file.arrayBuffer())
					})
				};
			} catch (cause) {
				return toActionFailure(cause);
			}
		},

		/**
		 * Загрузка списка слушателей: тот же разбор и та же сверка, что в
		 * предпросмотре, но с записью. Строки с претензиями не загружаются.
		 */
		rosterImport: async (event) => {
			const data = await event.request.formData();
			const parsed = parse(learningGroupRosterSchema, {
				interactionId: event.params.id,
				learningGroupId: data.get('learningGroupId')
			});

			if (!parsed.ok) return parsed.failure;

			const file = fileField(data, 'file');

			if (file === null) {
				return fail(400, {
					message: 'Выберите файл со списком слушателей',
					issues: [] as string[]
				});
			}

			try {
				return {
					ok: true,
					roster: await importLearningGroupRoster(actorFromEvent(event), parsed.data, {
						name: file.name,
						bytes: new Uint8Array(await file.arrayBuffer())
					})
				};
			} catch (cause) {
				return toActionFailure(cause);
			}
		},

		/** Передача списка в систему обучения — действием сотрудника, как и заявка. */
		rosterSend: async (event) => {
			const data = await event.request.formData();
			const parsed = parse(learningGroupRosterSchema, {
				interactionId: event.params.id,
				learningGroupId: data.get('learningGroupId')
			});

			if (!parsed.ok) return parsed.failure;

			try {
				const outcome = await sendLearningGroupRoster(actorFromEvent(event), parsed.data);

				return outcome.delivered
					? { ok: true }
					: fail(502, {
							message:
								outcome.error ?? 'Система обучения не ответила: список остался в очереди повторов',
							issues: [] as string[]
						});
			} catch (cause) {
				return toActionFailure(cause);
			}
		},

		rosterRemove: async (event) => {
			const data = await event.request.formData();
			const parsed = parse(removeLearnerSchema, {
				interactionId: event.params.id,
				learningGroupId: data.get('learningGroupId'),
				personId: data.get('personId')
			});

			if (!parsed.ok) return parsed.failure;

			return run(() => removeLearner(actorFromEvent(event), parsed.data));
		},

		/** Слушатель — сам контрагент-лицо: в список одной кнопкой, без файла. */
		rosterAddCounterparty: async (event) => {
			const data = await event.request.formData();
			const parsed = parse(learningGroupRosterSchema, {
				interactionId: event.params.id,
				learningGroupId: data.get('learningGroupId')
			});

			if (!parsed.ok) return parsed.failure;

			return run(() => addCounterpartyLearner(actorFromEvent(event), parsed.data));
		}
	},

	files: {
		/**
		 * Список слушателей одного потока — книгой по шаблону загрузки
		 * пользователей в систему обучения.
		 *
		 * Ссылка из диалога «Слушатели потока»: сюда приходят с сессионной кукой,
		 * а отказ рисуется страницей ошибки, как у приглашения на встречу. Поток —
		 * параметр `group`: одна выгрузка — одна группа, как и сам диалог. Права,
		 * область и отозванные согласия проверяет сервис списка.
		 */
		'roster.xlsx': async (event) => {
			const ctx = actorFromEvent(event);
			const input = learningGroupRosterSchema.safeParse({
				interactionId: event.params.id,
				learningGroupId: event.url.searchParams.get('group')
			});

			// Испорченный параметр адреса — не предметная ошибка: до сервиса такой
			// запрос не доходит.
			if (!input.success) {
				error(400, 'Укажите поток, список которого выгрузить');
			}

			try {
				const file = await exportLearningGroupRoster(ctx, input.data);

				return new Response(file.body, {
					headers: {
						'Content-Type': DOCUMENT_FORMAT_MIME_TYPES.xlsx,
						'Content-Disposition': contentDisposition(file.fileName),
						// Книга несёт почту и телефоны слушателей: ни браузеру, ни кэшу её
						// не хранить.
						'Cache-Control': 'no-store',
						'X-Content-Type-Options': 'nosniff'
					}
				});
			} catch (failure) {
				toPageError(failure);
			}
		}
	},

	load: null
});
