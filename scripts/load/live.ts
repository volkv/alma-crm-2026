/**
 * Открытые карточки под нагрузкой: потоки живой карточки и комментарии в них.
 *
 * Сценарий k6 не держит долгих ответов: `http.get` ждёт конца тела, а поток
 * живой карточки (`/w/<пространство>/interactions/<id>/live`) не кончается,
 * пока карточка открыта. Поэтому потоки открывает этот скрипт, а k6 рядом
 * гоняет обычный сценарий пользователей (`run.sh live`).
 *
 * Что он делает:
 *
 *   1. входит записями КАМов нагрузочной команды тем же путём, что браузер и
 *      `session.js`: начало входа в приложении, форма каталога, возврат с кодом;
 *   2. у каждого КАМа берёт одну карточку его портфеля и открывает на неё
 *      `PER_CARD` потоков его сессией (лимит — шесть потоков на сессию);
 *   3. раз в `COMMENT_EVERY_MS` пишет комментарий по кругу в эти карточки — так
 *      же, как страница (`x-sveltekit-action`);
 *   4. считает, через сколько после ответа формы событие `comment.added`
 *      пришло в каждый поток карточки, сколько потоков оборвалось и сколько
 *      пингов прошло.
 *
 * Идентификатора комментария ответ формы не несёт, поэтому комментарий узнаётся
 * в потоке как первый новый `commentId` карточки после отправки. Если за это
 * время в карточке появилось два новых (в неё написал и сценарий k6), замер
 * отбрасывается и считается в `ambiguous`, а не приписывается наугад.
 *
 *   FIXTURE=<OUT>/fixture.json OUT=<каталог> PASSWORD=… node scripts/load/live.ts
 *
 * Переменные: `BASE_URL` (по умолчанию `http://localhost:3100`), `CARDS` (20),
 * `PER_CARD` (5), `DURATION_S` (240), `COMMENT_EVERY_MS` (2000). Готовность —
 * файл `<OUT>/live-ready`: потоки открыты, можно запускать k6. Итог —
 * `<OUT>/live.json` и сводка в стандартный вывод.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { request, type APIRequestContext } from '@playwright/test';

type Account = { login: string; cards: string[] };
type Fixture = { workspace: string; accounts: Account[] };

type Session = { login: string; api: APIRequestContext; cookie: string };
type Card = { id: string; session: Session };

type Stream = {
	card: string;
	status: number | null;
	openedMs: number | null;
	/** Почему поток закрылся раньше конца прогона; `null` — дожил. */
	broken: string | null;
	pings: number;
	comments: { commentId: string; at: number }[];
};

type Sent = { card: string; startedAt: number; answeredAt: number; succeeded: boolean };

function required(name: string): string {
	const value = process.env[name];

	if (value === undefined || value === '') {
		throw new Error(`не задана переменная ${name}`);
	}

	return value;
}

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3100';
const PASSWORD = required('PASSWORD');
const OUT = required('OUT');
const fixture = JSON.parse(readFileSync(required('FIXTURE'), 'utf8')) as Fixture;
const CARDS = Number(process.env.CARDS ?? 20);
const PER_CARD = Number(process.env.PER_CARD ?? 5);
const DURATION_S = Number(process.env.DURATION_S ?? 240);
const COMMENT_EVERY_MS = Number(process.env.COMMENT_EVERY_MS ?? 2000);
const RUN = `Поток карточки [${new Date().toISOString().slice(0, 19)}]`;

/** Вход записью каталога; сессия — кука `lct_session`. */
async function signIn(login: string): Promise<Session> {
	const api = await request.newContext({ baseURL: BASE_URL });
	const started = await api.post('/login', {
		headers: {
			Origin: BASE_URL,
			Accept: 'text/html',
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		maxRedirects: 0
	});

	const directory =
		started.status() === 303
			? started.headers()['location']
			: (JSON.parse(await started.text()) as { location: string }).location;
	const form = await api.get(directory);
	const action = /<form[^>]*\saction="([^"]+)"/.exec(await form.text())?.[1];

	if (action === undefined) {
		throw new Error(`каталог не показал форму входа для «${login}»`);
	}

	const submitted = await api.post(action.replace(/&amp;/g, '&'), {
		form: { username: login, password: PASSWORD, credentialId: '' }
	});

	if (submitted.url().includes('/login-actions/')) {
		throw new Error(`каталог не пустил «${login}»`);
	}

	const session = (await api.storageState()).cookies.find((c) => c.name === 'lct_session');

	if (session === undefined) {
		throw new Error(`после входа «${login}» нет сессии: ${submitted.url()}`);
	}

	return { login, api, cookie: `lct_session=${session.value}` };
}

function open(card: Card, streams: Stream[], aborts: AbortController[]): void {
	const stream: Stream = {
		card: card.id,
		status: null,
		openedMs: null,
		broken: null,
		pings: 0,
		comments: []
	};
	const abort = new AbortController();
	const started = Date.now();

	streams.push(stream);
	aborts.push(abort);

	const read = async (): Promise<void> => {
		const response = await fetch(
			`${BASE_URL}/w/${fixture.workspace}/interactions/${card.id}/live`,
			{
				headers: { cookie: card.session.cookie, accept: 'text/event-stream' },
				signal: abort.signal
			}
		);

		stream.status = response.status;
		stream.openedMs = Date.now() - started;

		if (response.status !== 200 || response.body === null) {
			stream.broken = `ответ ${response.status}`;
			return;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		for (;;) {
			const { value, done } = await reader.read();

			if (done) {
				stream.broken = 'сервер закрыл поток';
				return;
			}

			buffer += decoder.decode(value, { stream: true });

			for (let cut = buffer.indexOf('\n\n'); cut >= 0; cut = buffer.indexOf('\n\n')) {
				const chunk = buffer.slice(0, cut);

				buffer = buffer.slice(cut + 2);

				if (chunk.startsWith(':')) {
					stream.pings += 1;
				} else if (/^event: comment\.added$/m.test(chunk)) {
					const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? '{}') as {
						commentId: string;
					};

					stream.comments.push({ commentId: data.commentId, at: Date.now() });
				}
			}
		}
	};

	read().catch((failure: unknown) => {
		if (!abort.signal.aborted) {
			stream.broken = String(failure);
		}
	});
}

