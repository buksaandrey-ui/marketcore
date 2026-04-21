// ─── Общие демо-данные (используются в Dashboard, UnitEcon, SupplyForecast) ──

export type PromoSpend = {
  cpm: number          // реклама CPM
  cpc: number          // реклама CPC
  subscription: number // подписка на продвижение
  extra: number        // доп. услуги
}

export type SkuItem = {
  id: string
  name: string
  category: string
  orders: number       // кол-во заказов за месяц
  ordersSum: number    // сумма заказов ₽
  revenue: number      // выручка ₽ (после возвратов)
  promo: PromoSpend
  stock: number        // текущий остаток на складе
  ctr: number          // CTR %
  price: number        // цена продажи
  cogs: number         // себестоимость единицы
  weightKg: number     // вес в кг
  status: 'ok' | 'warn' | 'bad'
}

export const SKUS: SkuItem[] = [
  {
    id: '12345678', name: 'Кроссовки Nike Air Max 270 белые', category: 'Обувь',
    orders: 214, ordersSum: 1070000, revenue: 856000, stock: 43, ctr: 3.1,
    price: 5000, cogs: 1500, weightKg: 0.8, status: 'ok',
    promo: { cpm: 28000, cpc: 18000, subscription: 7000, extra: 9200 },
  },
  {
    id: '23456789', name: 'Футболка Adidas Originals мужская', category: 'Одежда',
    orders: 187, ordersSum: 467500, revenue: 374000, stock: 120, ctr: 2.8,
    price: 2500, cogs: 600, weightKg: 0.3, status: 'ok',
    promo: { cpm: 12000, cpc: 9400, subscription: 3500, extra: 2600 },
  },
  {
    id: '34567890', name: "Джинсы Levi's 501 синие", category: 'Одежда',
    orders: 95, ordersSum: 712500, revenue: 570000, stock: 8, ctr: 1.9,
    price: 7500, cogs: 2200, weightKg: 0.6, status: 'warn',
    promo: { cpm: 38000, cpc: 21000, subscription: 7000, extra: 11000 },
  },
  {
    id: '45678901', name: 'Куртка зимняя Columbia Omni-Heat', category: 'Одежда',
    orders: 62, ordersSum: 1162500, revenue: 930000, stock: 0, ctr: 1.4,
    price: 18750, cogs: 5500, weightKg: 1.2, status: 'bad',
    promo: { cpm: 72000, cpc: 44000, subscription: 14000, extra: 19000 },
  },
  {
    id: '56789012', name: 'Наушники Sony WH-1000XM5', category: 'Электроника',
    orders: 148, ordersSum: 1480000, revenue: 1184000, stock: 31, ctr: 4.2,
    price: 10000, cogs: 4200, weightKg: 0.4, status: 'ok',
    promo: { cpm: 24000, cpc: 16000, subscription: 7000, extra: 5000 },
  },
  {
    id: '67890123', name: 'Смартфон Samsung Galaxy A54', category: 'Электроника',
    orders: 203, ordersSum: 2537500, revenue: 2030000, stock: 17, ctr: 3.8,
    price: 12500, cogs: 6800, weightKg: 0.2, status: 'ok',
    promo: { cpm: 56000, cpc: 38000, subscription: 14000, extra: 12000 },
  },
  {
    id: '78901234', name: 'Платье летнее в горошек', category: 'Одежда',
    orders: 76, ordersSum: 285000, revenue: 228000, stock: 54, ctr: 2.1,
    price: 3750, cogs: 900, weightKg: 0.25, status: 'warn',
    promo: { cpm: 14000, cpc: 8000, subscription: 3500, extra: 4500 },
  },
  {
    id: '89012345', name: 'Рюкзак городской HIKE 30L серый', category: 'Аксессуары',
    orders: 119, ordersSum: 595000, revenue: 476000, stock: 22, ctr: 2.6,
    price: 5000, cogs: 1400, weightKg: 0.9, status: 'ok',
    promo: { cpm: 17000, cpc: 11000, subscription: 3500, extra: 3500 },
  },
  {
    id: '90123456', name: 'Крем для лица SPF50 увлажняющий', category: 'Красота',
    orders: 334, ordersSum: 626250, revenue: 501000, stock: 89, ctr: 5.1,
    price: 1875, cogs: 320, weightKg: 0.15, status: 'ok',
    promo: { cpm: 9000, cpc: 7000, subscription: 3500, extra: 2500 },
  },
  {
    id: '11223344', name: 'Кофе в зёрнах Lavazza 1кг', category: 'Еда',
    orders: 88, ordersSum: 330000, revenue: 264000, stock: 6, ctr: 2.0,
    price: 3750, cogs: 1100, weightKg: 1.0, status: 'warn',
    promo: { cpm: 16000, cpc: 10000, subscription: 3500, extra: 5500 },
  },
  {
    id: '22334455', name: 'Игрушка конструктор LEGO City', category: 'Игрушки',
    orders: 57, ordersSum: 570000, revenue: 456000, stock: 0, ctr: 1.6,
    price: 10000, cogs: 3800, weightKg: 1.5, status: 'bad',
    promo: { cpm: 34000, cpc: 22000, subscription: 7000, extra: 8000 },
  },
  {
    id: '33445566', name: 'Книга «Атомные привычки» Джеймс Клир', category: 'Книги',
    orders: 412, ordersSum: 772500, revenue: 618000, stock: 200, ctr: 6.2,
    price: 1875, cogs: 280, weightKg: 0.35, status: 'ok',
    promo: { cpm: 6000, cpc: 5000, subscription: 3500, extra: 1500 },
  },
  {
    id: '44556677', name: 'Кастрюля нержавеющая 5л Tefal', category: 'Дом',
    orders: 44, ordersSum: 330000, revenue: 264000, stock: 15, ctr: 1.3,
    price: 7500, cogs: 2100, weightKg: 2.2, status: 'warn',
    promo: { cpm: 18000, cpc: 12000, subscription: 3500, extra: 5500 },
  },
  {
    id: '55667788', name: 'Коврик для йоги 10мм TPE фиолетовый', category: 'Спорт',
    orders: 163, ordersSum: 407500, revenue: 326000, stock: 67, ctr: 3.4,
    price: 2500, cogs: 580, weightKg: 1.1, status: 'ok',
    promo: { cpm: 11000, cpc: 8000, subscription: 3500, extra: 3500 },
  },
  {
    id: '66778899', name: 'Протеин Optimum Nutrition Gold Standard', category: 'Спорт',
    orders: 91, ordersSum: 682500, revenue: 546000, stock: 3, ctr: 2.3,
    price: 7500, cogs: 2800, weightKg: 2.5, status: 'warn',
    promo: { cpm: 26000, cpc: 17000, subscription: 7000, extra: 8000 },
  },
]

