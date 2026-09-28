/**
 * Адаптер «справочник вузов»: сайт по ИНН из статического снимка открытого
 * мониторинга эффективности вузов Минобрнауки.
 *
 * Мониторинг публикует по каждому головному вузу наименование, регион и сайт,
 * который указал сам вуз. ИНН в публикации нет — он сопоставлен с наименованием
 * по ЕГРЮЛ при выгрузке, и в снимок попали только вузы с однозначным
 * сопоставлением (`university-sites.json`: источник, год мониторинга, дата
 * выгрузки и строки `{inn, site, name, region}`). Филиалов, колледжей и вузов,
 * не прошедших мониторинг, в снимке нет, а сайт в нём — на дату выгрузки.
 *
 * Снимок читается лениво: файл весит сотни килобайт, а нужен только тому, кто
 * заводит организацию из реестра. Индекс по ИНН строится при первом обращении и
 * живёт до перезапуска процесса — снимок в процессе не меняется.
 */
import type { WebsiteFinder } from './port';

type UniversitySitesSnapshot = {
	/** Страница мониторинга, с которой снята выгрузка. */
	source: string;
	/** Год мониторинга, как его называет сам мониторинг. */
	year: number;
	/** День выгрузки, `YYYY-MM-DD`. */
	fetchedAt: string;
	count: number;
	organizations: { inn: string; site: string; name: string; region: string }[];
};

type UniversitySitesIndex = {
	sites: Map<string, string>;
	year: number;
	fetchedAt: string;
};

/**
 * Узлы, которые вуз указывает «сайтом», но которые сайтом организации не
 * являются: канал в мессенджере или страница в соцсети. Раздела «Сведения» там
 * нет, и в карточке такой адрес только мешает — лучше пустое поле.
 */
const NOT_A_SITE = new Set(['t.me', 'telegram.me', 'vk.com', 'vk.ru', 'ok.ru', 'dzen.ru']);

let loading: Promise<UniversitySitesIndex> | null = null;

function loadIndex(): Promise<UniversitySitesIndex> {
	loading ??= import('./university-sites.json').then(
		({ default: snapshot }: { default: UniversitySitesSnapshot }) => ({
			sites: new Map(snapshot.organizations.map(({ inn, site }) => [inn, site])),
			year: snapshot.year,
			fetchedAt: snapshot.fetchedAt
		}),
		(error: unknown) => {
			// Неудача не запоминается: следующий поиск попробует прочитать снимок
			// снова, а этот ответит «не знаю» через цепочку.
			loading = null;
			throw error;
		}
	);

	return loading;
}

function isSite(raw: string): boolean {
	try {
		const host = new URL(raw).hostname.replace(/^www\./, '');

		return !NOT_A_SITE.has(host);
	} catch {
		return false;
	}
}

export const universitySites: WebsiteFinder = {
	name: 'university-sites',
	async find({ inn }) {
		if (inn === null) {
			return null;
		}

		const { sites, year, fetchedAt } = await loadIndex();
		const site = sites.get(inn);

		if (site === undefined || !isSite(site)) {
			return null;
		}

		return {
			website: site,
			source: 'monitoring',
			fetchedAt: `${fetchedAt}T00:00:00.000Z`,
			note: `Сайт взят из справочника вузов (мониторинг Минобрнауки за ${year} год, выгрузка ${fetchedAt}) и мог устареть: проверьте его, прежде чем читать раздел «Сведения»`
		};
	}
};
