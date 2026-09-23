/**
 * Данные под нагрузочный прогон: кто входит, что открывает и что переводит.
 *
 * Сценарий k6 не умеет открывать диалоги и читать разметку: чтобы он мог
 * повторить настоящую работу — открыть карточку и перевести запись на
 * следующую стадию, — ему нужны идентификаторы, которые в интерфейсе человек
 * получает нажатием. Их и собирает этот скрипт — по каждому сотруднику
 * нагрузочной команды (`LOAD_TEAM` в `scripts/seed/load.ts`) отдельно, только
 * из его области доступа: карточку чужого портфеля сервер отдал бы как «не
 * найдено», и прогон мерил бы отказ.
 *
 * Запускается внутри контейнера приложения нагрузочного стенда и печатает JSON
 * в стандартный вывод:
 *
 *   node scripts/load/fixture.ts                        учётные записи и карточки
 *   node scripts/load/fixture.ts --run <ключ> --vus <V> --per-vu <N>
 *                                              то же плюс свежий пул переходов:
 *                                              по N записей на каждый из V VU
 *   node scripts/load/fixture.ts --verify <ключ>        что прогон с этим ключом
 *                                                         записал в базу
 *
 * Без флагов скрипт только читает. С `--run` он заводит новые взаимодействия
 * под переходы (`seedTransitionPool`): переход — изменение состояния, и пул,
 * вычерпанный прошлой ступенью, следующую уже не накормил бы. С `--verify` он
 * считает, сколько переходов и комментариев прогона с этим ключом легло в базу,
 * — сверка с числом успешных ответов, которое насчитал k6.
 */
import { installKitAliases } from '../seed/aliases.ts';

installKitAliases();

const { and, count, desc, eq, inArray, isNotNull, like } = await import('drizzle-orm');
const { closeDatabase, getDb } = await import('$lib/server/db');
const { comments, interactions, stageEntries } = await import('$lib/server/db/schema');
const { mapRealmRoles } = await import('$lib/server/auth/roles');
const { B2B_WORKSPACE_KEY } = await import('$lib/server/stages/definitions');
const { readActiveRevision, readWorkflowForWorkspace, readWorkspaceByKey } =
	await import('$lib/server/stages/process');
const { seedId } = await import('../seed/ids.ts');
const { LOAD_TEAM, loadScopeKeys, seedTransitionPool, transitionPoolPrefix } =
	await import('../seed/load.ts');

/** Сколько «долгих» карточек отдаётся на сотрудника: для замера кэша. */
const LONGEST_PER_ACCOUNT = 20;

/** Значение флага или `null`, если флага нет; флаг без значения — ошибка. */
function option(argv: readonly string[], name: string): string | null {
	const at = argv.indexOf(name);

	if (at === -1) {
		return null;
	}

	const value = argv[at + 1];

	if (value === undefined || value.startsWith('--')) {
		throw new Error(`У флага ${name} нет значения`);
	}

	return value;
}

/** Ключ прогона попадает в название записей и в текст комментариев. */
function runKey(value: string): string {
	if (!/^[A-Za-z0-9-]{1,40}$/.test(value)) {
		throw new Error(`Ключ прогона «${value}»: только латиница, цифры и дефис`);
	}

	return value;
}

/** Целое положительное значение флага. */
function positive(name: string, value: string): number {
	const parsed = Number(value);

	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} ${value}: нужно целое положительное число`);
	}

	return parsed;
}

/** Что прогон с этим ключом записал в базу. */
async function verify(key: string) {
	const db = getDb();
	const pool = db
		.select({ id: interactions.id })
		.from(interactions)
		.where(like(interactions.title, `${transitionPoolPrefix(key)}%`));

	// Каждый переход закрывает запись стадии, а у записи пула закрытых записей
	// до прогона нет: число закрытых — это число состоявшихся переходов.
	const [moved] = await db
		.select({ value: count() })
		.from(stageEntries)
		.where(and(inArray(stageEntries.interactionId, pool), isNotNull(stageEntries.leftAt)));

	const [commented] = await db
		.select({ value: count() })
		.from(comments)
		.where(like(comments.body, `%[${key}]%`));

	return { run: key, transitions: moved.value, comments: commented.value };
}

async function main(argv: readonly string[]) {
	const verifyKey = option(argv, '--verify');

	if (verifyKey !== null) {
		return verify(runKey(verifyKey));
	}

	const poolKey = option(argv, '--run');
	const vus = option(argv, '--vus');
	const perVu = option(argv, '--per-vu');

	if ((poolKey === null) !== (vus === null) || (poolKey === null) !== (perVu === null)) {
		throw new Error('Флаги --run, --vus и --per-vu задаются вместе');
	}

	const db = getDb();
	const workspace = await readWorkspaceByKey(db, B2B_WORKSPACE_KEY);
	const workflow = await readWorkflowForWorkspace(db, workspace.id);
	const revision = workflow === null ? null : await readActiveRevision(db, workflow);

	if (revision === null) {
		throw new Error('У пространства «b2b» нет действующего процесса');
	}

	let pool: Awaited<ReturnType<typeof seedTransitionPool>> = {};

	if (poolKey !== null && vus !== null && perVu !== null) {
		const vuCount = positive('--vus', vus);
		// VU раздаются записям команды по кругу, и пул записи делится между её VU
		// поровну (`browse.js`): на запись приходится столько частей, сколько VU
		// входит ею.
		const perAccount = Math.ceil(vuCount / LOAD_TEAM.length) * positive('--per-vu', perVu);

		pool = await db.transaction((tx) =>
			seedTransitionPool(tx, { runKey: runKey(poolKey), perAccount })
		);
	}

	const accounts = [];

	for (const account of LOAD_TEAM) {
		// Роль системы приносит каталог: запись, заведённая в нём с другой ролью
		// realm, вошла бы не тем, кем её считает набор, и мерила бы чужую область.
		if (mapRealmRoles([account.realmRole]) !== account.roleId) {
			throw new Error(
				`«${account.login}»: роль realm ${account.realmRole} не даёт ${account.roleId}`
			);
		}

		const owners = loadScopeKeys(account).map((key) => seedId('user', key));
		const inScope = and(
			eq(interactions.workspaceId, workspace.id),
			eq(interactions.status, 'active'),
			inArray(interactions.ownerUserId, owners)
		);

		const cards = await db
			.select({ id: interactions.id })
			.from(interactions)
			.where(inScope)
			.orderBy(interactions.id);

		// Записи с длинной лентой: на них видно, что даёт кэш повторного открытия.
		const longest = await db
			.select({ id: interactions.id })
			.from(interactions)
			.innerJoin(comments, eq(comments.interactionId, interactions.id))
			.where(inScope)
			.groupBy(interactions.id)
			.orderBy(desc(count()))
			.limit(LONGEST_PER_ACCOUNT);

		if (cards.length === 0) {
			throw new Error(`У «${account.login}» пустая область: залит ли нагрузочный набор?`);
		}

		accounts.push({
			login: account.login,
			email: account.email,
			firstName: account.firstName,
			lastName: account.lastName,
			role: account.roleId,
			realmRole: account.realmRole,
			cards: cards.map((row) => row.id),
			longest: longest.map((row) => row.id),
			advance: pool[account.login] ?? []
		});
	}

	return {
		workspace: workspace.key,
		revision: revision.version,
		run: poolKey,
		accounts
	};
}

try {
	process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, '\t')}\n`);
} finally {
	await closeDatabase();
}
