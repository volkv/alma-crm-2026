import { describe, expect, it } from 'vitest';
import { safeNextPath } from '$lib/server/auth/redirect';

describe('safeNextPath', () => {
	it('пропускает путь внутри приложения вместе с запросом', () => {
		expect(safeNextPath('/interactions')).toBe('/interactions');
		expect(safeNextPath('/organizations?page=2&sort=-name')).toBe(
			'/organizations?page=2&sort=-name'
		);
		expect(safeNextPath('/documents/11111111-2222-4333-8444-555555555555')).toBe(
			'/documents/11111111-2222-4333-8444-555555555555'
		);
	});

	it('отвергает адрес на чужой сайт', () => {
		expect(safeNextPath('https://evil.example/steal')).toBe('/');
		expect(safeNextPath('http://evil.example')).toBe('/');
		expect(safeNextPath('//evil.example/steal')).toBe('/');
		expect(safeNextPath('/\\evil.example')).toBe('/');
		expect(safeNextPath('javascript:alert(1)')).toBe('/');
	});

	it('отвергает относительный путь и управляющие символы', () => {
		expect(safeNextPath('interactions')).toBe('/');
		expect(safeNextPath('/interactions\nLocation: https://evil.example')).toBe('/');
		expect(safeNextPath('/interactions\r\nSet-Cookie: a=b')).toBe('/');
	});

	it('превращает отсутствие адреса в корень', () => {
		expect(safeNextPath(null)).toBe('/');
		expect(safeNextPath(undefined)).toBe('/');
		expect(safeNextPath('')).toBe('/');
	});
});
