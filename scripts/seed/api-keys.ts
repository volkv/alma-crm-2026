/**
 * Ключи обмена стенда: по одному на подключение, из переменных окружения.
 *
 * Обычно ключ выпускает администратор на экране «Настройки → Ключи доступа», и
 * это единственный способ его получить: значение показывается один раз, в базе
 * остаётся только `sha256`. На публичном стенде с `DEMO_MODE=true` этого пути
 * нет вовсе — демонстрационная сессия не получает права `api_keys.manage`, а у
 * штатного администратора нет учётной записи в каталоге, пока её не завели
 * руками. Стенд при этом обязан показывать обмен: имитаторы сайта и системы
 * обучения ходят в CRM ключом, и без него сцена обмена не работает.
 *
 * Поэтому значение ключа задаёт развёртывание, а сид его только заводит:
 * `EXCHANGE_API_KEY_CMS` и `EXCHANGE_API_KEY_LMS` в `.env` стенда, те же
 * значения — у имитаторов (`CRM_API_KEY`, см. `docker-compose.yml`). Переменной
 * нет — ключа нет: придумать его сид не может, иначе значение осталось бы в
 * логе контейнера, а имитатор всё равно не узнал бы его.
 *
 * Ключ на подключение, а не один на оба: права роли `service` одинаковы у всех
 * ключей обмена, и разграничивает направления только привязка
 * (`api_keys.exchange_system`) — общий ключ означал бы, что сайт подаёт
 * результаты учебных групп.
 *
 * Хеш считает та же функция, что и выпуск из интерфейса (`hashApiKey`): второй
 * способ посчитать хеш однажды разошёлся бы с первым, и заведённый сидом ключ
 * молча перестал бы проходить вход.
 */
import { env } from '$env/dynamic/private';
import { inArray } from 'drizzle-orm';
import { API_KEY_EXCHANGE_SYSTEMS, type ApiKeyExchangeSystem } from '$lib/contracts/api';
import { API_KEY_PATTERN, hashApiKey } from '$lib/server/api/keys';
import { apiKeys } from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { getExchangeSettings } from '$lib/server/integrations/settings';
import { seedId } from './ids';

/** Переменная окружения и подпись ключа для каждого направления обмена. */
const KEYS: Record<ApiKeyExchangeSystem, { variable: string; name: string }> = {
	cms: { variable: 'EXCHANGE_API_KEY_CMS', name: 'Сайт (CMS) — ключ стенда' },
	lms: { variable: 'EXCHANGE_API_KEY_LMS', name: 'Система обучения — ключ стенда' }
};

/**
 * Что сид сделал с ключом направления.
 *
 * `diverged` — заведённый ключ разошёлся с окружением: значение переменной
 * поменяли после первой заливки или переименовали экземпляр подключения.
 * Переписать строку сид не может — хеш нового значения означал бы новый ключ, а
 * старый перестал бы работать без единого следа, — поэтому он сообщает об этом
 * вызывающему, а тот пишет предупреждение в лог.
 */
export type ExchangeKeySeedResult = { system: ApiKeyExchangeSystem } & (
	| { status: 'absent' | 'created' | 'kept' | 'revoked' | 'external' }
	| { status: 'diverged'; field: 'key' }
	/** Экземпляр — тот, на который подключение настроено сейчас, а не в ключе. */
	| { status: 'diverged'; field: 'instance'; instance: string }
);

/** Значение переменной или `null`, если её нет либо она пуста. */
function rawKey(variable: string): string | null {
	const value = env[variable]?.trim();

	return value === undefined || value === '' ? null : value;
}

/**
 * Проверка значений до первой вставки.
 *
 * Формат обязателен целиком: `authenticateApiKey` отвергает всё, что не
 * подходит под `API_KEY_PATTERN`, ещё до похода в базу, — значит, ключ из
 * произвольной строки не заработал бы никогда, а стенд молчал бы об этом до
 * первой заявки. Совпадение двух значений — то же самое: одна строка на два
 * направления снимает границу между ними, а второй такой хеш база и так не
 * примет (`api_keys.key_hash` уникален).
 */
function checkRawKeys(values: Record<ApiKeyExchangeSystem, string | null>): void {
	for (const system of API_KEY_EXCHANGE_SYSTEMS) {
		const value = values[system];

		if (value !== null && !API_KEY_PATTERN.test(value)) {
			throw new Error(
				`${KEYS[system].variable} не похожа на ключ доступа: нужен «lct_» и 32 символа из ` +
					'латиницы, цифр, «_» и «-» — ровно в таком виде ключ выпускает система, и другой ' +
					'она не примет. Возьмите значение у выпущенного ключа или сгенерируйте его тем же ' +
					'способом: lct_$(openssl rand -base64 24 | tr "+/" "_-" | tr -d "=")'
			);
		}
	}

	if (values.cms !== null && values.cms === values.lms) {
		throw new Error(
			'EXCHANGE_API_KEY_CMS и EXCHANGE_API_KEY_LMS совпадают. Ключ обмена привязан к ' +
				'подключению, и один на оба направления означал бы, что сайт подаёт результаты ' +
				'учебных групп, — задайте разные значения'
		);
	}
}

