function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS = {
  january: 1,
  jan: 1,
  janvier: 1,
  february: 2,
  feb: 2,
  fevrier: 2,
  march: 3,
  mar: 3,
  mars: 3,
  april: 4,
  apr: 4,
  avril: 4,
  may: 5,
  mai: 5,
  june: 6,
  jun: 6,
  juin: 6,
  july: 7,
  jul: 7,
  juillet: 7,
  august: 8,
  aug: 8,
  aout: 8,
  september: 9,
  sep: 9,
  sept: 9,
  septembre: 9,
  october: 10,
  oct: 10,
  octobre: 10,
  november: 11,
  nov: 11,
  novembre: 11,
  december: 12,
  dec: 12,
  decembre: 12
};

const WEEKDAYS = {
  sunday: 0,
  dimanche: 0,
  monday: 1,
  lundi: 1,
  tuesday: 2,
  mardi: 2,
  wednesday: 3,
  mercredi: 3,
  thursday: 4,
  jeudi: 4,
  friday: 5,
  vendredi: 5,
  saturday: 6,
  samedi: 6
};

function cloneDate(date) {
  return new Date(date.getTime());
}

function parseClockHint(text) {
  const normalized = normalizeText(text);

  const colonClock = normalized.match(/\b(?:at|a|vers)?\s*(\d{1,2}):(\d{2})\s*(am|pm)?\b/);
  if (colonClock) {
    let hour = Number(colonClock[1]);
    const minute = Number(colonClock[2]);
    const meridiem = colonClock[3];
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  const hourClock = normalized.match(/\b(?:at|a|vers)?\s*(\d{1,2})h(\d{2})?\b/);
  if (hourClock) {
    const hour = Number(hourClock[1]);
    const minute = Number(hourClock[2] || "0");
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  if (/\b(this morning|ce matin)\b/.test(normalized)) {
    return { hour: 9, minute: 0 };
  }
  if (/\b(this afternoon|cet apres midi|cette apres midi)\b/.test(normalized)) {
    return { hour: 15, minute: 0 };
  }
  if (/\b(this evening|ce soir)\b/.test(normalized)) {
    return { hour: 20, minute: 0 };
  }
  if (/\b(tonight|cette nuit)\b/.test(normalized)) {
    return { hour: 22, minute: 0 };
  }

  return null;
}

function buildCandidate(publishedAt, year, month, day, clockHint) {
  const date = cloneDate(publishedAt);
  date.setSeconds(0, 0);
  date.setFullYear(year);
  date.setMonth(month - 1);
  date.setDate(day);

  if (clockHint) {
    date.setHours(clockHint.hour, clockHint.minute, 0, 0);
  } else {
    date.setHours(12, 0, 0, 0);
  }

  return date;
}

function parseRelativeTime(normalizedText, publishedAt) {
  let match =
    normalizedText.match(/\b(\d{1,3})\s*(minutes?|mins?|min|heures?|hours?|hrs?|hr|h)\s+ago\b/) ||
    normalizedText.match(/\bil y a\s+(\d{1,3})\s*(minutes?|mins?|min|heures?|hours?|hrs?|hr|h)\b/);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const unit = match[2];
  const minutes = /\b(h|hr|hrs|hour|hours|heure|heures)\b/.test(unit) ? value * 60 : value;
  const candidate = new Date(publishedAt.getTime() - minutes * 60 * 1000);
  return { occurredAt: candidate, source: "relative" };
}

function parseDayReference(normalizedText, publishedAt, originalText) {
  const clockHint = parseClockHint(originalText || normalizedText);

  if (/\b(today|aujourd hui)\b/.test(normalizedText)) {
    const candidate = cloneDate(publishedAt);
    if (clockHint) {
      candidate.setHours(clockHint.hour, clockHint.minute, 0, 0);
    }
    return { occurredAt: candidate, source: "day-reference" };
  }

  if (/\b(yesterday|hier)\b/.test(normalizedText)) {
    const candidate = cloneDate(publishedAt);
    candidate.setDate(candidate.getDate() - 1);
    if (clockHint) {
      candidate.setHours(clockHint.hour, clockHint.minute, 0, 0);
    } else {
      candidate.setHours(12, 0, 0, 0);
    }
    return { occurredAt: candidate, source: "day-reference" };
  }

  const dayMatch = normalizedText.match(
    /\b(sunday|dimanche|monday|lundi|tuesday|mardi|wednesday|mercredi|thursday|jeudi|friday|vendredi|saturday|samedi)\b/
  );
  if (!dayMatch) {
    return null;
  }

  const targetDay = WEEKDAYS[dayMatch[1]];
  if (!Number.isInteger(targetDay)) {
    return null;
  }

  const candidate = cloneDate(publishedAt);
  const currentDay = candidate.getDay();
  const delta = (currentDay - targetDay + 7) % 7;
  candidate.setDate(candidate.getDate() - delta);

  if (clockHint) {
    candidate.setHours(clockHint.hour, clockHint.minute, 0, 0);
  } else {
    candidate.setHours(12, 0, 0, 0);
  }

  return { occurredAt: candidate, source: "weekday" };
}

function parseExplicitDate(normalizedText, publishedAt, originalText) {
  const clockHint = parseClockHint(originalText || normalizedText);

  const isoMatch = normalizedText.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return { occurredAt: buildCandidate(publishedAt, year, month, day, clockHint), source: "explicit-date" };
  }

  const euroMatch = normalizedText.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (euroMatch) {
    const day = Number(euroMatch[1]);
    const month = Number(euroMatch[2]);
    const year = Number(euroMatch[3]);
    return { occurredAt: buildCandidate(publishedAt, year, month, day, clockHint), source: "explicit-date" };
  }

  const monthNameMatch = normalizedText.match(
    /\b(january|jan|janvier|february|feb|fevrier|march|mar|mars|april|apr|avril|may|mai|june|jun|juin|july|jul|juillet|august|aug|aout|september|sep|sept|septembre|october|oct|octobre|november|nov|novembre|december|dec|decembre)\s+(\d{1,2})(?:,?\s*(20\d{2}))?\b/
  );
  if (monthNameMatch) {
    const month = MONTHS[monthNameMatch[1]];
    const day = Number(monthNameMatch[2]);
    const year = Number(monthNameMatch[3] || publishedAt.getFullYear());
    return { occurredAt: buildCandidate(publishedAt, year, month, day, clockHint), source: "explicit-date" };
  }

  return null;
}

function isValidCandidate(candidate, publishedAt) {
  if (!(candidate instanceof Date) || Number.isNaN(candidate.getTime())) {
    return false;
  }

  const tooFarInFuture = candidate.getTime() > publishedAt.getTime() + 3 * 60 * 60 * 1000;
  if (tooFarInFuture) {
    return false;
  }

  const tooOld = publishedAt.getTime() - candidate.getTime() > 14 * 24 * 60 * 60 * 1000;
  if (tooOld) {
    return false;
  }

  return true;
}

function inferOccurredAt(articleText, publishedAtRaw) {
  const publishedAt = new Date(publishedAtRaw || new Date());
  if (Number.isNaN(publishedAt.getTime())) {
    return { occurredAt: null, occurredAtSource: "unknown" };
  }

  const normalizedText = normalizeText(articleText);
  if (!normalizedText) {
    return { occurredAt: null, occurredAtSource: "unknown" };
  }

  const parsers = [
    () => parseRelativeTime(normalizedText, publishedAt),
    () => parseExplicitDate(normalizedText, publishedAt, articleText),
    () => parseDayReference(normalizedText, publishedAt, articleText)
  ];

  for (const parse of parsers) {
    const result = parse();
    if (!result || !isValidCandidate(result.occurredAt, publishedAt)) {
      continue;
    }
    return { occurredAt: result.occurredAt, occurredAtSource: result.source };
  }

  return { occurredAt: null, occurredAtSource: "unknown" };
}

module.exports = {
  inferOccurredAt
};
