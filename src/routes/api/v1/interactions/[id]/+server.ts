import { z } from 'zod';
import type { RequestHandler } from './$types';
import { id } from '$lib/contracts/common';
import { apiInteractionDetailSchema, toApiInteractionDetail } from '$lib/contracts/interactions';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getInteraction } from '$lib/server/interactions/read';
import { getInteractionStatus } from '$lib/server/stages/status';

const getInteractionEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	output: apiInteractionDetailSchema,
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/interactions/{id}',
	summary: 'Взаимодействие по идентификатору',
	description:
		'Карточка со сторонами, программами, продуктами и лентой стадий. Контактов людей здесь нет: ' +
		'их отдаёт только интерфейс, где маскирование делает сериализатор персональных данных. ' +
		'Запись вне области доступа владельца ключа отдаётся как 404, а не как 403.',
	tags: ['Взаимодействия'],
	config: getInteractionEndpoint,
	example: {
		id: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
		title: 'Переговоры с СПбПУ',
		status: 'active',
		ownerUserId: '9c8b7a65-4321-4098-b7a6-5c4d3e2f1a09',
		ownerName: 'Иванова Мария',
		institutionName: 'СПбПУ',
		customerName: null,
		stageKey: 'document_exchange',
		stageName: 'Обмен пакетом документов',
		stagePosition: 4,
		stageCategory: 'documents',
		dueAt: '2026-10-01T09:00:00.000Z',
		isOverdue: false,
		isPaused: false,
		isStale: false,
		openBlockers: 0,
		lastActivityAt: '2026-09-18T12:30:00.000Z',
		workspaceKey: 'b2b',
		workspaceName: 'Работа с ВУЗ',
		processRevision: 2,
		agreementPeriodStart: '2026-09-01',
		agreementPeriodEnd: '2027-06-30',
		academicPeriodStart: null,
		academicPeriodEnd: null,
		parties: [
			{
				organizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
				organizationName: 'СПбПУ',
				partyRole: 'educational_institution',
				isPrimary: true
			}
		],
		programs: [
			{
				programId: '5c1a8f3e-1b2c-4d5e-8f90-1a2b3c4d5e6f',
				code: 'PRG-09.03.01',
				name: 'Информатика и вычислительная техника'
			}
		],
		products: [
			{
				productId: '7b2c9a41-3d4e-4f50-9a1b-2c3d4e5f6a7b',
				code: 'PRD-CLOUD',
				name: 'Облачная платформа'
			}
		],
		contract: {
			id: '6c8f1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
			number: 'РТК-2026/14',
			status: 'active',
			signedOn: '2026-02-01',
			validUntil: '2027-01-31',
			items: [
				{
					id: '9d0e1f2a-3b4c-4d5e-8f60-1a2b3c4d5e6f',
					productId: '7b2c9a41-3d4e-4f50-9a1b-2c3d4e5f6a7b',
					code: 'PRD-CLOUD',
					name: 'Облачная платформа',
					licenseSignedAt: '2026-02-10',
					licenseUntil: '2027-02-09',
					transferStatus: 'передан вузу'
				}
			]
		},
		progress: [
			{
				key: 'contact_search',
				name: 'Поиск контактных лиц',
				position: 1,
				category: 'contact',
				state: 'done'
			},
			{
				key: 'document_exchange',
				name: 'Обмен пакетом документов',
				position: 4,
				category: 'documents',
				state: 'current'
			}
		],
		externalSource: 'cms',
		externalId: 'site-2026-000123',
		createdAt: '2026-09-01T08:00:00.000Z',
		updatedAt: '2026-09-18T12:30:00.000Z'
	}
});

export const GET: RequestHandler = apiHandler(getInteractionEndpoint, async (ctx, { params }) => {
	const [interaction, status] = await Promise.all([
		getInteraction(ctx, params.id),
		getInteractionStatus(ctx, params.id)
	]);

	return toApiInteractionDetail(interaction, status, {
		isStale: status.isStale,
		openBlockers: status.blockers.filter((blocker) => blocker.resolvedAt === null).length
	});
});
