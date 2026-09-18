/**
 * Ключ кэша карточки взаимодействия.
 *
 * Проверка без Redis намеренно: правило здесь — состав ключа, а не работа
 * хранилища. Отвечает оно за выкат: собранное прежним кодом обязано перестать
 * находиться, как только форма кэшируемого объекта изменилась, — иначе минуту
 * после обновления карточка получает часть без нового поля и падает на нём.
 */
import { describe, expect, it } from 'vitest';
import { interactionCardKey } from '$lib/server/cache/interactions';

const INTERACTION = {
	id: '11111111-1111-4111-8111-111111111111',
	lastActivityAt: new Date('2026-09-18T07:00:00.000Z')
};

describe('ключ части карточки', () => {
	it('несёт версию состава, поколение области, запись, момент события и часть', () => {
		expect(interactionCardKey(2, '0', INTERACTION, 'base')).toBe(
			`2:0:${INTERACTION.id}:2026-09-18T07:00:00.000Z:base`
		);
	});

	it('после смены версии состава прежнее уже не находится', () => {
		expect(interactionCardKey(3, '0', INTERACTION, 'base')).not.toBe(
			interactionCardKey(2, '0', INTERACTION, 'base')
		);
	});

	it('разводит части, записи и поколения области', () => {
		const base = interactionCardKey(2, '0', INTERACTION, 'base');

		expect(interactionCardKey(2, '0', INTERACTION, 'comments')).not.toBe(base);
		expect(interactionCardKey(2, '1', INTERACTION, 'base')).not.toBe(base);
		expect(
			interactionCardKey(
				2,
				'0',
				{ ...INTERACTION, lastActivityAt: new Date('2026-09-18T07:00:01.000Z') },
				'base'
			)
		).not.toBe(base);
	});
});
