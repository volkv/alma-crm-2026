/**
 * Готовые заявки, которыми имитатор CMS стучится в CRM.
 *
 * Тела взяты из контракта обмена (`docs/exchange-contract.md`, раздел 3) —
 * ровно те, что там показаны примерами: проверка обязана идти против
 * объявленного контракта, а не против тела, которое имитатор придумал себе
 * сам. Название вуза публичное, как и в сиде стенда; имя, адрес, почта и
 * реквизиты заявителя вымышлены (`docs/seeds.md`).
 */

export type ApplicationForm = 'b2b' | 'b2c';

export type ApplicationTemplate = {
	externalId: string;
	data: Record<string, unknown>;
};

export const APPLICATION_FORMS: readonly ApplicationForm[] = ['b2b', 'b2c'];

export function isApplicationForm(value: unknown): value is ApplicationForm {
	return value === 'b2b' || value === 'b2c';
}

const TEMPLATES: Record<ApplicationForm, ApplicationTemplate> = {
	b2b: {
		externalId: 'site-2026-000123',
		data: {
			form: 'b2b',
			applicant: {
				kind: 'educational_institution',
				name: 'Московский технический университет связи и информатики',
				inn: '0000000096',
				ogrn: '1260000000094',
				educationLevel: 'vo'
			},
			contact: {
				lastName: 'Кузьмина',
				firstName: 'Наталья',
				email: 'kuzmina@mtuci.example.org',
				phone: '+7 900 000-00-11',
				position: 'Проректор по цифровому развитию'
			},
			interest: 'Программа подготовки DevOps-инженеров',
			programCodes: ['VO-BAK-01'],
			productCodes: ['RT-DEVOPS'],
			comment: 'Просим связаться до конца недели.',
			transferStatus: 'not_started',
			attachments: []
		}
	},
	b2c: {
		externalId: 'site-2026-000124',
		data: {
			form: 'b2c',
			applicant: { kind: 'individual', lastName: 'Ветров', firstName: 'Илья' },
			contact: {
				lastName: 'Ветров',
				firstName: 'Илья',
				email: 'vetrov@example.org',
				phone: '+7 900 000-00-22'
			},
			interest: 'Повышение квалификации по промышленной разработке',
			programCodes: ['DPO-01'],
			productCodes: [],
			comment: 'Хочу учиться вечером.',
			// Согласие с постоянной датой: стенд обязан выглядеть одинаково при
			// каждом запуске, иначе снимок экрана перестанет совпадать с экраном.
			consent: { given: true, at: '2026-09-16T09:40:55Z', policyVersion: '2026-01' },
			attachments: []
		}
	}
};

/** Тело заявки набора с подставленными ключом и ревизией. */
export function applicationTemplate(
	form: ApplicationForm,
	externalId: string,
	revision: number
): Record<string, unknown> {
	return {
		externalId,
		revision,
		...structuredClone(TEMPLATES[form].data)
	};
}

/** Ключ заявки набора: с него начинается нумерация заявок стенда. */
export function templateExternalId(form: ApplicationForm): string {
	return TEMPLATES[form].externalId;
}
