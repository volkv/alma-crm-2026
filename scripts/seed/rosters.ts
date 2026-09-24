/**
 * Поимённые списки слушателей у нескольких учебных групп демонстрационного
 * стенда.
 *
 * Список загружается тем же путём, что у сотрудника: файл таблицы уходит в
 * `importLearningGroupRoster`, и сервис сам заводит людей (контакты —
 * шифртекстом, `people/pii.ts`), основание обработки «договор», роль в
 * основной стороне и строку списка. Второй реализации загрузки в наборе нет.
 *
 * Люди синтетические целиком, как и остальные люди набора (`directory.ts`):
 * ФИО собраны перебором по порядковому номеру без `Math.random`, почта — на
 * доменах `example.org`/`example.com` с номером группы в адресе, телефонов нет.
 *
 * Передача в систему обучения — иначе. Настоящая передача — это заявка на
 * группу с составом, доставленная по сети имитатору (`sendLearningGroupRoster`
 * → `deliverMessage`), а сид в сеть не ходит: имитатор поднят не на каждой
 * установке, а сброс стенда не должен зависеть от чужой службы. Набор пишет то
 * состояние, которым успешная доставка заканчивается для слушателей, — статус
 * `transferred` и момент передачи (`finish` в
 * `src/lib/server/integrations/exchange/delivery.ts`), ровно как он пишет
 * строками результат потока, а не ответ системы обучения
 * (`recordLearningResult` в `interactions.ts`). Строки сообщения обмена набор
 * не заводит: без замороженного конверта «отправленное» сообщение было бы
 * выдумкой, которую журнал обмена показал бы как настоящую.
 */
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '$lib/server/actor';
import { getDb } from '$lib/server/db';
import { learningGroupLearners } from '$lib/server/db/schema';
import { importLearningGroupRoster } from '$lib/server/integrations/exchange/roster';
import { seedId } from './ids';

const DAY_MS = 24 * 60 * 60 * 1000;

type RosterSeed = {
	/** Взаимодействие; список ложится на его основной поток. */
	interactionKey: string;
	/** Номер группы в системе обучения — он же часть адреса почты слушателя. */
	groupExternalId: string;
	/** Домен почты: тот же, что у контактов этой организации в справочнике. */
	domain: string;
	/** Сколько человек в списке: столько, сколько зачислено в поток. */
	size: number;
	/**
	 * Сколько первых по списку уже передано в систему обучения. Остальные
	 * догружены после передачи и ждут следующей — так карточка показывает оба
	 * статуса в одной группе.
	 */
	transferred: number;
	/** Сдвиг перебора ФИО: у соседних групп списки не повторяют друг друга. */
	offset: number;
};

const ROSTERS: readonly RosterSeed[] = [
	{
		interactionKey: 'ukct-zanyatiya',
		groupExternalId: '70411',
		domain: 'ukct.example.org',
		size: 28,
		transferred: 28,
		offset: 0
	},
	{
		interactionKey: 'pupi-classes-69',
		groupExternalId: '70469',
		domain: 'mipt.example.org',
		size: 33,
		transferred: 30,
		offset: 7
	},
	{
		interactionKey: 'szpu-classes-68',
		groupExternalId: '70468',
		domain: 'spbpu.example.org',
		size: 26,
		transferred: 0,
		offset: 13
	},
	{
		interactionKey: 'mayak-obuchenie-2',
		groupExternalId: '70503',
		domain: 'mayak-telecom.example.com',
		size: 8,
		transferred: 8,
		offset: 21
	}
];

/** Фамилии в мужской и женской форме. */
const LAST_NAMES: readonly (readonly [string, string])[] = [
	['Абрамов', 'Абрамова'],
	['Белов', 'Белова'],
	['Воронин', 'Воронина'],
	['Гаврилов', 'Гаврилова'],
	['Данилов', 'Данилова'],
	['Егоров', 'Егорова'],
	['Жуков', 'Жукова'],
	['Зайцев', 'Зайцева'],
	['Исаев', 'Исаева'],
	['Калинин', 'Калинина'],
	['Лебедев', 'Лебедева'],
	['Макаров', 'Макарова'],
	['Никитин', 'Никитина'],
	['Осипов', 'Осипова'],
	['Панов', 'Панова'],
	['Романов', 'Романова'],
	['Савельев', 'Савельева'],
	['Тихонов', 'Тихонова'],
	['Уваров', 'Уварова'],
	['Фролов', 'Фролова'],
	['Харитонов', 'Харитонова'],
	['Чернов', 'Чернова'],
	['Широков', 'Широкова']
];

const FIRST_NAMES: readonly (readonly [string, string])[] = [
	['Александр', 'Анна'],
	['Богдан', 'Варвара'],
	['Владимир', 'Дарья'],
	['Глеб', 'Екатерина'],
	['Даниил', 'Злата'],
	['Егор', 'Ирина'],
	['Кирилл', 'Ксения'],
	['Лев', 'Мария'],
	['Матвей', 'Полина'],
	['Никита', 'София'],
	['Павел', 'Ульяна']
];

