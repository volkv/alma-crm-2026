/**
 * Постановка исходящего сообщения в очередь (outbox).
 *
 * Строка `exchange_messages` появляется **в той же транзакции**, что и доменное
 * изменение: порядок «отправить, потом записать» теряет уведомление при падении
 * процесса между двумя шагами, а «записать после коммита» — при падении сразу
 * после коммита. Отправка идёт после коммита, проходом цикла интеграций
 * (`delivery.ts`).
 *
 * Тело здесь не собирается. Снимок, собранный в момент постановки, уехал бы
 * устаревшим и противоречил бы правилу «сообщение старше применённого не
 * применяется»: сборщик берёт состояние в момент отправки
 * (`docs/exchange-contract.md`, раздел 2).
 *
 * Модуль листовой: движок стадий зовёт его из своей транзакции, и обратной
 * ссылки на `stages/` здесь нет ни одной.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
	EXCHANGE_EVENT_TYPES,
	parseExternalSource,
	type ExchangeSystem
} from '$lib/contracts/exchange';
import { exchangeMessages, interactions } from '../../db/schema';
import type { Tx } from '../../db/transaction';
import { getExchangeSettings } from '../settings';

/** Что кладётся в `payload` до сборки тела: чем это сообщение станет. */
export type OutboundSeed = {
	system: ExchangeSystem;
	instance: string;
	eventType: string;
	externalId: string | null;
	interactionId: string | null;
	/** Начальное тело: сборщик заменит его настоящим в момент отправки. */
	payload: Record<string, unknown>;
};

/**
 * Строка исходящего сообщения в состоянии «ждёт первой попытки».
 *
 * `eventId` придумываем мы и не меняем его при повторах: получатель узнаёт
 * сообщение именно по нему, и повтор после неудачной доставки — это то же самое
 * сообщение, а не новое.
 */
export async function enqueueOutbound(tx: Tx, seed: OutboundSeed): Promise<string> {
	const [row] = await tx
		.insert(exchangeMessages)
		.values({
			direction: 'outbound',
			system: seed.system,
			instance: seed.instance,
			eventType: seed.eventType,
			eventId: randomUUID(),
			externalId: seed.externalId,
			interactionId: seed.interactionId,
			state: 'pending',
			attempt: 0,
			nextAttemptAt: new Date(),
			payload: seed.payload
		})
		.returning({ id: exchangeMessages.id });

	return row.id;
}

/**
 * Снимок состояния заявки уходит на сайт после каждого изменения, которое видно
 * заявителю: приём, переход, пауза, возобновление, смена ответственного,
 * завершение и отмена.
 *
 * Ничего не делает, если взаимодействие пришло не из CMS или направление не
 * настроено: очередь отказов «адрес не задан» на стенде без сайта — это не
 * честная диагностика, а мусор, который никто не разберёт.
 *
 * Экземпляр сверяется с подключением: заявка с другой площадки сайта
 * относится к другому подключению, и слать её статус по нашему адресу значило
 * бы отдавать чужие данные не тому получателю.
 */
export async function enqueueApplicationStatus(tx: Tx, interactionId: string): Promise<void> {
	const [interaction] = await tx
		.select({
			externalSource: interactions.externalSource,
			externalId: interactions.externalId
		})
		.from(interactions)
		.where(eq(interactions.id, interactionId))
		.limit(1);

	if (interaction === undefined || interaction.externalId === null) {
		return;
	}

	const source = parseExternalSource(interaction.externalSource);

	if (source === null || source.system !== 'cms') {
		return;
	}

	const settings = await getExchangeSettings(tx);

	if (settings.cms.statusUrl === null || settings.cms.instance !== source.instance) {
		return;
	}

	// Снимок по этой заявке уже ждёт первой отправки — второй не нужен: тело
	// собирается в момент отправки (`delivery.ts`), и ждущее сообщение и так
	// унесёт состояние после этого изменения. Без этого серия шагов подряд —
	// сид, проведённый по стадиям, или сотрудник, прошедший три стадии за
	// минуту, — давала пачку одинаковых снимков последнего состояния.
	//
	// Ждущее сообщение берётся под блокировку строки и только нетронутым:
	// ни одной попытки, тела нет. Цикл доставки забирает сообщение условной
	// правкой той же строки (`claim` увеличивает `attempt`), поэтому он либо
	// заберёт его раньше — и условие здесь уже не совпадёт, новое сообщение
	// встанет в очередь, — либо дождётся конца этой транзакции и соберёт тело
	// уже с этим изменением.
	const [waiting] = await tx
		.select({ id: exchangeMessages.id })
		.from(exchangeMessages)
		.where(
			and(
				eq(exchangeMessages.direction, 'outbound'),
				eq(exchangeMessages.eventType, EXCHANGE_EVENT_TYPES.applicationStatus),
				eq(exchangeMessages.interactionId, interactionId),
				eq(exchangeMessages.state, 'pending'),
				eq(exchangeMessages.attempt, 0),
				isNull(exchangeMessages.envelope)
			)
		)
		.limit(1)
		.for('update');

	if (waiting !== undefined) {
		return;
	}

	await enqueueOutbound(tx, {
		system: 'cms',
		instance: source.instance,
		eventType: EXCHANGE_EVENT_TYPES.applicationStatus,
		externalId: interaction.externalId,
		interactionId,
		payload: { pending: 'application.status', externalId: interaction.externalId }
	});
}
