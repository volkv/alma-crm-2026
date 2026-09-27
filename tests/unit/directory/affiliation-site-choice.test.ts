/**
 * Роль из карточки организации «Без площадки»: список формы отправляет строку
 * «ничего не выбрано» скрытым полем, и сервер обязан прочитать её как `null`,
 * а не отказать неверным идентификатором.
 */
import { describe, expect, it } from 'vitest';
import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { NO_OPTION } from '$lib/contracts/common';
import { createAffiliationSchema, createProductSchema } from '$lib/contracts/directory';

const PERSON = '7d0a4c9e-3b2f-4e61-9a55-0c1f2e3d4b5a';
const ORGANIZATION = '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const SITE = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

function affiliationForm(siteId: string): FormData {
	const form = new FormData();
	form.set('personId', PERSON);
	form.set('organizationId', ORGANIZATION);
	form.set('siteId', siteId);
	form.set('position', 'Проректор');
	form.set('roleKind', 'coordinator');
	form.set('validFrom', '2026-09-28');
	return form;
}

describe('площадка роли из обычной формы', () => {
	it('«Без площадки» — это null', async () => {
		const form = await superValidate(affiliationForm(NO_OPTION), zod4(createAffiliationSchema));

		expect(form.valid).toBe(true);
		expect(form.data.siteId).toBeNull();
	});

	it('выбранная площадка проходит как есть, мусор отказывает', async () => {
		const chosen = await superValidate(affiliationForm(SITE), zod4(createAffiliationSchema));
		const broken = await superValidate(affiliationForm('abc'), zod4(createAffiliationSchema));

		expect(chosen.data.siteId).toBe(SITE);
		expect(broken.valid).toBe(false);
		expect(broken.errors.siteId).toEqual(['Некорректный идентификатор площадки']);
	});

	it('поставщик продукта «Не указан» — тоже null', () => {
		const parsed = createProductSchema.shape.vendorOrganizationId.parse(NO_OPTION);

		expect(parsed).toBeNull();
	});
});
