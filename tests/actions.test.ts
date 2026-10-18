import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchApp, pcTarget, matchContacts, parseAction, parseClock, parseDuration, wordsToDigits, type Contact } from '../src/actions.ts';

const NOW = new Date(2026, 9, 19, 0, 30);
const a = (s: string) => parseAction(s, NOW);

test('числа словами', () => {
  assert.equal(wordsToDigits('поставь будильник на семь тридцать'), 'поставь будильник на 7 30');
  assert.equal(wordsToDigits('таймер на двадцать пять минут'), 'таймер на 25 минут');
  assert.equal(wordsToDigits('через сто двадцать секунд'), 'через 120 секунд');
});

test('время будильника', () => {
  const t = (s: string) => JSON.stringify(parseClock(s));
  assert.equal(t('на 7 утра'), '{"hour":7,"minute":0}');
  assert.equal(t('на семь утра'), '{"hour":7,"minute":0}');
  assert.equal(t('в 6:30'), '{"hour":6,"minute":30}');
  assert.equal(t('на шесть тридцать'), '{"hour":6,"minute":30}');
  assert.equal(t('на половину восьмого'), '{"hour":7,"minute":30}');
  assert.equal(t('в пол восьмого'), '{"hour":7,"minute":30}');
  assert.equal(t('без пятнадцати восемь'), '{"hour":7,"minute":45}');
  assert.equal(t('без четверти девять'), '{"hour":8,"minute":45}');
  assert.equal(t('на 7 вечера'), '{"hour":19,"minute":0}');
  assert.equal(t('в час дня'), '{"hour":13,"minute":0}');
  assert.equal(t('в 19:45'), '{"hour":19,"minute":45}');
  assert.equal(t('в полдень'), '{"hour":12,"minute":0}');
});

test('длительность', () => {
  assert.equal(parseDuration('на 5 минут'), 300);
  assert.equal(parseDuration('на полчаса'), 1800);
  assert.equal(parseDuration('на полтора часа'), 5400);
  assert.equal(parseDuration('на один час двадцать минут'), 4800);
  assert.equal(parseDuration('на тридцать секунд'), 30);
  assert.equal(parseDuration('на минуту'), 60);
});

test('будильник и таймер', () => {
  assert.deepEqual(a('Поставь будильник на семь утра'), { kind: 'alarm', hour: 7, minute: 0, days: undefined, label: undefined });
  assert.deepEqual(a('Тук тук, разбуди меня в половину седьмого'), { kind: 'alarm', hour: 6, minute: 30, days: undefined, label: undefined });
  assert.deepEqual(a('будильник по будням на 6:45'), { kind: 'alarm', hour: 6, minute: 45, days: [2, 3, 4, 5, 6], label: undefined });
  assert.deepEqual(a('поставь будильник через 8 часов'), { kind: 'alarm', hour: 8, minute: 30 });
  assert.deepEqual(a('поставь таймер на пять минут'), { kind: 'timer', seconds: 300 });
  assert.deepEqual(a('засеки полчаса'), { kind: 'timer', seconds: 1800 });
  assert.equal(a('выключи будильник'), null);
});

test('звонки и сообщения', () => {
  assert.deepEqual(a('Позвони маме'), { kind: 'call', who: 'маме' });
  assert.deepEqual(a('набери Сашу Иванова'), { kind: 'call', who: 'Сашу Иванова' });
  assert.deepEqual(a('позвони на номер 8 900 123 45 67'), { kind: 'call', number: '89001234567' });
  assert.deepEqual(a('Напиши маме что я задержусь на час'), { kind: 'sms', who: 'маме', text: 'Я задержусь на час' });
  assert.deepEqual(a('отправь сообщение Диме привет как дела'), { kind: 'sms', who: 'Диме', text: 'Привет как дела' });
});

