"""Federal District (ФО) mappings for warehouses and regions.

Russia has 8 Federal Districts:
  ЦФО  — Центральный
  СЗФО — Северо-Западный
  ПФО  — Приволжский
  ЮФО  — Южный
  СКФО — Северо-Кавказский
  УФО  — Уральский
  СФО  — Сибирский
  ДФО  — Дальневосточный
"""

_WB_WAREHOUSE_TO_DISTRICT = {
    "Коледино": "ЦФО",
    "Подольск": "ЦФО",
    "Электросталь": "ЦФО",
    "Белая Дача": "ЦФО",
    "Пушкино": "ЦФО",
    "Обухово": "ЦФО",
    "Тула": "ЦФО",
    "Радумля": "ЦФО",
    "Рязань": "ЦФО",
    "Чехов": "ЦФО",
    "Санкт-Петербург": "СЗФО",
    "СПБ": "СЗФО",
    "Шушары": "СЗФО",
    "Казань": "ПФО",
    "Самара": "ПФО",
    "Нижний Новгород": "ПФО",
    "Пермь": "ПФО",
    "Уфа": "ПФО",
    "Краснодар": "ЮФО",
    "Ростов": "ЮФО",
    "Волгоград": "ЮФО",
    "Невинномысск": "СКФО",
    "Екатеринбург": "УФО",
    "Тюмень": "УФО",
    "Новосибирск": "СФО",
    "Красноярск": "СФО",
    "Омск": "СФО",
    "Иркутск": "СФО",
    "Хабаровск": "ДФО",
    "Владивосток": "ДФО",
}

_OZON_WAREHOUSE_TO_DISTRICT = {
    "ХОРУГВИНО": "ЦФО",
    "ПУШКИНО": "ЦФО",
    "ВОРОНЕЖ": "ЦФО",
    "ГРИВНО": "ЦФО",
    "ТВЕРЬ": "ЦФО",
    "НИЖ_НОВГОРОД": "ПФО",
    "САМАРА": "ПФО",
    "КАЗАНЬ": "ПФО",
    "САНКТ_ПЕТЕРБУРГ": "СЗФО",
    "СПБ": "СЗФО",
    "ЕКАТЕРИНБУРГ": "УФО",
    "ЧЕЛЯБИНСК": "УФО",
    "НОВОСИБИРСК": "СФО",
    "КРАСНОДАР": "ЮФО",
    "РОСТОВ": "ЮФО",
    "ХАБАРОВСК": "ДФО",
}


def wb_warehouse_district(warehouse_name: str | None) -> str | None:
    if not warehouse_name:
        return None
    for prefix, district in _WB_WAREHOUSE_TO_DISTRICT.items():
        if warehouse_name.lower().startswith(prefix.lower()):
            return district
    return None


def ozon_warehouse_district(warehouse_name: str | None) -> str | None:
    if not warehouse_name:
        return None
    upper = warehouse_name.upper()
    for prefix, district in _OZON_WAREHOUSE_TO_DISTRICT.items():
        if prefix in upper:
            return district
    return None


def normalize_district(raw: str | None) -> str | None:
    """Normalize WB/Ozon-returned Federal District names to canonical ФО codes."""
    if not raw:
        return None
    r = raw.lower()
    if "централь" in r:
        return "ЦФО"
    if "северо-запад" in r:
        return "СЗФО"
    if "приволж" in r:
        return "ПФО"
    if "южн" in r:
        return "ЮФО"
    if "северо-кавказ" in r:
        return "СКФО"
    if "урал" in r:
        return "УФО"
    if "сибир" in r:
        return "СФО"
    if "дальневосточ" in r:
        return "ДФО"
    return None
