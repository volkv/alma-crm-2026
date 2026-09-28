/**
 * Шаблон письма «информация о программах»: то, что уходит в чужой почтовый
 * ящик из справочника, — текст, а не разметка.
 */
import { describe, expect, it } from 'vitest';
import { programOfferEmail, type ProgramOfferFacts } from '$lib/server/mail/program-offer';

const FACTS: ProgramOfferFacts = {
	institutionName: 'МГТУ им. Н. Э. Баумана',
	interactionTitle: 'Партнёрство 2026',
	recipientName: 'Мария Ивановна',
	programs: [
		{
			code: 'DEV-01',
			name: 'Разработка на Go',
			levelLabel: 'Повышение квалификации',
			description: 'Первая строка\nвторая <script>alert(1)</script>\n\nНовый абзац',
			versionSummary: '72 часа, очно',
			materials: [{ fileName: 'Описание & план.pdf', sizeBytes: 2048 }]
		}
	],
	products: [{ name: 'Стажировка', description: null }],
	sender: { name: 'Пётр Сидоров', email: 'p.sidorov@example.org', position: 'Менеджер' },
	isTest: false
};

describe('письмо о программах', () => {
	it('экранирует текст из справочника', () => {
		const { html, text } = programOfferEmail(FACTS);

		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('Описание &amp; план.pdf');
		// В текстовой версии разметки нет, и экранировать там нечего.
		expect(text).toContain('<script>alert(1)</script>');
	});

	it('переводы строк описания становятся переносами и абзацами', () => {
		const { html } = programOfferEmail(FACTS);

		expect(html).toContain('Первая строка<br>вторая');
		expect(html).toMatch(/<\/p><p[^>]*>Новый абзац<\/p>/);
	});

	it('тестовое письмо помечено в теме и в теле', () => {
		const test = programOfferEmail({ ...FACTS, isTest: true });

		expect(test.subject).toMatch(/^\[Тест\] /);
		expect(test.html).toContain('Тестовое письмо');
		expect(test.text).toContain('Тестовое письмо');
		expect(programOfferEmail(FACTS).subject).not.toContain('[Тест]');
	});

	it('без имени адресата здоровается без имени', () => {
		expect(programOfferEmail({ ...FACTS, recipientName: null }).text).toMatch(/^Здравствуйте!/);
		expect(programOfferEmail(FACTS).text).toMatch(/^Здравствуйте, Мария Ивановна!/);
	});
});
