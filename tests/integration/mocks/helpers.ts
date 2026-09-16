/**
 * Приёмник на месте CRM для проверок имитаторов.
 *
 * Обычный `http.createServer`, как в проверках доставки вебхуков: подделка,
 * которая «как будто приняла запрос», не показала бы ни заголовков, ни тела —
 * а проверяется здесь именно то, что имитатор отправляет по сети.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type CrmRequest = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string;
};

export type CrmStandIn = {
	url: string;
	/** Что приёмник получил, в порядке получения. */
	requests: CrmRequest[];
	/** Чем он отвечает дальше. */
	reply: { status: number; body: unknown };
	stop: () => Promise<void>;
};

export async function startCrmStandIn(): Promise<CrmStandIn> {
	const requests: CrmRequest[] = [];
	const state = {
		reply: { status: 200, body: { schemaVersion: '1.0', result: 'created', data: {} } as unknown }
	};

	const server: Server = createServer((request, response) => {
		let body = '';

		request.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});

		request.on('end', () => {
			requests.push({
				method: request.method ?? '',
				path: request.url ?? '',
				headers: Object.fromEntries(
					Object.entries(request.headers).map(([name, value]) => [name, String(value)])
				),
				body
			});

			response.writeHead(state.reply.status, { 'content-type': 'application/json' });
			response.end(JSON.stringify(state.reply.body));
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});

	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		get reply() {
			return state.reply;
		},
		set reply(value: { status: number; body: unknown }) {
			state.reply = value;
		},
		stop: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
				server.closeAllConnections();
			})
	};
}

/**
 * Заголовки подписи, какие ставит CRM. Считаются здесь своим `createHmac`, а
 * не функцией имитатора: иначе подпись сверялась бы сама с собой и расхождение
 * формата с контрактом (`docs/exchange-contract.md`, раздел 2) осталось бы
 * незамеченным.
 */
export function signedHeaders(
	secret: string,
	body: string,
	options: { timestamp?: string; signature?: string } = {}
): Record<string, string> {
	const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
	const signature =
		options.signature ??
		`sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

	return {
		'content-type': 'application/json',
		'x-exchange-id': 'stand',
		'x-exchange-timestamp': timestamp,
		'x-exchange-signature': signature
	};
}

/** Конверт исходящего сообщения CRM — тот же, что описан в контракте. */
export function crmEnvelope(
	eventType: string,
	data: Record<string, unknown>,
	eventId: string
): Record<string, unknown> {
	return {
		schemaVersion: '1.0',
		eventId,
		eventType,
		occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		source: { system: 'crm', instance: 'lct-crm' },
		data
	};
}
