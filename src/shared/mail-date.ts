const months = [
  ["jan", "january", "janv", "janvier"], ["feb", "february", "fevr", "fevrier"],
  ["mar", "march", "mars"], ["apr", "april", "avr", "avril"], ["may", "mai"],
  ["jun", "june", "juin"], ["jul", "july", "juil", "juillet"], ["aug", "august", "aout"],
  ["sep", "sept", "september", "septembre"], ["oct", "october", "octobre"],
  ["nov", "november", "novembre"], ["dec", "december", "decembre"],
];

/** Parse absolute Gmail header/tooltips, never relative labels or ambiguous numeric dates. */
export function mailboxDate(dateText: string): string | undefined {
  const text = dateText.normalize("NFD").replace(/[\u0300-\u036f\u200e\u200f]/g, "")
    .replace(/[\s\u202f]+/g, " ").trim().toLowerCase();
  const date = text.replace(/^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|lun(?:di)?|mar(?:di)?|mer(?:credi)?|jeu(?:di)?|ven(?:dredi)?|sam(?:edi)?|dim(?:anche)?)\.?,? (?=[a-z]+\.? \d|\d{1,2} [a-z])/, "");
  const match = date.match(/^(?:([a-z]+)\.? (\d{1,2})|(\d{1,2}) ([a-z]+)\.?),? (\d{4}),? (?:at |a )?(\d{1,2}):(\d{2})(?::(\d{2}))? ?(am|pm)?(?: (?:gmt|utc)([+-]\d{2}:?\d{2})?)?$/);
  if (!match) return undefined;
  const month = months.findIndex(names => names.includes(match[1] || match[4]));
  const day = Number(match[2] || match[3]), year = Number(match[5]);
  let hour = Number(match[6]);
  const minute = Number(match[7]), second = Number(match[8] || 0);
  if (month < 0 || year < 1900 || minute > 59 || second > 59 || hour > 23
    || (match[9] && (hour < 1 || hour > 12))) return undefined;
  if (match[9]) hour = hour % 12 + (match[9] === "pm" ? 12 : 0);
  const calendar = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (calendar.getUTCMonth() !== month || calendar.getUTCDate() !== day) return undefined;
  const zoned = / (?:gmt|utc)/.test(date);
  if (zoned) {
    const offset = match[10]?.replace(":", "");
    const hours = Number(offset?.slice(1, 3) || 0), minutes = Number(offset?.slice(3) || 0);
    if (hours > 23 || minutes > 59) return undefined;
    return new Date(calendar.getTime() - (offset?.[0] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000).toISOString();
  }
  // Gmail's unzoned tooltip uses the local browser clock on this desktop.
  return new Date(year, month, day, hour, minute, second).toISOString();
}