/** Отчества от одного имени отца: мужская и женская форма. */
const PATRONYMICS: readonly (readonly [string, string])[] = [
	['Андреевич', 'Андреевна'],
	['Сергеевич', 'Сергеевна'],
	['Дмитриевич', 'Дмитриевна'],
	['Олегович', 'Олеговна'],
	['Игоревич', 'Игоревна'],
	['Викторович', 'Викторовна'],
	['Максимович', 'Максимовна']
];

/** Строка списка: ФИО тремя колонками и почта. */
function learnerRow(roster: RosterSeed, index: number): string[] {
	const seq = index + roster.offset;
	const form = seq % 2;
	const pick = (list: readonly (readonly [string, string])[], step: number) =>
		list[(seq * step) % list.length][form];
	const number = String(index + 1).padStart(2, '0');

	return [
		pick(LAST_NAMES, 5),
		pick(FIRST_NAMES, 3),
		pick(PATRONYMICS, 2),
		`s${roster.groupExternalId}-${number}@${roster.domain}`
	];
}

/** Файл списка в том виде, в каком его выгружает деканат: CSV с заголовком. */
function rosterFile(roster: RosterSeed, from: number, to: number): Uint8Array {
	const lines = [['Фамилия', 'Имя', 'Отчество', 'Почта']];

	for (let index = from; index < to; index += 1) {
		lines.push(learnerRow(roster, index));
	}

	return new TextEncoder().encode(`${lines.map((line) => line.join(',')).join('\n')}\n`);
}

/**
 * Загружает файл через сервис и требует, чтобы легла каждая строка: строка с
 * претензией в наборе — ошибка набора, а не законный исход загрузки.
 */
async function load(
	ctx: ActorContext,
	roster: RosterSeed,
	input: { interactionId: string; learningGroupId: string },
	from: number,
	to: number
): Promise<void> {
	const view = await importLearningGroupRoster(ctx, input, {
		name: `slushateli-${roster.groupExternalId}.csv`,
		bytes: rosterFile(roster, from, to)
	});
	const rejected = view.rows.filter((row) => row.action === 'error');

	if (view.fileIssues.length > 0 || rejected.length > 0 || view.counts.create !== to - from) {
		throw new Error(
			`Список группы ${roster.groupExternalId} лёг не целиком: ${[
				...view.fileIssues,
				...rejected.map((row) => `строка ${row.rowNo}: ${row.issues.join('; ')}`)
			].join(' | ')}`
		);
	}
}

/** Момент строк списка: в днях до последней активности по делу. */
async function stampLearners(
	learningGroupId: string,
	status: 'listed' | 'transferred',
	addedAt: Date,
	transferredAt: Date | null
): Promise<void> {
	await getDb()
		.update(learningGroupLearners)
		.set({ status, createdAt: addedAt, transferredAt })
		.where(
			and(
				eq(learningGroupLearners.learningGroupId, learningGroupId),
				eq(learningGroupLearners.status, 'listed')
			)
		);
}

/**
 * Поимённый список основного потока взаимодействия, если набор его описывает.
 * Зовётся один раз — сразу после того, как запись заведена и поток у неё есть;
 * на заведённых раньше записях не зовётся вовсе, поэтому убранного на стенде
 * слушателя перезапуск сида не вернёт.
 *
 * Время строк сдвигается, как и остальная история набора: список загрузили за
 * двадцать пять дней до последней активности, передали на следующий день, а
 * догруженных после передачи — за десять.
 */
export async function seedRoster(
	ctx: ActorContext,
	interactionKey: string,
	interactionId: string,
	lastActivityAt: Date
): Promise<void> {
	const roster = ROSTERS.find((candidate) => candidate.interactionKey === interactionKey);

	if (roster === undefined) {
		return;
	}

	const input = { interactionId, learningGroupId: seedId('learning-group', interactionKey) };
	const at = (days: number) => new Date(lastActivityAt.getTime() - days * DAY_MS);

	if (roster.transferred > 0) {
		await load(ctx, roster, input, 0, roster.transferred);
		await stampLearners(input.learningGroupId, 'transferred', at(25), at(24));
	}

	if (roster.size > roster.transferred) {
		await load(ctx, roster, input, roster.transferred, roster.size);
		await stampLearners(
			input.learningGroupId,
			'listed',
			roster.transferred > 0 ? at(10) : at(25),
			null
		);
	}
}

/** Сколько строк описано в наборе: по ним тест проверяет, что всё легло. */
export const ROSTER_SEED_SIZES = {
	groups: ROSTERS.length,
	learners: ROSTERS.reduce((total, roster) => total + roster.size, 0),
	transferred: ROSTERS.reduce((total, roster) => total + roster.transferred, 0),
	/** У физического лица роль не заводится: сторона — он сам. */
	affiliations: ROSTERS.reduce((total, roster) => total + roster.size, 0)
} as const;
