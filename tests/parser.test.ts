import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, nextOccurrence } from '../src/parser.ts';

// Воскресенье, 18 октября 2026, 14:00
const NOW = new Date(2026, 9, 18, 14, 0);
const at = (d: number, h: number, m = 0, mon = 9, y = 2026) => new Date(y, mon, d, h, m).getTime();

function rem(s: string) {
  const p = parse(s, NOW);
  assert.equal(p.type, 'reminder', `${s} → ${JSON.stringify(p)}`);
  return p as Extract<typeof p, { type: 'reminder' }>;
}

test('напоминания с днём и временем', () => {
  let r = rem('Напомни завтра в 9 позвонить поставщику');
  assert.equal(r.dueAt, at(19, 9));
  assert.equal(r.text, 'Позвонить поставщику');

  r = rem('напомни мне послезавтра в 18:30 что нужно забрать посылку');
  assert.equal(r.dueAt, at(20, 18, 30));
  assert.equal(r.text, 'Забрать посылку');

  r = rem('напомни в пятницу в 10 утра сдать отчёт');
  assert.equal(r.dueAt, at(23, 10));
  assert.equal(r.text, 'Сдать отчёт');

  r = rem('напомни 25 октября в 7 вечера про день рождения Саши');
  assert.equal(r.dueAt, at(25, 19));
  assert.equal(r.text, 'День рождения Саши');

  r = rem('напомни 05.11 в 9:15 оплатить интернет');
  assert.equal(r.dueAt, at(5, 9, 15, 10));
});

test('относительное время', () => {
  let r = rem('напомни через 10 минут выключить чайник');
  assert.equal(r.dueAt, NOW.getTime() + 10 * 60_000);
  assert.equal(r.text, 'Выключить чайник');
  r = rem('напомни через полчаса проверить почту');
  assert.equal(r.dueAt, NOW.getTime() + 30 * 60_000);
  r = rem('напомни через два часа позвонить маме');
  assert.equal(r.dueAt, NOW.getTime() + 2 * 3_600_000);
  r = rem('напомни через час');
  assert.equal(r.text, 'Напоминание');
  r = rem('через 3 дня в 10 забрать машину из сервиса');
  assert.equal(r.dueAt, at(21, 10));
});

test('только время: сегодня или ближайшее', () => {
  // 14:00: «в 6» → 18:00 сегодня
  assert.equal(rem('напомни в 6 полить цветы').dueAt, at(18, 18));
  // «в 9 утра» уже прошло → завтра
  assert.equal(rem('напомни в 9 утра зарядка').dueAt, at(19, 9));
  assert.equal(rem('в 16:45 созвон с бригадой').dueAt, at(18, 16, 45));
  assert.equal(rem('напомни вечером вынести мусор').dueAt, at(18, 19));
  assert.equal(rem('напомни в полдень обед').dueAt, at(19, 12));
});

test('повторы', () => {
  let r = rem('каждый день в 9 выпить таблетки');
  assert.equal(r.repeat, 'daily');
  assert.equal(r.dueAt, at(19, 9));
  assert.equal(r.tag, 'здоровье');
  r = rem('напоминай по будням в 8:30 планерка'.replace('напоминай', 'напомни'));
  assert.equal(r.repeat, 'weekdays');
  assert.equal(r.dueAt, at(19, 8, 30)); // понедельник
  r = rem('напомни каждую пятницу в 17 отправить табель');
  assert.equal(r.repeat, 'weekly');
  assert.equal(r.dueAt, at(23, 17));
  r = rem('напомни каждый час пить воду');
  assert.equal(r.repeat, 'hourly');
  assert.equal(r.dueAt, at(18, 15));
});

test('повтор: следующее срабатывание', () => {
  const fri = at(23, 17);
  assert.equal(nextOccurrence(fri, 'weekly', fri), at(30, 17));
  assert.equal(nextOccurrence(fri, 'weekdays', fri), at(26, 17)); // пт → пн
  assert.equal(nextOccurrence(fri, 'daily', fri), at(24, 17));
  assert.equal(nextOccurrence(fri, 'hourly', fri), at(23, 18));
});

test('задачи', () => {
  let p = parse('запиши купить кабель ВВГ 3х2,5', NOW);
  assert.equal(p.type, 'task');
  assert.equal((p as any).text, 'Купить кабель ВВГ 3х2,5');
  p = parse('в пятницу сдать отчёт', NOW);
  assert.equal(p.type, 'task');
  assert.equal((p as any).dueAt, new Date(2026, 9, 23).getTime());
  assert.equal((p as any).allDay, true);
  p = parse('завтра купить хлеб', NOW);
  assert.equal(p.type, 'task');
  assert.equal((p as any).dueAt, new Date(2026, 9, 19).getTime());
  p = parse('напомни купить хлеб', NOW);
  assert.equal(p.type, 'task');
  assert.equal((p as any).reason, 'no-time');
  p = parse('купить 5 метров гофры', NOW);
  assert.equal(p.type, 'task');
  assert.equal((p as any).explicit, false);
  assert.equal((parse('запиши купить хлеб', NOW) as any).explicit, true);
  assert.equal((parse('как дела', NOW) as any).explicit, false);
});

test('здоровье', () => {
  let p = parse('давление 130 на 85 пульс 72', NOW) as any;
  assert.equal(p.type, 'health');
  assert.deepEqual(p.records.map((r: any) => [r.metric, r.value, r.value2]), [['pressure', 130, 85], ['pulse', 72, undefined]]);
  p = parse('125/80', NOW) as any;
  assert.equal(p.records[0].metric, 'pressure');
  p = parse('спал 7,5 часов', NOW) as any;
  assert.equal(p.records[0].value, 7.5);
  p = parse('выпил 300 мл воды', NOW) as any;
  assert.equal(p.records[0].value, 300);
  p = parse('вода 2 стакана', NOW) as any;
  assert.equal(p.records[0].value, 500);
  p = parse('выпил стакан воды', NOW) as any;
  assert.equal(p.records[0].value, 250);
  p = parse('самочувствие хорошо', NOW) as any;
  assert.equal(p.records[0].value, 4);
  p = parse('вес 82,4', NOW) as any;
  assert.equal(p.records[0].value, 82.4);
  p = parse('температура 37.2', NOW) as any;
  assert.equal(p.records[0].value, 37.2);
  p = parse('принял таблетки', NOW) as any;
  assert.equal(p.records[0].metric, 'meds');
  p = parse('прошел 8500 шагов', NOW) as any;
  assert.equal(p.records[0].value, 8500);
  // «напомни выпить таблетки» — это напоминание, а не запись здоровья
  assert.equal(parse('напомни в 21 выпить таблетки', NOW).type, 'reminder');
});

test('прочие команды', () => {
  assert.equal(parse('готово позвонить поставщику', NOW).type, 'done');
  assert.equal((parse('сделал отчет', NOW) as any).query, 'отчет');
  assert.equal(parse('удали хлеб', NOW).type, 'delete');
  assert.equal(parse('заметка: размер щита 600×800', NOW).type, 'note');
  assert.equal((parse('заметка: размер щита 600×800', NOW) as any).text, 'Размер щита 600×800');
  assert.equal((parse('что на сегодня', NOW) as any).what, 'today');
  assert.equal(parse('привет', NOW).type, 'greet');
  assert.equal(parse('   ', NOW).type, 'empty');
});
