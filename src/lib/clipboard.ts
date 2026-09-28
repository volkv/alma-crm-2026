import { toast } from 'svelte-sonner';

/**
 * Копирует текст в буфер обмена и говорит, получилось ли. Современный буфер
 * есть не везде (стенд по http, окно без фокуса) — тогда пробуем старый путь
 * через выделение; не вышло и так — честно говорим, а не молчим.
 */
export async function copyText(text: string, success: string): Promise<void> {
	if (await writeClipboard(text)) toast.success(success);
	else toast.error('Скопировать не удалось — выделите текст и скопируйте вручную');
}

async function writeClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return copyBySelection(text);
	}
}

function copyBySelection(text: string): boolean {
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.append(area);
	area.select();

	try {
		// Устаревший, но единственный путь там, где navigator.clipboard закрыт.
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		area.remove();
	}
}
