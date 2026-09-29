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
				name: 'Московский политехнический университет',
				inn: '0000000089',
				ogrn: '1260000000083',
				educationLevel: 'vo'
			},
			contact: {
				lastName: 'Кузьмина',
				firstName: 'Наталья',
				email: 'kuzmina@mospolytech.example.org',
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
			interest: 'Повышение квалификации: управление проектами',
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

/**
 * Какую программу называет заявка: ту, что в наборе, или такую, которой нет в
 * справочнике CRM, — сайт знает программу, а CRM её код не опознаёт. Второе
 * показывает, как CRM помечает дело, программу которого надо выбрать руками.
 */
export const APPLICATION_PROGRAMS = ['из набора', 'нет в каталоге CRM'] as const;

export type ApplicationProgram = (typeof APPLICATION_PROGRAMS)[number];

export function isApplicationProgram(value: unknown): value is ApplicationProgram {
	return (APPLICATION_PROGRAMS as readonly unknown[]).includes(value);
}

/** Код программы сайта, которого в справочнике CRM нет. */
const UNKNOWN_PROGRAM = {
	interest: 'Повышение квалификации по промышленной разработке',
	programCodes: ['SITE-PROM-DEV']
};

/** Тело заявки с программой, которой нет в справочнике CRM. */
export function withUnknownProgram(data: Record<string, unknown>): Record<string, unknown> {
	return { ...data, ...structuredClone(UNKNOWN_PROGRAM) };
}

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

/**
 * Заявитель, которого назвали в форме страницы стенда: ФИО физлица (`b2c`) или
 * название организации (`b2b`).
 *
 * Строка короткая и из букв, цифр и обычной пунктуации: триггер открыт наружу,
 * и из поля формы в CRM уходит только имя, а не произвольный текст.
 */
const APPLICANT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .,«»"'()-]{1,119}$/u;

export function applicantIssue(form: ApplicationForm, applicant: string): string | null {
	if (!APPLICANT_PATTERN.test(applicant)) {
		return 'applicant: от 2 до 120 знаков — буквы, цифры, пробелы и обычная пунктуация';
	}

	if (form === 'b2c' && applicant.split(/\s+/).filter((part) => part !== '').length < 2) {
		return 'applicant: у физлица укажите фамилию и имя через пробел';
	}

	return null;
}

/**
 * Тело заявки набора с заявителем из формы.
 *
 * CRM узнаёт физлицо по почте, затем по телефону, а организацию — по ИНН, затем
 * по ОГРН (`docs/exchange-contract.md`, раздел 3). Оставь здесь почту, телефон и
 * реквизиты набора — и заявка «своего» заявителя приклеилась бы к заявителю
 * набора. Поэтому почта строится из ключа заявки, телефона и реквизитов нет:
 * новый заявитель остаётся новым.
 */
export function applicationWithApplicant(
	form: ApplicationForm,
	externalId: string,
	revision: number,
	applicant: string
): Record<string, unknown> {
	const data = applicationTemplate(form, externalId, revision);
	const contact = data.contact as Record<string, unknown>;
	const email = `applicant-${externalId.replace(/[^0-9a-z-]/gi, '')}@example.org`;

	if (form === 'b2c') {
		const [lastName, firstName, ...rest] = applicant.split(/\s+/).filter((part) => part !== '');
		const middleName = rest.length === 0 ? null : rest.join(' ');

		data.applicant = { kind: 'individual', lastName, firstName, middleName };
		data.contact = { ...contact, lastName, firstName, middleName, email, phone: null };
	} else {
		data.applicant = {
			...(data.applicant as Record<string, unknown>),
			name: applicant,
			inn: null,
			ogrn: null
		};
		data.contact = { ...contact, email, phone: null };
	}

	return data;
}
