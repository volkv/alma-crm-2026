-- Индексы под выборку отчёта. Поставлены после замера отклика: отчёт за
-- учебный год стоил 0,9–1,1 с, и всё это время — ожидание базы.
--
-- 1. `stage_entries_interaction_window_idx` обслуживает срез: по каждому
--    взаимодействию из выборки ищется запись, чьё окно накрывает момент `T`
--    (`entered_at < T` и `left_at is null or left_at >= T`), и тем же обращением
--    берётся момент закрытия записи. Порядок по входу обратный: нужная запись —
--    последняя из вошедших до `T`, поэтому она находится первой же строкой, а
--    `left_at` третьим столбцом отсекает не накрывшие, не заглядывая в таблицу.
--    Он заменяет `stage_entries_interaction_idx`: тот был его началом, и держать
--    оба значило бы платить за вторую запись при каждом переходе.
-- 2. `stage_entries_left_at_idx` обслуживает движение: события периода
--    отбираются по моменту ухода со стадии (`left_at >= начало и left_at < T`), а
--    прежний `stage_entries_window_idx` начинается со входа и такому диапазону
--    не годится. Второе слагаемое движения — начало работы — ищется по входу и
--    остаётся на нём.
-- 3. `stage_pauses_entry_idx` обслуживает вычитание пауз из срока стадии на
--    момент `T`: паузы читаются по записи целиком, а единственный индекс таблицы
--    был частичным (только открытые), и такому запросу не годился вовсе —
--    каждая строка среза стоила просмотра всей таблицы пауз.

DROP INDEX "stage_entries_interaction_idx";--> statement-breakpoint
CREATE INDEX "stage_entries_interaction_window_idx" ON "stage_entries" USING btree ("interaction_id","entered_at" DESC NULLS LAST,"left_at");--> statement-breakpoint
CREATE INDEX "stage_entries_left_at_idx" ON "stage_entries" USING btree ("left_at");--> statement-breakpoint
CREATE INDEX "stage_pauses_entry_idx" ON "stage_pauses" USING btree ("stage_entry_id","started_at");