/**
 * Заводит ключи обмена по переменным окружения и рассказывает, что получилось.
 *
 * Возвращает, а не печатает: `seedAll` зовут и скрипт, и кнопка сброса
 * демонстрационных данных на сервере, и `console` внутри заливки писал бы в лог
 * приложения (`docs/seeds.md`, «Одна функция на скрипт и на сервер»).
 */
export async function seedApiKeys(
	tx: Tx,
	options: { serviceUserId: string }
): Promise<ExchangeKeySeedResult[]> {
	const values: Record<ApiKeyExchangeSystem, string | null> = {
		cms: rawKey(KEYS.cms.variable),
		lms: rawKey(KEYS.lms.variable)
	};

	checkRawKeys(values);

	// Экземпляр — из настроек обмена, ровно как при выпуске из интерфейса:
	// с ним сверяется `source.instance` входящего сообщения, и второе место, где
	// это имя набирают руками, однажды разошлось бы с первым.
	const settings = await getExchangeSettings(tx);
	const instances: Record<ApiKeyExchangeSystem, string> = {
		cms: settings.cms.instance,
		lms: settings.lms.instance
	};

	const ids = Object.fromEntries(
		API_KEY_EXCHANGE_SYSTEMS.map((system) => [system, seedId('api-key', `exchange-${system}`)])
	) as Record<ApiKeyExchangeSystem, string>;

	const existing = new Map(
		(
			await tx
				.select({
					id: apiKeys.id,
					keyHash: apiKeys.keyHash,
					exchangeInstance: apiKeys.exchangeInstance,
					revokedAt: apiKeys.revokedAt
				})
				.from(apiKeys)
				.where(inArray(apiKeys.id, Object.values(ids)))
		).map((row) => [row.id, row])
	);

	const results: ExchangeKeySeedResult[] = [];

	for (const system of API_KEY_EXCHANGE_SYSTEMS) {
		const value = values[system];

		if (value === null) {
			results.push({ system, status: 'absent' });
			continue;
		}

		const keyHash = hashApiKey(value);
		const row = existing.get(ids[system]);

		if (row === undefined) {
			// `on conflict do nothing` — как у остальных наборов, но конфликт здесь
			// бывает не по идентификатору (его только что не нашли), а по хешу:
			// это же значение уже выпущено другой строкой. Так бывает у стенда,
			// который жил с ключом, выпущенным из интерфейса, а потом положил его
			// значение в `.env`. Ключ при этом работает — им владеет та строка, —
			// и рвать заливку из-за этого незачем, но и молчать нельзя: отзывает и
			// перевыпускает его не сид.
			const inserted = await tx
				.insert(apiKeys)
				.values({
					id: ids[system],
					name: KEYS[system].name,
					keyHash,
					ownerUserId: options.serviceUserId,
					exchangeSystem: system,
					exchangeInstance: instances[system]
				})
				.onConflictDoNothing()
				.returning({ id: apiKeys.id });

			results.push({ system, status: inserted.length === 1 ? 'created' : 'external' });
			continue;
		}

		// Порядок проверок — от того, что делает ключ неработающим, к тому, что
		// делает его непригодным для этого подключения.
		if (row.keyHash !== keyHash) {
			results.push({ system, status: 'diverged', field: 'key' });
		} else if (row.exchangeInstance !== instances[system]) {
			results.push({
				system,
				status: 'diverged',
				field: 'instance',
				instance: instances[system]
			});
		} else if (row.revokedAt !== null) {
			results.push({ system, status: 'revoked' });
		} else {
			results.push({ system, status: 'kept' });
		}
	}

	return results;
}

/**
 * Строки отчёта о ключах обмена — для лога скрипта. Живут рядом с набором, а не
 * в `run.ts`: список направлений и имена переменных объявлены здесь.
 */
export function exchangeKeyReport(results: readonly ExchangeKeySeedResult[]): string[] {
	return results.map((result) => {
		const { variable } = KEYS[result.system];

		switch (result.status) {
			case 'absent':
				return `ключа обмена «${result.system}» нет: переменная ${variable} не задана`;
			case 'created':
				return `ключ обмена «${result.system}» заведён по ${variable}`;
			case 'kept':
				return `ключ обмена «${result.system}» уже заведён`;
			case 'external':
				return `внимание: значение ${variable} принадлежит ключу, выпущенному не сидом. Сид его не трогает: этот ключ работает, но подключением и отзывом у него управляет тот, кто его выпустил`;
			case 'revoked':
				return `внимание: ключ обмена «${result.system}» отозван на стенде. Сид его не возвращает: отзыв — это решение администратора. Задайте в ${variable} новое значение и залейте сид заново`;
			case 'diverged':
				return result.field === 'key'
					? `внимание: ${variable} не совпадает с заведённым ключом обмена «${result.system}». Сид не переписывает ключ: прежний перестал бы работать без следа. Отзовите его в «Настройки → Ключи доступа» и залейте сид заново — или верните переменной прежнее значение`
					: `внимание: ключ обмена «${result.system}» привязан к другому экземпляру подключения, чем настроен сейчас («${result.instance}»). Отзовите ключ и залейте сид заново, иначе вложения обмена этого подключения ему недоступны`;
		}
	});
}
