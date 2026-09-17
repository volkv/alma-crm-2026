/**
 * Виды документа против словаря названий.
 *
 * Вид едет в `documents.kind` кодом, а на экран выходит словом
 * (`documentKindLabel`). Код, который ставит само приложение, обязан быть в
 * словаре: иначе в карточке документа и в списке вместо вида появляется
 * «stage_attachment» — так и было с вложением к переходу. Вид, названный
 * человеком до появления справочника, остаётся как записан: сочинять за него
 * название значит показывать не то, что лежит в базе.
 */
import { describe, expect, it } from 'vitest';
import {
	documentKindLabel,
	DOCUMENT_KIND_LABELS,
	GENERATED_DOCUMENT_KIND,
	STAGE_ATTACHMENT_DOCUMENT_KIND,
	UPLOADED_DOCUMENT_KINDS
} from '$lib/contracts/documents';

describe('названия видов документа', () => {
	it('есть у каждого вида, который выбирает человек', () => {
		for (const kind of UPLOADED_DOCUMENT_KINDS) {
			expect(DOCUMENT_KIND_LABELS[kind]).toBeTruthy();
		}
	});

	it('есть у каждого вида, который ставит приложение', () => {
		expect(documentKindLabel(GENERATED_DOCUMENT_KIND)).toBe('Собран по шаблону');
		expect(documentKindLabel(STAGE_ATTACHMENT_DOCUMENT_KIND)).toBe('Вложение к переходу');
	});

	it('незнакомый код печатается как записан', () => {
		expect(documentKindLabel('protocol_1998')).toBe('protocol_1998');
	});
});
