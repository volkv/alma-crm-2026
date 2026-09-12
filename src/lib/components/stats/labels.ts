/**
 * Как состояние снимка выглядит на экране.
 *
 * Названия состояний живут в контрактах — они едут и в выгрузки, и в журнал, —
 * а цвет это уже интерфейс, и он выбирается по смыслу: «проверен» подсвечен
 * как требующий внимания, потому что снимок ждёт решения человека, а не
 * потому, что с ним что-то не так.
 */
import type { StatusTone } from '$lib/components/status-badge.svelte';
import type { StatSnapshotStatus } from '$lib/contracts/stats';
import { formatNumber } from '$lib/format';

export const STAT_SNAPSHOT_STATUS_TONES: Record<StatSnapshotStatus, StatusTone> = {
	uploading: 'neutral',
	mapped: 'info',
	validated: 'warning',
	confirmed: 'success',
	rejected: 'danger'
};

/**
 * Число показателя на экране. Прочерк означает «данных нет», а ноль — что ноль
 * кто-то записал: показывать одно вместо другого нельзя.
 */
export function measureText(value: number | null): string {
	return value === null ? '—' : formatNumber(value);
}
