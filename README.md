<p align="center">
  <img src="docs/media/banner.svg" alt="Альма CRM — система контроля взаимодействия с учебными заведениями" width="100%">
</p>

<p align="center">
  <a href="https://alma.volkv.com"><img src="docs/media/cta-demo.svg" alt="Открыть демо-стенд alma.volkv.com" height="64"></a>
  &nbsp;
  <a href="https://alma.volkv.com/api/docs"><img src="docs/media/cta-api.svg" alt="Документация API" height="64"></a>
</p>

<p align="center">
  <a href="https://alma.volkv.com/video-presentation.mp4"><b>Видеопрезентация</b></a> ·
  <a href="https://alma.volkv.com/presentation.pdf"><b>Презентация (PDF)</b></a> ·
  <a href="https://alma.volkv.com"><b>Стенд</b></a> ·
  <a href="https://alma.volkv.com/api/docs"><b>API</b></a> ·
  <a href="https://alma.volkv.com/help"><b>Справка</b></a>
</p>

# Альма CRM

CRM ИТ Школы Ростелекома для работы с вузами, колледжами и школами — от первого контакта с вузом до
подтверждённого результата. Весь процесс, 14 шагов, идёт по единому стандарту, на каждом этапе система
берёт рутину на себя, а в отчётах каждое число проверяемо: от него есть путь до исходной карточки.
Заявка с сайта — второй вход в тот же процесс. Обмен с сайтом и системой обучения показан на
имитаторах по опубликованному контракту.

Решение команды **Wine Coding Team** для хакатона «Лидеры цифровой трансформации 2026», задача
«Система контроля взаимодействия с учебными заведениями».

## Демо-стенд

- **[alma.volkv.com](https://alma.volkv.com)** — три роли: `manager`, `lead`, `admin`; пароль указан на странице входа, роль выбирается кнопкой.
- [/api/docs](https://alma.volkv.com/api/docs) — Swagger UI по OpenAPI 3.1.
- [/help](https://alma.volkv.com/help) — руководства пользователя и администратора внутри системы.
- [/mock-cms/](https://alma.volkv.com/mock-cms/) · [/mock-lms/](https://alma.volkv.com/mock-lms/) — имитаторы сайта и системы обучения: отсюда запускается обмен.

## Ключевые возможности

- **Процесс без программиста** — стадии, чек-листы и нормативы меняет руководитель: черновик, предпросмотр, перенос дел.
- **Сквозная автоматизация** — заявка с сайта становится делом сама, группа заводится в системе обучения и возвращается результатами.
- **Карточка дела** — что происходит, что мешает, кто должен, что можно сделать сейчас; доска по стадиям.
- **Чат дела** — обсуждение прямо в карточке, коллег зовут через «@».
- **Встречи** — приглашение в календарь письмом и файлом .ics, повестка по чек-листу стадии.
- **Документы по шаблонам** — договоры и письма собираются из данных дела, с редакциями и хранением.
- **«Мой день»** — просрочки, сроки, помехи и новые заявки одной сводкой каждому сотруднику.
- **Роли и вход через Keycloak** — три роли, область доступа по назначениям.
- **Отчёты XLSX и PDF** — срез и движение за период, диаграммы, переход от числа к записям.
- **Справочники и импорт таблицей** — вузы, договоры, лицензии, ответственные; паспорт вуза из ЕГРЮЛ.
- **Публичный API** — OpenAPI 3.1, ключи, лимиты, идемпотентность.
- **Безопасность** — шифрование почты и телефона в базе, журнал действий, SBOM и сканирование зависимостей.

Подробнее — в [подробном описании](docs/product.md).

## Быстрый запуск

Нужны Docker 25+ с плагином Compose.

```bash
git clone https://github.com/volkv/alma-crm-2026.git && cd alma-crm-2026
docker compose up --build
```

Поднимаются приложение, PostgreSQL, Redis, Keycloak, Gotenberg, SeaweedFS и два имитатора систем
заказчика. Миграции применяются автоматически, демонстрационные данные заливаются при первом старте.

- http://localhost:3000 — приложение, http://localhost:3000/api/docs — Swagger UI;
- http://localhost:58081 — имитатор сайта, http://localhost:58082 — имитатор системы обучения;
- http://localhost:58080/admin — Keycloak.

Пустая база без демонстрационных записей: `DEMO_MODE=false docker compose up --build`.
Остановить и удалить данные: `docker compose down -v`. Запуск для разработки — в [`docs/development.md`](docs/development.md).

## Документация

| Документ                                                 | О чём                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| [`docs/product.md`](docs/product.md)                     | подробное описание: сцены показа, роли, устройство, ограничения      |
| [`docs/requirements.md`](docs/requirements.md)           | матрица требований: где реализовано, чем проверено, чего не хватает  |
| [`docs/architecture.md`](docs/architecture.md)           | путь запроса, владельцы модулей, границы транзакций, масштабирование |
| [`docs/workflow.md`](docs/workflow.md)                   | правила процесса: стадии, переходы, редакции                         |
| [`docs/automation-map.md`](docs/automation-map.md)       | карта автоматизации: 14 шагов процесса и что делает система          |
| [`docs/access-matrix.md`](docs/access-matrix.md)         | роли, права и что видит каждая роль                                  |
| [`docs/exchange-contract.md`](docs/exchange-contract.md) | контракт обмена с сайтом и системой обучения                         |
| [`docs/reports.md`](docs/reports.md)                     | семантика отчётов, инварианты чисел, форматы выгрузки                |
| [`docs/api.md`](docs/api.md)                             | публичный API: ключи, лимиты, идемпотентность, ошибки                |
| [`docs/security.md`](docs/security.md)                   | меры защиты по 152-ФЗ и приказу № 117, сканеры, SBOM                 |
| [`docs/performance.md`](docs/performance.md)             | отклик и нагрузка: как мерили, что вышло                             |
| [`docs/deployment.md`](docs/deployment.md)               | развёртывание на сервере за обратным прокси                          |
| [`docs/development.md`](docs/development.md)             | окружение, скрипты, структура, тесты                                 |
| [`docs/data-model.md`](docs/data-model.md)               | схема базы, контракты, вызов сервисов                                |
| [`docs/why-sveltekit.md`](docs/why-sveltekit.md)         | обоснование стека                                                    |
| [`docs/libraries.md`](docs/libraries.md)                 | перечень библиотек: версии, лицензии                                 |

Остальные документы лежат рядом, в [`docs/`](docs/). Документацию одним PDF собирает `pnpm run docs:pdf`.

## Стек

SvelteKit 2 · Svelte 5 · TypeScript · Tailwind CSS 4 · PostgreSQL 17 · Redis · Keycloak (OIDC) · Gotenberg · SeaweedFS · Docker Compose.

## Команда

<table>
  <tr>
    <td width="200" align="center" valign="middle">
      <img src="docs/media/team-logo.jpg" alt="Wine Coding Team" width="180">
    </td>
    <td valign="middle">
      <b>Wine Coding Team</b><br><br>
      <b>Павел Волков</b> — капитан, разработка<br>
      <b>Роман Науменко</b> — разработка<br><br>
      Хакатон «Лидеры цифровой трансформации 2026» · направление «Бизнес» · задача от ИТ Школы Ростелекома (ООО «РТК ИТ»).
    </td>
  </tr>
</table>

## Лицензия

[MIT](LICENSE).