test('приложения, устройство, поиск', () => {
  assert.deepEqual(a('открой телеграм'), { kind: 'open', app: 'телеграм' });
  assert.deepEqual(a('запусти ютуб'), { kind: 'open', app: 'ютуб' });
  assert.deepEqual(a('включи фонарик'), { kind: 'torch', on: true });
  assert.deepEqual(a('выключи фонарь'), { kind: 'torch', on: false });
  assert.deepEqual(a('сделай погромче'), { kind: 'volume', dir: 'up' });
  assert.deepEqual(a('тише'), { kind: 'volume', dir: 'down' });
  assert.deepEqual(a('следующий трек'), { kind: 'media', key: 'next' });
  assert.deepEqual(a('пауза'), { kind: 'media', key: 'pause' });
  assert.deepEqual(a('включи музыку'), { kind: 'media', key: 'play' });
  assert.deepEqual(a('проложи маршрут до Красной площади'), { kind: 'navigate', place: 'Красной площади' });
  assert.deepEqual(a('найди в интернете рецепт борща'), { kind: 'search', query: 'рецепт борща' });
  assert.deepEqual(a('сколько заряда'), { kind: 'battery' });
  assert.deepEqual(a('который час'), { kind: 'time' });
  assert.deepEqual(a('открой камеру'), { kind: 'camera' });
  const cal = a('добавь в календарь встречу с поставщиком завтра в 15');
  assert.equal(cal?.kind, 'calendar');
  if (cal?.kind === 'calendar') {
    assert.equal(cal.title, 'с поставщиком');
    assert.equal(new Date(cal.at).getDate(), 20);
    assert.equal(new Date(cal.at).getHours(), 15);
  }
});

test('не путает с заметками и напоминаниями', () => {
  assert.equal(a('напомни завтра в 9 позвонить маме'), null);
  assert.equal(a('запиши купить кабель'), null);
  assert.equal(a('как дела?'), null);
  assert.equal(a('давление 125 на 80'), null);
});

test('поиск контактов', () => {
  const book: Contact[] = [
    { name: 'Мама', phones: ['+79001'] },
    { name: 'Папа', phones: ['+79002'] },
    { name: 'Александр Иванов', phones: ['+79003'] },
    { name: 'Саша Петрова', phones: ['+79004'] },
    { name: 'Дмитрий Сергеевич', phones: ['+79005'] },
    { name: 'Ольга работа', phones: ['+79006'] },
  ];
  const top = (q: string) => matchContacts(q, book).map((m) => m.contact.name);
  assert.equal(top('маме')[0], 'Мама');
  assert.equal(top('мамочке')[0], 'Мама');
  assert.equal(top('папе')[0], 'Папа');
  assert.equal(top('Диме')[0], 'Дмитрий Сергеевич');
  assert.equal(top('Ольге')[0], 'Ольга работа');
  assert.equal(top('Саше Иванову')[0], 'Александр Иванов');
  assert.deepEqual(top('Саше').sort(), ['Александр Иванов', 'Саша Петрова']);
  assert.deepEqual(top('Васе'), []);
});

test('приложения по названию', () => {
  const apps = [
    { label: 'Telegram', pkg: 'org.telegram.messenger' }, { label: 'YouTube', pkg: 'com.google.android.youtube' },
    { label: 'Камера', pkg: 'com.sec.android.app.camera' }, { label: 'Калькулятор', pkg: 'com.sec.android.app.popupcalculator' },
    { label: 'Яндекс Музыка', pkg: 'ru.yandex.music' }, { label: 'Сбербанк', pkg: 'ru.sberbankmobile' }, { label: 'Госуслуги', pkg: 'ru.rostel' },
  ];
  assert.equal(matchApp('телеграм', apps)?.pkg, 'org.telegram.messenger');
  assert.equal(matchApp('ютуб', apps)?.pkg, 'com.google.android.youtube');
  assert.equal(matchApp('калькулятор', apps)?.pkg, 'com.sec.android.app.popupcalculator');
  assert.equal(matchApp('музыку', apps)?.pkg, 'ru.yandex.music');
  assert.equal(matchApp('сбер', apps)?.pkg, 'ru.sberbankmobile');
  assert.equal(matchApp('госуслуги', apps)?.pkg, 'ru.rostel');
  assert.equal(matchApp('фотошоп', apps), null);
  assert.equal(pcTarget('блокнот'), 'notepad');
  assert.equal(pcTarget('ютуб'), 'https://www.youtube.com');
  assert.equal(pcTarget('сайт habr.com'), 'https://habr.com');
  assert.equal(pcTarget('диспетчер задач'), 'taskmgr');
  assert.equal(pcTarget('фотошоп'), null);
});
