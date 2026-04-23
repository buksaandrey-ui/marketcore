/**
 * BotHistoryPage — «📋 История бота».
 *
 * Показывает последние 50 записей из таблицы rule_executions:
 * что автобот посчитал каждые 15 минут для каждого расписания,
 * в каком режиме (dry_run / live) и почему.
 *
 * Неделя 1: здесь только dry-run — бот ЕЩЁ ничего не пишет на WB/Ozon.
 * Неделя 2: появятся строки со status=applied (реально применено).
 */
import { useEffect, useState } from 'react'
import { biddingExecutionsApi, type BotExecution } from '../api'

const STATUS_LABEL: Record<BotExecution['status'], { text: string; color: string }> = {
  computed: { text: 'Посчитано', color: '#3b82f6' },
  applied:  { text: 'Применено', color: '#10b981' },
  skipped:  { text: 'Пропуск',   color: '#9ca3af' },
  failed:   { text: 'Ошибка',    color: '#ef4444' },
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export function BotHistoryPage() {
  const [rows, setRows] = useState<BotExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    setLoading(true)
    setError(null)
    biddingExecutionsApi.list(100)
      .then(setRows)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // автообновление раз в минуту — тик бота раз в 15 мин, но лог может расти
    const t = setInterval(reload, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>📋 История бота</h1>
        <button
          onClick={reload}
          style={{
            background: '#f3f4f6', border: '1px solid #d1d5db',
            borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
          }}
        >
          🔄 Обновить
        </button>
      </div>

      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe',
        borderRadius: 8, padding: '10px 14px', marginBottom: 16,
        fontSize: 13, color: '#1e3a8a',
      }}>
        ℹ️ Бот проходит по всем расписаниям каждые 15 минут и записывает сюда,
        какая ставка ДОЛЖНА быть СЕЙЧАС. Пока это только расчёт (dry-run) —
        реальной записи на WB/Ozon ещё нет.
      </div>

      {loading && <div style={{ color: '#6b7280' }}>Загружаем…</div>}
      {error && (
        <div style={{ color: '#b91c1c', background: '#fee2e2', padding: 10, borderRadius: 6 }}>
          Ошибка: {error}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ color: '#6b7280', padding: 24, textAlign: 'center', background: '#f9fafb', borderRadius: 8 }}>
          Бот ещё ничего не успел посчитать. Первая запись появится в течение 15 минут
          после запуска — если у вас есть хотя бы одно сохранённое расписание.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#f9fafb' }}>
              <tr>
                {['Время', 'Площадка', 'Режим', 'База', '×%', 'Итог ₽', 'Статус', 'Причина'].map((h) => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '10px 12px', borderBottom: '1px solid #e5e7eb',
                    fontWeight: 600, color: '#374151',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS_LABEL[r.status]
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 12px', color: '#374151', whiteSpace: 'nowrap' }}>{formatTime(r.computed_at)}</td>
                    <td style={{ padding: '8px 12px' }}>{r.platform.toUpperCase()}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{
                        fontSize: 11, padding: '2px 6px', borderRadius: 4,
                        background: r.mode === 'live' ? '#dcfce7' : '#f3f4f6',
                        color: r.mode === 'live' ? '#166534' : '#6b7280',
                      }}>
                        {r.mode === 'live' ? 'live' : 'dry-run'}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>{r.base_cpm}</td>
                    <td style={{ padding: '8px 12px' }}>{r.multiplier_pct}%</td>
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>{r.target_cpm}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ color: st.color, fontWeight: 600 }}>{st.text}</span>
                    </td>
                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{r.reason}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
