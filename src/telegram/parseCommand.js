export function normalizePhone(value) {
  const cleaned = String(value).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('010')) return `+82${cleaned.slice(1)}`;
  if (cleaned.startsWith('82')) return `+${cleaned}`;
  return cleaned;
}

function parseKeyValueLines(text) {
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/')) continue;
    const match = trimmed.match(/^([^:=]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;
    entries[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return entries;
}

export function parseCallCommand(text) {
  const entries = parseKeyValueLines(text);
  const to = entries.to ?? entries.phone ?? entries.number ?? entries['전화번호'] ?? entries['번호'];
  const title = entries.title ?? entries.name ?? entries['제목'] ?? 'telegram-call';
  const meetingId = entries.meeting ?? entries.meetingid ?? entries['회의번호'] ?? entries['미팅번호'];
  const password = entries.password ?? entries.passcode ?? entries.pin ?? entries['비밀번호'] ?? entries['암호'];
  let digits = entries.digits ?? entries.dtmf ?? entries['누를번호'];

  if (!digits && meetingId) {
    digits = `ww${meetingId.replace(/\s+/g, '')}#`;
    if (password) {
      digits += `ww${password.replace(/\s+/g, '')}#`;
    }
  }

  if (!to) {
    throw new Error('전화번호가 필요합니다. 예: to=+18005551234');
  }

  return {
    to: normalizePhone(to),
    title,
    note: entries.note ?? entries.memo ?? entries['메모'] ?? '',
    silenceTimeout: entries.silencetimeout ? Number(entries.silencetimeout) : 120,
    digits: digits ?? ''
  };
}

export function callCommandHelp() {
  return [
    '사용법:',
    '/call',
    'to=+18005551234',
    'meeting=123456789',
    'password=987654',
    'title=251212_FY4Q25 Broadcom',
    '',
    '이미 DTMF 전체를 알고 있으면:',
    '/call',
    'to=+18005551234',
    'digits=ww123456789#ww987654#',
    'title=board-call',
    '',
    'w는 짧은 대기, #은 우물정자 입력입니다.'
  ].join('\n');
}
