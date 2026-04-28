import { useEffect, useState } from 'react'
import { biddingExecutionsApi, schedulesApi, type BotExecution } from '../api'

const STATUS_LABEL: Record<BotExecution['status'], { text: string; color: string }> = {
  computed: { text: 'Тест — не применено', color: '#6b7280' },
  applied:  { text: 'Применено',           color: '#10b981' },
  skipped:  { text: 'Пропуск',             color: '#9ca3af' },
  failed:   { text: 'Ошибка',              color: '#ef4444' },
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

// Простой inline-модал для подтверждений
function ConfirmModal({
  message, onOk, onCancel,
}: { message: string; onOk: () => void; onCancel: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: 28, maxWidth: 420,
        width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ fontSize: 15, color: '#1f2937', lineHeight: 1.6, marginBottom: 24, whiteSpace: 'pre-line' }}>
          {message}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6,
            padding: '7px 16px', cursor: 'pointer', fontSize: 14, color: '#374151',
          }}>
            Отмена
          </button>
          <button onClick={onOk} style={{
            background: '#dc2626', border: 'none', borderRadius: 6,
            padding: '7px 18px', cursor: 'pointer', fontSize: 14,
            color: '#fff', fontWeight: 700,
          }}>
            Остановить
          </button>
        </div>
      </div>
    </div>
  )
}

export function BotHistoryPage() {
  const [rows, setRows] = useState<BotExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [killLoading, setKillLoading] = useState(false)
  const [killResult, setKillResult] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  const handleKillSwitch = async () => {
    setShowConfirm(false)
    setKillLoading(true)
    setKillResult(null)
    try {
      const schedules = await schedulesApi.list()
      for (const s of schedules) {
        const json = { ...(s.schedule_json as Record<string, unknown>), dryRun: true }
        await schedulesApi.update(s.id, s.name, json)
      }
      setKillResult(`✅ Готово! ${schedules.length} расписаний переведено в тестовый режим.`)
    } catch (e) {
      setKillResult(`❌ Ошибка: ${e}`)
    } finally {
      setKillLoading(false)
    }
  }

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
    const t = setInterval(reload, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>

      {showConfirm && (
        <ConfirmModal
          message={'🛑 Остановить всех ботов?\n\nВсе расписания будут переведены в тестовый режим (dry-run).\nРеальных изменений ставок на WB/Ozon больше не будет.'}
          onOk={handleKillSwitch}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>История бота</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={killLoading}
            style={{
              background: '#fee2e2', border: '1px solid #fca5a5',
              borderRadius: 6, padding: '6px 14px', cursor: 'pointer',
              fontSize: 13, color: '#b91c1c', fontWeight: 600,
            }}
            title="Перевести все расписания в тестовый режим — бот перестанет менять ставки на WB/Ozon"
          >
            {killLoading ? '⏳' : '🛑'} Стоп всех ботов
          </button>
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
      </div>

      {killResult && (
        <div style={{
          background: killResult.startsWith('✅') ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${killResult.startsWith('✅') ? '#bbf7d0' : '#fecaca'}`,
          borderRadius: 8, padding: '10px 14px', marginBottom: 14,
          fontSize: 13, color: killResult.startsWith('✅') ? '#166534' : '#b91c1c',
        }}>
          {killResult}
        </div>
      )}

      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe',
        borderRadius: 8, padding: '10px 14px', marginBottom: 16,
        fontSize: 13, color: '#1e3a8a',
      }}>
        Бот проходит по всем расписаниям каждые 15 минут и записывает сюда,
        какая ставка должна быть сейчас. Статус <strong>«Тест — не применено»</strong> — это расчёт
        без реальной отправки на WB/Ozon. <strong>«Применено»</strong> — ставка реально изменена.
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
                        {r.mode === 'live' ? 'Боевой' : 'Тестовый'}
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
