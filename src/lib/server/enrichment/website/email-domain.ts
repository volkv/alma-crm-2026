/**
 * Адаптер «домен почты»: сайт угадывается по почте из выписки (`siteFromEmails`).
 *
 * У вуза почта почти всегда на собственном домене (`rector@spbstu.ru`), но это
 * догадка, а не сведения: домен почты бывает у головной организации, у
 * учредителя или у давно переехавшего сайта. Поэтому в цепочке он последний и
 * помечается догадкой.
 */
import { siteFromEmails } from '../sveden';
import type { WebsiteFinder } from './port';

export const emailDomain: WebsiteFinder = {
	name: 'email-domain',
	find({ emails }) {
		const website = siteFromEmails(emails);

		return website === null
			? null
			: {
					website,
					source: 'guess',
					note: 'Сайт в ЕГРЮЛ не хранится и угадан по домену почты из выписки: проверьте его, прежде чем читать раздел «Сведения»'
				};
	}
};
