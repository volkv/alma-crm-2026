import { describe, expect, it } from 'vitest';
import type { SettingValue } from '$lib/contracts/settings';
import { mfaRequired } from '$lib/server/auth/mfa';
import type { SessionUser } from '$lib/server/auth/types';

/**
 * Решение «нужен ли второй фактор» — чистое: политика, роль вошедшего и адрес,
 * с которого он пришёл. Всё остальное в модуле MFA — состояние, а это правило
 * читается и проверяется отдельно, потому что ошибка в нём означает либо
 * пропущенный вход без фактора, либо запертого снаружи администратора.
 */
function policy(over: Partial<SettingValue<'mfa_policy'>> = {}): SettingValue<'mfa_policy'> {
	return { requiredForRoles: ['admin'], remoteOnly: true, trustedNetworks: [], ...over };
}

function user(over: Partial<Pick<SessionUser, 'roleId' | 'isDemo'>> = {}) {
	return { roleId: 'admin', isDemo: false, ...over };
}

describe('политика второго фактора', () => {
	it('требует фактор от роли из списка и не требует от остальных', () => {
		expect(mfaRequired(policy(), user(), '198.51.100.7')).toBe(true);
		expect(mfaRequired(policy(), user({ roleId: 'manager' }), '198.51.100.7')).toBe(false);
		expect(
			mfaRequired(
				policy({ requiredForRoles: ['admin', 'manager'] }),
				user({ roleId: 'manager' }),
				'198.51.100.7'
			)
		).toBe(true);
	});

	it('пустой список ролей не требует фактор ни от кого', () => {
		expect(mfaRequired(policy({ requiredForRoles: [] }), user(), '198.51.100.7')).toBe(false);
	});

	it('не трогает демонстрационную сессию', () => {
		// Учётная запись демонстрации общая: фактор на ней отдал бы вход одному
		// телефону из всех, кто открыл стенд.
		expect(mfaRequired(policy(), user({ isDemo: true }), '198.51.100.7')).toBe(false);
		expect(mfaRequired(policy({ remoteOnly: false }), user({ isDemo: true }), '198.51.100.7')).toBe(
			false
		);
	});

	it('при `remoteOnly` не спрашивает код из доверенной сети и спрашивает снаружи', () => {
		const office = policy({ trustedNetworks: ['198.51.100.0/24', '2001:db8::/32'] });

		expect(mfaRequired(office, user(), '198.51.100.7')).toBe(false);
		expect(mfaRequired(office, user(), '2001:db8::1')).toBe(false);
		expect(mfaRequired(office, user(), '203.0.113.9')).toBe(true);
	});

	it('пустой список доверенных сетей делает удалённым любой адрес', () => {
		expect(mfaRequired(policy(), user(), '198.51.100.7')).toBe(true);
		expect(mfaRequired(policy(), user(), null)).toBe(true);
	});

	it('без `remoteOnly` требует фактор откуда угодно', () => {
		const always = policy({ remoteOnly: false, trustedNetworks: ['198.51.100.0/24'] });

		expect(mfaRequired(always, user(), '198.51.100.7')).toBe(true);
		expect(mfaRequired(always, user(), null)).toBe(true);
	});

	it('адрес, которого транспорт не знает, считается удалённым', () => {
		// Иначе спрятавший свой адрес получал бы доверенную сеть даром.
		const office = policy({ trustedNetworks: ['198.51.100.0/24'] });

		expect(mfaRequired(office, user(), null)).toBe(true);
		expect(mfaRequired(office, user(), 'unknown')).toBe(true);
	});
});
