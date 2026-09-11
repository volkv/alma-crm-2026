import { describe, expect, it } from 'vitest';
import { hideServiceAddresses } from '$lib/server/documents/errors';

describe('текст ошибки службы конвертации', () => {
	it('не оставляет в сообщении внутренних адресов', () => {
		const raw =
			'{"message":"LibreOffice: connection refused at http://gotenberg:3000/forms/libreoffice/convert"}';

		const shown = hideServiceAddresses(raw, 'http://gotenberg:3000');

		expect(shown).not.toContain('gotenberg');
		expect(shown).not.toContain('3000');
		expect(shown).toContain('LibreOffice');
	});

	it('вырезает и адрес без схемы, и посторонние ссылки', () => {
		const shown = hideServiceAddresses(
			'upstream 10.0.0.5:3000 failed, see https://gotenberg.dev/docs',
			'http://10.0.0.5:3000'
		);

		expect(shown).toBe('upstream [служба конвертации] failed, see [служба конвертации]');
	});

	it('сжимает многострочный ответ и обрезает слишком длинный', () => {
		expect(hideServiceAddresses('первая\n\nвторая  строка', 'http://localhost:3001')).toBe(
			'первая вторая строка'
		);
		expect(hideServiceAddresses('я'.repeat(500), 'http://localhost:3001')).toHaveLength(300);
	});
});
