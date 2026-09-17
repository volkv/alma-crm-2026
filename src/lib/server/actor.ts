/**
 * Действующее лицо запроса.
 *
 * Каждый сервис принимает `(ctx: ActorContext, input)` — это единственная
 * сигнатура. Контекст собирает транспорт: form action и эндпоинт API строят его
 * из события SvelteKit, фоновые задачи — из `systemActor`. Сервис не смотрит в
 * `locals`, не читает заголовки и не решает, кто перед ним: тогда одно и то же
 * действие ведёт себя одинаково из браузера, из API и из скрипта.
 */
import type { RequestEvent } from '@sveltejs/kit';
import type { AuditSource } from '$lib/contracts/audit';
import type { SessionUser } from './auth/types';

/**
 * Что видит вызывающий. `all` — всё; `delegated` — записи перечисленных
 * пользователей: их вузы (действующие назначения) и их взаимодействия.
 *
 * Область — это множество **людей**, а не организаций. Список организаций,
 * посчитанный при входе, устаревает в ту секунду, когда руководитель меняет
 * ответственного, и до следующего входа человек видел бы чужое или не видел
 * своего. Множество пользователей такой беды не имеет: назначения читаются
 * подзапросом в момент выборки, поэтому переназначение действует немедленно и
 * во всех каналах сразу (`docs/access-matrix.md`, раздел 1).
 */
export type AccessScope = { kind: 'all' } | { kind: 'delegated'; userIds: ReadonlySet<string> };

export type ActorContext = {
	/** Идентификатор запроса; попадает в журнал и в логи базы. */
	requestId: string;
	source: AuditSource;
	user: SessionUser | null;
	apiKeyId: string | null;
	ip: string | null;
	userAgent: string | null;
	scope: AccessScope;
};

/** Область доступа анонимного вызывающего: ничего. */
const NO_ACCESS: AccessScope = { kind: 'delegated', userIds: new Set() };

/**
 * Контекст запроса из браузера или из публичного API. Всё, что нужно сервисам,
 * уже разложено по `locals` хуками — здесь только сборка, без запросов к базе.
 */
export function actorFromEvent(event: RequestEvent): ActorContext {
	const user = event.locals.user;
	const apiKey = event.locals.apiKey;

	return {
		requestId: event.locals.requestId,
		source: apiKey === null ? 'ui' : 'api',
		user,
		apiKeyId: apiKey?.id ?? null,
		ip: event.getClientAddress(),
		userAgent: event.request.headers.get('user-agent'),
		scope: user?.scope ?? NO_ACCESS
	};
}

/**
 * Контекст фоновой работы: миграций данных, импорта, регламентных задач.
 * У него нет пользователя, поэтому проверки прав он проходит по признаку
 * источника — см. `can()`. Создавать его из обработчика запроса нельзя.
 */
export function systemActor(requestId: string): ActorContext {
	return {
		requestId,
		source: 'system',
		user: null,
		apiKeyId: null,
		ip: null,
		userAgent: null,
		scope: { kind: 'all' }
	};
}
