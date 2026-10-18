// Модель данных помощника «Тук».
// Все записи — один тип Item, различаются полем kind.

export type Kind = 'task' | 'reminder' | 'health' | 'note';

export type Repeat = 'hourly' | 'daily' | 'weekdays' | 'weekly';

export type Metric =
  | 'pressure' // давление: value = верхнее, value2 = нижнее
  | 'pulse'
  | 'temp'
  | 'weight'
  | 'sleep' // часы
  | 'water' // мл
  | 'steps'
  | 'mood' // 1..5
  | 'meds'; // приём лекарств (value = 1)

export interface Health {
  metric: Metric;
  value: number;
  value2?: number;
  unit: string;
}

export interface Item {
  id: string;
  kind: Kind;
  text: string;
  createdAt: number; // мс
  updatedAt: number; // мс — для слияния «последняя правка побеждает»
  origin: string; // устройство, сделавшее последнюю правку
  deleted?: boolean;
  done?: boolean;
  doneAt?: number | null;
  dueAt?: number | null; // срок задачи или время напоминания
  allDay?: boolean; // у задачи есть день, но нет времени
  repeat?: Repeat | null;
  health?: Health;
  tag?: string; // например «здоровье» у напоминаний о таблетках
}

export const METRIC_LABEL: Record<Metric, string> = {
  pressure: 'Давление',
  pulse: 'Пульс',
  temp: 'Температура',
  weight: 'Вес',
  sleep: 'Сон',
  water: 'Вода',
  steps: 'Шаги',
  mood: 'Самочувствие',
  meds: 'Лекарства',
};

export function newId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Чем новее правка, тем она важнее; при равенстве — по id устройства, чтобы все устройства решили одинаково. */
export function isNewer(a: Item, b: Item): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return a.origin > b.origin;
}

export function healthText(h: Health): string {
  switch (h.metric) {
    case 'pressure':
      return `${h.value}/${h.value2 ?? '?'} мм рт. ст.`;
    case 'pulse':
      return `${h.value} уд/мин`;
    case 'temp':
      return `${h.value.toString().replace('.', ',')} °C`;
    case 'weight':
      return `${h.value.toString().replace('.', ',')} кг`;
    case 'sleep':
      return `${h.value.toString().replace('.', ',')} ч`;
    case 'water':
      return `${h.value} мл`;
    case 'steps':
      return `${h.value} шагов`;
    case 'mood':
      return ['', 'очень плохо', 'плохо', 'нормально', 'хорошо', 'отлично'][h.value] ?? String(h.value);
    case 'meds':
      return 'принято';
  }
}
