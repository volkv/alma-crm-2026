import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Прежний адрес карты автоматизации: карта теперь живёт в статье справки. */
export const GET: RequestHandler = () => redirect(308, '/help/user/automation');