function quantile(values: number[], share: number): number {
	const sorted = [...values].sort((a, b) => a - b);

	return sorted[Math.min(Math.floor(sorted.length * share), sorted.length - 1)];
}

const kams = fixture.accounts.filter((account) => account.login.startsWith('load-kam-'));

if (kams.length < CARDS) {
	throw new Error(`в фикстуре ${kams.length} КАМов, а карточек нужно ${CARDS}`);
}

if (PER_CARD > 6) {
	throw new Error('больше шести потоков на сессию сервер не откроет (STREAMS_PER_SESSION)');
}

const cards: Card[] = [];

for (const account of kams.slice(0, CARDS)) {
	cards.push({ id: account.cards[account.cards.length - 1], session: await signIn(account.login) });
	// Две попытки входа одной записью внутри секунды каталог считает подбором.
	await new Promise((resolve) => setTimeout(resolve, 300));
}

const streams: Stream[] = [];
const aborts: AbortController[] = [];

for (const card of cards) {
	for (let index = 0; index < PER_CARD; index += 1) {
		open(card, streams, aborts);
	}
}

await new Promise((resolve) => setTimeout(resolve, 3_000));

const opened = streams.filter((stream) => stream.status === 200).length;

if (opened !== streams.length) {
	throw new Error(`открылось ${opened} потоков из ${streams.length}`);
}

writeFileSync(`${OUT}/live-ready`, '');
console.log(`потоков открыто: ${opened}, карточек: ${cards.length}`);

const sent: Sent[] = [];
let turn = 0;
const began = Date.now();

const writer = setInterval(() => {
	const card = cards[turn % cards.length];

	turn += 1;

	const startedAt = Date.now();

	void card.session.api
		.post(`/w/${fixture.workspace}/interactions/${card.id}?/comment`, {
			form: { body: `${RUN}: комментарий ${turn}` },
			headers: { Accept: 'application/json', 'x-sveltekit-action': 'true', Origin: BASE_URL },
			maxRedirects: 0
		})
		.then(async (response) => {
			sent.push({
				card: card.id,
				startedAt,
				answeredAt: Date.now(),
				succeeded: (await response.text()).includes('"type":"success"')
			});
		});
}, COMMENT_EVERY_MS);

await new Promise((resolve) => setTimeout(resolve, DURATION_S * 1000));
clearInterval(writer);
// Последним комментариям — время дойти.
await new Promise((resolve) => setTimeout(resolve, 3_000));

const seconds = (Date.now() - began) / 1000;
const broken = streams.filter((stream) => stream.broken !== null);

aborts.forEach((abort) => abort.abort());

// Комментарий в потоке — первый новый commentId карточки после отправки.
const delivery: number[] = [];
let ambiguous = 0;
let missing = 0;

for (const comment of sent.filter((entry) => entry.succeeded)) {
	const onCard = streams.filter((stream) => stream.card === comment.card);
	const earlier = new Set(
		onCard.flatMap((stream) =>
			stream.comments.filter((c) => c.at < comment.startedAt).map((c) => c.commentId)
		)
	);
	const fresh = onCard.map((stream) =>
		stream.comments.filter((c) => c.at >= comment.startedAt && !earlier.has(c.commentId))
	);
	const first = fresh
		.flat()
		.sort((a, b) => a.at - b.at)
		.at(0);

	if (first === undefined) {
		missing += onCard.length;
		continue;
	}

	const window = fresh.flat().filter((c) => c.at - first.at < 1_000);

	if (new Set(window.map((c) => c.commentId)).size > 1) {
		ambiguous += 1;
		continue;
	}

	for (const received of fresh) {
		const hit = received.find((c) => c.commentId === first.commentId);

		if (hit === undefined) {
			missing += 1;
		} else {
			delivery.push(hit.at - comment.answeredAt);
		}
	}
}

const forms = sent.map((entry) => entry.answeredAt - entry.startedAt);
const summary = {
	run: RUN,
	seconds,
	streams: streams.length,
	broken: broken.map((stream) => ({ card: stream.card, reason: stream.broken })),
	pingsPerStream: [
		Math.min(...streams.map((s) => s.pings)),
		Math.max(...streams.map((s) => s.pings))
	],
	openMs: {
		p50: quantile(
			streams.map((s) => s.openedMs ?? 0),
			0.5
		),
		max: Math.max(...streams.map((s) => s.openedMs ?? 0))
	},
	comments: {
		sent: sent.length,
		succeeded: sent.filter((entry) => entry.succeeded).length,
		ambiguous
	},
	commentFormMs: { p50: quantile(forms, 0.5), p95: quantile(forms, 0.95), max: Math.max(...forms) },
	deliveries: delivery.length,
	missing,
	deliveryAfterAnswerMs: {
		p50: quantile(delivery, 0.5),
		p95: quantile(delivery, 0.95),
		max: Math.max(...delivery)
	}
};

writeFileSync(`${OUT}/live.json`, `${JSON.stringify(summary, null, '\t')}\n`);
console.log(JSON.stringify(summary, null, '\t'));

await Promise.all(cards.map((card) => card.session.api.dispose()));

process.exit(broken.length === 0 && missing === 0 ? 0 : 1);
