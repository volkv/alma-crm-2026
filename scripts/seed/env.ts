/**
 * То, чем оказывается `$env/dynamic/private` за пределами сборки: переменные
 * процесса как они есть. Модуль существует ради одного импорта — `config.ts`
 * читает окружение через специю SvelteKit, а сид запускается обычным Node,
 * где такого модуля нет.
 */
export const env: Record<string, string | undefined> = process.env;