// ─── Справочники ──────────────────────────────────────────────────────────────

export const CATEGORIES = [...new Set(SKUS.map(s => s.category))]

// Комиссии WB по категориям (%)
export const WB_COMMISSION: Record<string, number> = {
  'Обувь': 12, 'Одежда': 15, 'Аксессуары': 15,
  'Электроника': 10, 'Красота': 12, 'Еда': 10,
  'Спорт': 12, 'Дом': 12, 'Игрушки': 12, 'Книги': 8,
}

// Процент выкупа по категориям (%)
export const BUYOUT_RATE: Record<string, number> = {
  'Обувь': 55, 'Одежда': 40, 'Аксессуары': 70,
  'Электроника': 88, 'Красота': 80, 'Еда': 95,
  'Спорт': 75, 'Дом': 75, 'Игрушки': 85, 'Книги': 90,
}

// Стоимость логистики WB FBO по весу (₽)
export function wbLogistics(kg: number): number {
  if (kg <= 0.5) return 75
  if (kg <= 1)   return 105
  if (kg <= 3)   return 155
  if (kg <= 5)   return 210
  if (kg <= 10)  return 300
  return 450
}

// Сезонные коэффициенты по месяцам
export const SEASONAL_COEFF: Record<number, number> = {
  1: 0.70,  // Январь — спад после НГ
  2: 1.05,  // Февраль — 14 фев
  3: 1.30,  // Март — 8 марта
  4: 0.85,  // Апрель — затишье
  5: 0.95,  // Май
  6: 0.90,  // Июнь
  7: 0.85,  // Июль
  8: 0.95,  // Август
  9: 1.05,  // Сентябрь — back to school
  10: 1.10, // Октябрь
  11: 1.45, // Ноябрь — 11.11
  12: 1.35, // Декабрь — НГ-ажиотаж
}

export const totalSpend = (p: PromoSpend) =>
  p.cpm + p.cpc + p.subscription + p.extra
