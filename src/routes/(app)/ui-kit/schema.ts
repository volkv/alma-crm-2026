import { z } from 'zod';
import { REGIONS } from './showcase-data';

/**
 * The schema behind the form on the kit page. It lives with the page, not in
 * the shared validation module: it exists to show what a form looks like, and
 * the real organisation schema belongs to the section that owns organisations.
 *
 * Every message is the sentence the user should read — the field says what to
 * do about it, not what a validator is called.
 */
export const showcaseOrganizationSchema = z.object({
	name: z
		.string({ error: 'Укажите название организации' })
		.trim()
		.min(3, { error: 'Название не короче трёх символов' })
		.max(200, { error: 'Название не длиннее 200 символов' }),
	shortName: z
		.string()
		.trim()
		.max(30, { error: 'Краткое название не длиннее 30 символов' })
		.default(''),
	region: z.enum(REGIONS, { error: 'Выберите регион из списка' }),
	site: z.url({ error: 'Адрес сайта начинается с http:// или https://' }),
	email: z.email({ error: 'Проверьте адрес электронной почты' }),
	comment: z.string().trim().max(500, { error: 'Комментарий не длиннее 500 символов' }).default(''),
	/**
	 * Дата в форме — всегда календарный день `2026-09-12`: так её пишет схема,
	 * так её хранит база, и так её отдаёт `FieldDate`, что бы человек ни набрал
	 * в поле.
	 */
	agreedOn: z.iso
		.date({ error: 'Дата в виде дд.мм.гггг' })
		.nullable()
		.default(null)
		.describe('День подписания')
});

export type ShowcaseOrganizationInput = z.input<typeof showcaseOrganizationSchema>;
