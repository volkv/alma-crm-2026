import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '$lib/server/auth/types';

const { config } = vi.hoisted(() => ({ config: { ORIGIN: 'https://crm.example.org' } }));

vi.mock('$lib/server/config', () => ({ getConfig: () => config }));

const { securityHeaders } = await import('$lib/server/hooks/security-headers');

const demoUser: SessionUser = {
	id: 'b0b4b0de-0000-4000-8000-000000000001',
	email: 'demo@example.org',
	fullName: 'Демо Пользователь',
	roleId: 'manager',
	permissions: new Set(['interactions.read']),
	isDemo: true,
	scope: { kind: 'all' }
};

/**
 * A hook only ever touches `locals` and the response, so the rest of the event
 * is irrelevant here — building a whole `RequestEvent` would test the fixture,
 * not the hook.
 */
function runWith(user: SessionUser | null): Promise<Response> {
	const event = { locals: { requestId: 'test', user, apiKey: null } } as RequestEvent;

	return Promise.resolve(securityHeaders({ event, resolve: () => new Response('page') }));
}

describe('securityHeaders', () => {
	beforeEach(() => {
		config.ORIGIN = 'https://crm.example.org';
	});

	it('sets the headers that must be on every response', async () => {
		const response = await runWith(null);

		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
		expect(response.headers.get('Permissions-Policy')).toContain('microphone=()');
		expect(response.headers.get('Permissions-Policy')).toContain('geolocation=()');
	});

	it('sends HSTS when the origin is https', async () => {
		const response = await runWith(null);

		expect(response.headers.get('Strict-Transport-Security')).toBe(
			'max-age=31536000; includeSubDomains'
		);
	});

	it('omits HSTS when the origin is plain http', async () => {
		config.ORIGIN = 'http://localhost:5173';

		const response = await runWith(null);

		expect(response.headers.get('Strict-Transport-Security')).toBeNull();
	});

	it('forbids caching a response rendered for a signed-in user', async () => {
		const response = await runWith(demoUser);

		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('leaves caching alone for an anonymous request', async () => {
		const response = await runWith(null);

		expect(response.headers.get('Cache-Control')).toBeNull();
	});
});
