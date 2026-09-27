/**
 * Конверт сообщения обмена: тот же у всех четырёх направлений
 * (`docs/exchange-contract.md`, раздел 2).
 *
 * Разбор строгий: неизвестное поле верхнего уровня — отказ, неизвестный
 * `major` схемы — отдельный код `unsupported_version`. Имитатор, принимающий
 * что попало, показал бы на стенде обмен, которого не будет: настоящий
 * получатель тоже отвергнет конверт, который не понял.
 */
import { randomUUID } from 'node:crypto';

/** Версия схемы, на которой говорит контракт v1. */
export const SCHEMA_VERSION = '3.0';

/** Чей это экземпляр. `crm` — наша система, остальные — чужие. */
export type SourceSystem = 'cms' | 'lms' | 'crm';

export type Envelope = {
	schemaVersion: string;
	eventId: string;
	eventType: string;
	occurredAt: string;
	source: { system: SourceSystem; instance: string };
	data: Record<string, unknown>;
};

const ENVELOPE_FIELDS = [
	'schemaVersion',
	'eventId',
	'eventType',
	'occurredAt',
	'source',
	'data'
] as const;

/** Собрать конверт исходящего сообщения. `eventId` задают при повторе события. */
export function buildEnvelope(options: {
	eventType: string;
	system: SourceSystem;
	instance: string;
	data: Record<string, unknown>;
	eventId?: string;
	occurredAt?: Date;
}): Envelope {
	return {
		schemaVersion: SCHEMA_VERSION,
		eventId: options.eventId ?? randomUUID(),
		eventType: options.eventType,
		occurredAt: (options.occurredAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
		source: { system: options.system, instance: options.instance },
		data: options.data
	};
}

export type EnvelopeRefusal = { status: number; code: string; message: string };

export type EnvelopeParse =
	{ ok: true; envelope: Envelope } | { ok: false; refusal: EnvelopeRefusal };

function validation(message: string): EnvelopeParse {
	return { ok: false, refusal: { status: 400, code: 'validation', message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Разобрать входящий конверт. `expected` называет тип события и систему
 * отправителя: сообщение не того типа на этом адресе — ошибка отправителя, а
 * не повод разбираться в теле.
 */
export function parseEnvelope(
	raw: string,
	expected: { eventType: string; system: SourceSystem }
): EnvelopeParse {
	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		return validation('Тело запроса не разбирается как JSON');
	}

	if (!isRecord(parsed)) {
		return validation('Тело запроса — не объект');
	}

	const unknownFields = Object.keys(parsed).filter(
		(name) => !ENVELOPE_FIELDS.includes(name as (typeof ENVELOPE_FIELDS)[number])
	);

	if (unknownFields.length > 0) {
		return validation(`Неизвестные поля конверта: ${unknownFields.join(', ')}`);
	}

	const version = parsed.schemaVersion;

	if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
		return validation('Поле schemaVersion обязательно и имеет вид <major>.<minor>');
	}

	if (version.split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
		return {
			ok: false,
			refusal: {
				status: 400,
				code: 'unsupported_version',
				message: `Версия схемы ${version} несовместима с ${SCHEMA_VERSION}`
			}
		};
	}

	const eventId = parsed.eventId;

	if (typeof eventId !== 'string' || eventId === '' || eventId.length > 200) {
		return validation('Поле eventId обязательно: строка до 200 символов');
	}

	if (parsed.eventType !== expected.eventType) {
		return validation(
			`На этом адресе принимается только ${expected.eventType}, получено ${String(parsed.eventType)}`
		);
	}

	const occurredAt = parsed.occurredAt;

	if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
		return validation('Поле occurredAt обязательно: момент в формате ISO 8601');
	}

	const source = parsed.source;

	if (!isRecord(source) || typeof source.instance !== 'string' || source.instance === '') {
		return validation('Поле source обязательно: system и instance');
	}

	if (source.system !== expected.system) {
		return validation(
			`Отправителем ожидается ${expected.system}, получено ${String(source.system)}`
		);
	}

	if (!isRecord(parsed.data)) {
		return validation('Поле data обязательно: объект тела сообщения');
	}

	return {
		ok: true,
		envelope: {
			schemaVersion: version,
			eventId,
			eventType: expected.eventType,
			occurredAt,
			source: { system: expected.system, instance: source.instance },
			data: parsed.data
		}
	};
}
