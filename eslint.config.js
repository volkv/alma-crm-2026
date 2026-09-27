import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			// A leading underscore marks a binding that exists only to be discarded
			// (rest-destructuring, ignored callback arguments, ignored catch bindings).
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
					ignoreRestSiblings: true
				}
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		// Primitives vendored from shadcn-svelte. They take `href` as a prop and
		// render it as-is, so there is nothing here to resolve — the rule still
		// applies at the call sites in our own routes and components.
		files: ['src/lib/components/ui/**'],
		rules: { 'svelte/no-navigation-without-resolve': 'off' }
	},
	{
		// Граница модуля: модуль видит ядро только через фасад платформы
		// ($lib/platform/**) и общий словарь контрактов ($lib/contracts/**), плюс
		// вендоренную дизайн-систему. Прямой доступ к остальному ядру — сервисам,
		// схеме БД, конкретным фичам ($lib/server/**, $lib/components/<фича>/**) —
		// и к src/routes сделал бы модуль неотделимым: его нельзя было бы
		// подключить, отключить или поставить отдельно. То же самое (плюс проверка
		// «чистой цепочки») проверяет tests/unit/platform/boundary.test.ts.
		files: ['src/modules/**'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							// Отрицания следуют правилам .gitignore (пакет `ignore`, на котором
							// работает no-restricted-imports): чтобы открыть вложенный путь, надо
							// явно открыть и промежуточные каталоги — иначе они остаются закрыты
							// правилом $lib/**. Поэтому у $lib/components/ui и $lib/components/form
							// есть и голый путь, и его /** — без голого $lib/components ни один из
							// них бы не открылся (проверено пакетом напрямую).
							group: [
								'$lib/**',
								'!$lib/platform',
								'!$lib/platform/**',
								'!$lib/contracts',
								'!$lib/contracts/**',
								'!$lib/components',
								'!$lib/components/ui',
								'!$lib/components/ui/**',
								'!$lib/components/*.svelte',
								'!$lib/components/form',
								'!$lib/components/form/**',
								'!$lib/format',
								'!$lib/utils',
								'!$lib/icon'
							],
							message:
								'Модулю доступны только $lib/platform/** (фасад ядра), $lib/contracts/** (общий словарь), дизайн-система ($lib/components/ui/**, $lib/components/*.svelte, $lib/components/form/**), $lib/format, $lib/utils, $lib/icon. Остальное ядро, включая $lib/server/**, — только через $lib/platform.'
						},
						{
							group: ['**/routes/**'],
							message:
								'Модуль не импортирует src/routes напрямую — страницы модуля собирает диспетчер ядра (src/routes/(app)/w/[workspace]/m/[module]).'
						},
						{
							// Каталог панелей строится из реестра, реестр читает конфиг, а конфиг —
							// манифесты модулей: импорт каталога из модуля замкнул бы этот круг.
							group: ['$lib/contracts/process-card'],
							message:
								'Модуль не импортирует $lib/contracts/process-card: каталог собирается из манифестов, и импорт замкнул бы цикл. Ключи своих панелей модуль знает из собственного манифеста.'
						}
					]
				}
			]
		}
	},
	{
		// Обратная сторона границы: ядро не знает о существовании модулей и об
		// установке (crm.config) — иначе сборка и типы ядра зависели бы от того,
		// какие модули подключены. Единственное исключение — реестры платформы,
		// которые и обязаны прочитать конфиг и подключить модули.
		files: ['src/lib/**', 'src/routes/**', 'src/hooks*.ts'],
		ignores: ['src/lib/platform/*registry*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/modules/**', '**/crm.config*'],
							message:
								'Ядро не импортирует модули и crm.config — это делает только реестр платформы (src/lib/platform/*registry*.ts).'
						}
					]
				}
			]
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
